import { Router, Request, Response } from 'express';
import { prisma } from '../index';
import { logger } from '../utils/logger';
import { AppError } from '../utils/errorHandler';
import { addPostExpirationJob } from '../queue/postQueue';
import { jwtAuthMiddleware } from '../auth/jwtMiddleware';

const router = Router();

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

    const { content, mediaUrl, mediaType, isRoast, tags, league } = req.body;

    if (!content || content.trim().length === 0) {
      throw new AppError('Post content is required', 400);
    }

    // Validate mediaType if mediaUrl is provided
    if (mediaUrl && mediaType && !['image', 'video'].includes(mediaType)) {
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
        mediaUrl: mediaUrl || null,
        mediaType: mediaType || null,
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
      whereClause.expiresAt = { gt: new Date() };
    } else {
      whereClause.OR = [
        { isRoast: false },
        {
          isRoast: true,
          expiresAt: {
            gt: new Date(), // Only show roasts that haven't expired
          },
        },
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
      // TODO: Implement following logic when Follow model is added
      // For now, return empty or all posts
      // whereClause.userId = { in: followedUserIds };
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
          user: post.user,
          userVote: userVote ? userVote.voteType : null,
          commentCount: post._count.comments,
          reactionCount: post._count.reactions,
          reactionBreakdown: reactionMap[post.id] || {},
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

    res.json({
      success: true,
      post: {
        id: post.id,
        content: post.content,
        mediaUrl: post.mediaUrl,
        mediaType: post.mediaType,
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
        user: post.user,
        votes: post.votes,
        commentCount: post._count.comments,
        reactionCount: post._count.reactions,
        reactionBreakdown,
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
