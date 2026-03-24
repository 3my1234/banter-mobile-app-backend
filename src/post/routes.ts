import { Router, Request, Response } from 'express';
import { prisma } from '../index';
import { logger } from '../utils/logger';
import { AppError } from '../utils/errorHandler';
import { addPostExpirationJob } from '../queue/postQueue';
import { jwtAuthMiddleware } from '../auth/jwtMiddleware';
import { hardDeletePost } from './service';

const router = Router();

type NormalizedMediaItem = {
  url: string;
  type: 'image' | 'video';
};

function normalizeMediaTypeValue(value?: string | null): 'image' | 'video' | null {
  if (!value) return null;
  const lower = value.trim().toLowerCase();
  if (lower === 'image' || lower === 'video') {
    return lower;
  }
  return null;
}

function normalizeMediaItems(
  mediaItemsInput: unknown,
  fallbackMediaUrl?: string | null,
  fallbackMediaType?: string | null
): NormalizedMediaItem[] {
  const normalized: NormalizedMediaItem[] = [];

  if (Array.isArray(mediaItemsInput)) {
    for (const rawItem of mediaItemsInput) {
      if (!rawItem || typeof rawItem !== 'object') continue;
      const nextUrl =
        typeof (rawItem as any).url === 'string'
          ? (rawItem as any).url.trim()
          : '';
      const nextType = normalizeMediaTypeValue((rawItem as any).type);
      if (!nextUrl || !nextType) continue;
      normalized.push({ url: nextUrl, type: nextType });
    }
  }

  if (!normalized.length && fallbackMediaUrl) {
    const nextType = normalizeMediaTypeValue(fallbackMediaType) || normalizeMediaTypeValue(
      /\.(mp4|mov|m4v|webm|m3u8)(\?|$)/i.test(fallbackMediaUrl) ? 'video' : 'image'
    );
    if (nextType) {
      normalized.push({
        url: fallbackMediaUrl.trim(),
        type: nextType,
      });
    }
  }

  return normalized;
}

function getSerializableMediaItems(
  mediaItemsInput: unknown,
  fallbackMediaUrl?: string | null,
  fallbackMediaType?: string | null
): NormalizedMediaItem[] {
  return normalizeMediaItems(mediaItemsInput, fallbackMediaUrl, fallbackMediaType);
}

/**
 * POST /api/posts
 * Create a new post
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      throw new AppError('User not authenticated', 401);
    }

    const { content, mediaUrl, mediaType, mediaItems, isRoast, tags, league } = req.body;

    if (!content || content.trim().length === 0) {
      throw new AppError('Post content is required', 400);
    }

    const normalizedMediaItems = normalizeMediaItems(mediaItems, mediaUrl, mediaType);
    if (normalizedMediaItems.length > 6) {
      throw new AppError('You can upload up to 6 images per post', 400);
    }
    if (normalizedMediaItems.length > 1) {
      if (isRoast === true) {
        throw new AppError('Roast posts currently support only one media item', 400);
      }
      if (normalizedMediaItems.some((item) => item.type !== 'image')) {
        throw new AppError('Multiple media uploads currently support images only', 400);
      }
    }

    const primaryMedia = normalizedMediaItems[0] || null;
    if (mediaUrl && mediaType && !normalizeMediaTypeValue(mediaType)) {
      throw new AppError('mediaType must be "image" or "video"', 400);
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new AppError('User not found', 404);
    }

    // Expiration:
    // - Roasts expire in 24 hours
    // - Normal posts never expire (set far-future timestamp)
    const expiresAt = new Date();
    if (isRoast === true) {
      expiresAt.setHours(expiresAt.getHours() + 24);
    } else {
      expiresAt.setFullYear(expiresAt.getFullYear() + 100);
    }

    // Process tags - create or link tags
    const tagArray = Array.isArray(tags) ? tags : [];
    const tagIds: string[] = [];

    if (tagArray.length > 0) {
      for (const tagName of tagArray) {
        if (typeof tagName === 'string' && tagName.trim()) {
          const normalizedTag = tagName.trim().toLowerCase();
          let tag = await prisma.tag.findUnique({
            where: { name: normalizedTag },
          });

          if (!tag) {
            tag = await prisma.tag.create({
              data: {
                name: normalizedTag,
                displayName: tagName.trim(),
                type: 'HASHTAG',
                league: league || null,
              },
            });
          }
          tagIds.push(tag.id);
        }
      }
    }

    const post = await prisma.post.create({
      data: {
        userId: user.id,
        content: content.trim(),
        mediaUrl: primaryMedia?.url || null,
        mediaType: primaryMedia?.type || null,
        mediaItems: normalizedMediaItems.length ? (normalizedMediaItems as any) : null,
        isRoast: isRoast === true,
        tags: tagArray,
        league: league || null,
        expiresAt,
        status: 'ACTIVE',
        postTags: {
          create: tagIds.map(tagId => ({
            tagId,
          })),
        },
      },
      include: {
        user: {
          select: {
            id: true,
            displayName: true,
            username: true,
            avatarUrl: true,
          },
        },
        votes: true,
        postTags: {
          include: {
            tag: true,
          },
        },
      },
    });

    // Schedule expiration job only for roasts
    if (post.isRoast) {
      await addPostExpirationJob(post.id, expiresAt);
    }

    logger.info(`Created post ${post.id} by user ${user.id}`);

    res.status(201).json({
      success: true,
      post: {
        id: post.id,
        content: post.content,
        mediaUrl: post.mediaUrl,
        mediaType: post.mediaType,
        mediaItems: getSerializableMediaItems(post.mediaItems, post.mediaUrl, post.mediaType),
        isRoast: post.isRoast,
        tags: post.tags,
        league: post.league,
        stayVotes: post.stayVotes,
        dropVotes: post.dropVotes,
        shareCount: post.shareCount,
        repostCount: post.repostCount,
        status: post.status,
        expiresAt: post.expiresAt,
        createdAt: post.createdAt,
        ownedByViewer: true,
        user: post.user,
      },
    });
  } catch (error) {
    logger.error('Create post error', { error });
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Failed to create post', 500);
  }
});

/**
 * GET /api/posts
 * Get posts with feed filtering (forYou, following, hot)
 * Query params: feed=forYou|following|hot, page, limit
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    const feed = (req.query.feed as string) || 'forYou';
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const skip = (page - 1) * limit;

    // Build where clause based on feed type
    const type = (req.query.type as string) || 'all';
    let whereClause: any = {
      status: 'ACTIVE',
    };

    if (type === 'posts') {
      whereClause.isRoast = false;
    } else if (type === 'banter') {
      whereClause.isRoast = true;
    } else {
      whereClause.OR = [
        { isRoast: false },
        { isRoast: true },
      ];
    }

    if (feed === 'following' && userId && type === 'banter') {
      whereClause.AND = [
        {
          OR: [
            { votes: { some: { userId } } },
            { comments: { some: { userId } } },
            { reactions: { some: { userId } } },
          ],
        },
      ];
    } else if (feed === 'following' && userId) {
      const followedUserIds = await prisma.follow.findMany({
        where: { followerId: userId },
        select: { followingId: true },
      });
      const ids = followedUserIds.map((f) => f.followingId);
      whereClause.userId = { in: ids.length ? ids : ['__none__'] };
    }

    // Order by logic
    let orderBy: any = { createdAt: 'desc' };
    if (feed === 'hot') {
      // Order by engagement (votes + reactions + comments)
      // For now, use vote count as engagement metric
      orderBy = [
        { stayVotes: 'desc' },
        { dropVotes: 'desc' },
        { createdAt: 'desc' },
      ];
    }

    const posts = await prisma.post.findMany({
      where: whereClause,
      include: {
        user: {
          select: {
            id: true,
            displayName: true,
            username: true,
            avatarUrl: true,
          },
        },
        votes: {
          select: {
            id: true,
            userId: true,
            voteType: true,
          },
        },
        postTags: {
          include: {
            tag: true,
          },
        },
        _count: {
          select: {
            comments: true,
            reactions: true,
          },
        },
        repostOf: {
          select: {
            id: true,
            content: true,
            mediaUrl: true,
            mediaType: true,
            mediaItems: true,
            isRoast: true,
            tags: true,
            league: true,
            createdAt: true,
            user: {
              select: {
                id: true,
                displayName: true,
                username: true,
                avatarUrl: true,
              },
            },
          },
        },
      },
      orderBy,
      skip,
      take: limit,
    });

    const postIds = posts.map((p) => p.id);
    const reactionGroups = postIds.length
      ? await prisma.reaction.groupBy({
          by: ['postId', 'type'],
          where: { postId: { in: postIds } },
          _count: { type: true },
        })
      : [];

    const reactionMap = reactionGroups.reduce<Record<string, Record<string, number>>>(
      (acc, row) => {
        const postId = row.postId as string;
        if (!acc[postId]) acc[postId] = {};
        acc[postId][row.type] = row._count.type;
        return acc;
      },
      {}
    );

    const userReactionMap: Record<string, string> = {};
    if (userId && postIds.length) {
      const userReactions = await prisma.reaction.findMany({
        where: { postId: { in: postIds }, userId },
        select: { postId: true, type: true },
      });
      for (const reaction of userReactions) {
        userReactionMap[reaction.postId] = reaction.type;
      }
    }

    const total = await prisma.post.count({
      where: whereClause,
    });

    res.json({
      success: true,
      posts: posts.map((post) => {
        const userVote = userId
          ? post.votes.find((v) => v.userId === userId)
          : null;

        return {
          id: post.id,
          content: post.content,
          mediaUrl: post.mediaUrl,
          mediaType: post.mediaType,
          mediaItems: getSerializableMediaItems(post.mediaItems, post.mediaUrl, post.mediaType),
          isRoast: post.isRoast,
          tags: post.tags,
          league: post.league,
          stayVotes: post.stayVotes,
          dropVotes: post.dropVotes,
          shareCount: post.shareCount,
          repostCount: post.repostCount,
          status: post.status,
          expiresAt: post.expiresAt,
          createdAt: post.createdAt,
          ownedByViewer: post.userId === userId,
          user: post.user,
          userVote: userVote ? userVote.voteType : null,
          commentCount: post._count.comments,
          reactionCount: post._count.reactions,
          reactionBreakdown: reactionMap[post.id] || {},
          userReaction: userReactionMap[post.id] || null,
          repostOf: post.repostOf,
        };
      }),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    logger.error('Get posts error', { error });
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Failed to get posts', 500);
  }
});

/**
 * GET /api/posts/:id
 * Get a specific post
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const postId = req.params.id;
    const userId = req.user?.userId;

    const post = await prisma.post.findUnique({
      where: { id: postId },
      include: {
        user: {
          select: {
            id: true,
            displayName: true,
            username: true,
            avatarUrl: true,
          },
        },
        votes: {
          include: {
            user: {
              select: {
                id: true,
                displayName: true,
                username: true,
                avatarUrl: true,
              },
            },
          },
        },
        _count: {
          select: {
            comments: true,
            reactions: true,
          },
        },
        repostOf: {
          select: {
            id: true,
            content: true,
            mediaUrl: true,
            mediaType: true,
            mediaItems: true,
            isRoast: true,
            tags: true,
            league: true,
            createdAt: true,
            user: {
              select: {
                id: true,
                displayName: true,
                username: true,
                avatarUrl: true,
              },
            },
          },
        },
      },
    });

    if (!post) {
      throw new AppError('Post not found', 404);
    }

    const reactionCounts = await prisma.reaction.groupBy({
      by: ['type'],
      where: { postId },
      _count: {
        type: true,
      },
    });

    const reactionBreakdown = reactionCounts.reduce<Record<string, number>>(
      (acc, row) => {
        acc[row.type] = row._count.type;
        return acc;
      },
      {}
    );

    const userReaction = userId
      ? await prisma.reaction.findUnique({
          where: {
            postId_userId: {
              postId,
              userId,
            },
          },
          select: { type: true },
        })
      : null;

    return res.json({
      success: true,
      post: {
        id: post.id,
        content: post.content,
        mediaUrl: post.mediaUrl,
        mediaType: post.mediaType,
        mediaItems: getSerializableMediaItems(post.mediaItems, post.mediaUrl, post.mediaType),
        isRoast: post.isRoast,
        tags: post.tags,
        league: post.league,
        stayVotes: post.stayVotes,
        dropVotes: post.dropVotes,
        shareCount: post.shareCount,
        repostCount: post.repostCount,
        status: post.status,
        expiresAt: post.expiresAt,
        hiddenAt: post.hiddenAt,
        createdAt: post.createdAt,
        ownedByViewer: post.userId === userId,
        user: post.user,
        votes: post.votes,
        commentCount: post._count.comments,
        reactionCount: post._count.reactions,
        reactionBreakdown,
        userReaction: userReaction?.type || null,
        repostOf: post.repostOf,
      },
    });
  } catch (error) {
    logger.error('Get post error', { error });
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Failed to get post', 500);
  }
});

/**
 * PATCH /api/posts/:id
 * Edit a post (content only)
 */
router.patch('/:id', jwtAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      throw new AppError('User not authenticated', 401);
    }

    const postId = req.params.id;
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : null;

    if (content !== null && content.length === 0) {
      throw new AppError('Post content cannot be empty', 400);
    }

    const post = await prisma.post.findUnique({
      where: { id: postId },
    });

    if (!post) {
      throw new AppError('Post not found', 404);
    }

    if (post.userId !== userId) {
      throw new AppError('Not authorized to edit this post', 403);
    }

    if (post.status !== 'ACTIVE') {
      throw new AppError('Cannot edit an inactive post', 400);
    }

    const updated = await prisma.post.update({
      where: { id: postId },
      data: {
        content: content ?? post.content,
      },
      include: {
        user: {
          select: {
            id: true,
            displayName: true,
            username: true,
            avatarUrl: true,
          },
        },
        _count: {
          select: {
            comments: true,
            reactions: true,
          },
        },
        repostOf: {
          select: {
            id: true,
            content: true,
            mediaUrl: true,
            mediaType: true,
            mediaItems: true,
            isRoast: true,
            tags: true,
            league: true,
            createdAt: true,
            user: {
              select: {
                id: true,
                displayName: true,
                username: true,
                avatarUrl: true,
              },
            },
          },
        },
      },
    });

    res.json({
      success: true,
      post: {
        id: updated.id,
        content: updated.content,
        mediaUrl: updated.mediaUrl,
        mediaType: updated.mediaType,
        mediaItems: getSerializableMediaItems(updated.mediaItems, updated.mediaUrl, updated.mediaType),
        isRoast: updated.isRoast,
        tags: updated.tags,
        league: updated.league,
        stayVotes: updated.stayVotes,
        dropVotes: updated.dropVotes,
        shareCount: updated.shareCount,
        repostCount: updated.repostCount,
        status: updated.status,
        expiresAt: updated.expiresAt,
        hiddenAt: updated.hiddenAt,
        createdAt: updated.createdAt,
        ownedByViewer: updated.userId === userId,
        user: updated.user,
        commentCount: updated._count.comments,
        reactionCount: updated._count.reactions,
        repostOf: updated.repostOf,
      },
    });
  } catch (error) {
    logger.error('Edit post error', { error });
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Failed to edit post', 500);
  }
});

/**
 * DELETE /api/posts/:id
 * Hide (delete) a post
 */
router.delete('/:id', jwtAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      throw new AppError('User not authenticated', 401);
    }

    const postId = req.params.id;

    const post = await prisma.post.findUnique({
      where: { id: postId },
    });

    if (!post) {
      throw new AppError('Post not found', 404);
    }

    if (post.userId !== userId) {
      throw new AppError('Not authorized to delete this post', 403);
    }

    if (post.status !== 'ACTIVE') {
      await hardDeletePost(postId);
      return res.json({ success: true });
    }

    const updated = await hardDeletePost(postId);

    try {
      const { getIO } = await import('../websocket/socket');
      getIO().emit('post-hidden', { postId });
      if (post.repostOfId && typeof updated.repostCount === 'number') {
        getIO().emit('repost-update', {
          postId: post.repostOfId,
          repostCount: updated.repostCount,
        });
      }
    } catch (error) {
      logger.warn('WebSocket not available for post-hidden event', { error });
    }

    return res.json({ success: true });
  } catch (error) {
    logger.error('Delete post error', { error });
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Failed to delete post', 500);
  }
});

/**
 * POST /api/posts/:id/share
 * Increment share count for a post
 */
router.post('/:id/share', async (req: Request, res: Response) => {
  try {
    const postId = req.params.id;

    const post = await prisma.post.findUnique({
      where: { id: postId },
    });

    if (!post) {
      throw new AppError('Post not found', 404);
    }

    const updated = await prisma.post.update({
      where: { id: postId },
      data: {
        shareCount: { increment: 1 },
      },
    });

    try {
      const { getIO } = await import('../websocket/socket');
      getIO().emit('share-update', {
        postId,
        shareCount: updated.shareCount,
      });
    } catch (error) {
      logger.warn('WebSocket not available for share-update event', { error });
    }

    res.json({
      success: true,
      shareCount: updated.shareCount,
    });
  } catch (error) {
    logger.error('Share post error', { error });
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Failed to share post', 500);
  }
});

/**
 * POST /api/posts/:id/repost
 * Create a repost/rebanter for the current user
 */
router.post('/:id/repost', jwtAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      throw new AppError('User not authenticated', 401);
    }

    const postId = req.params.id;
    const comment = typeof req.body?.comment === 'string' ? req.body.comment.trim() : '';

    const original = await prisma.post.findUnique({
      where: { id: postId },
    });

    if (!original) {
      throw new AppError('Post not found', 404);
    }

    const existing = await prisma.post.findFirst({
      where: {
        userId,
        repostOfId: postId,
      },
    });

    if (existing) {
      return res.json({
        success: true,
        repost: {
          id: existing.id,
          repostOfId: postId,
        },
        repostCount: original.repostCount,
        message: 'Already reposted',
      });
    }

    const expiresAt = new Date();
    if (original.isRoast) {
      expiresAt.setHours(expiresAt.getHours() + 24);
    } else {
      expiresAt.setFullYear(expiresAt.getFullYear() + 100);
    }

    const created = await prisma.$transaction(async (tx) => {
      const repost = await tx.post.create({
        data: {
          userId,
          content: comment || '',
          mediaUrl: null,
          mediaType: null,
          isRoast: original.isRoast,
          tags: original.tags,
          league: original.league,
          expiresAt,
          status: 'ACTIVE',
          repostOfId: original.id,
        },
      });

      const updated = await tx.post.update({
        where: { id: original.id },
        data: {
          repostCount: { increment: 1 },
        },
      });

      return { repost, updated };
    });

    try {
      const { getIO } = await import('../websocket/socket');
      getIO().emit('repost-update', {
        postId,
        repostCount: created.updated.repostCount,
      });
    } catch (error) {
      logger.warn('WebSocket not available for repost-update event', { error });
    }

    return res.json({
      success: true,
      repost: {
        id: created.repost.id,
        repostOfId: postId,
      },
      repostCount: created.updated.repostCount,
    });
  } catch (error) {
    logger.error('Repost error', { error });
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Failed to repost', 500);
  }
});

export default router;
