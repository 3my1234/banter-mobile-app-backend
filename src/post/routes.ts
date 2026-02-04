import { Router, Request, Response } from 'express';
import { prisma } from '../index';
import { logger } from '../utils/logger';
import { AppError } from '../utils/errorHandler';
import { addPostExpirationJob } from '../queue/postQueue';

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

    // Create post with 24-hour expiration
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);

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

    // Schedule expiration job
    await addPostExpirationJob(post.id, expiresAt);

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
    let whereClause: any = {
      status: 'ACTIVE',
      expiresAt: {
        gt: new Date(), // Only show posts that haven't expired
      },
    };

    if (feed === 'following' && userId) {
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
      },
      orderBy,
      skip,
      take: limit,
    });

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
          status: post.status,
          expiresAt: post.expiresAt,
          createdAt: post.createdAt,
          user: post.user,
          userVote: userVote ? userVote.voteType : null,
          commentCount: post._count.comments,
          reactionCount: post._count.reactions,
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
      },
    });

    if (!post) {
      throw new AppError('Post not found', 404);
    }

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
        status: post.status,
        expiresAt: post.expiresAt,
        hiddenAt: post.hiddenAt,
        createdAt: post.createdAt,
        user: post.user,
        votes: post.votes,
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

export default router;
