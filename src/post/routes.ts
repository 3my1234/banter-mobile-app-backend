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

    const { content, imageUrl } = req.body;

    if (!content || content.trim().length === 0) {
      throw new AppError('Post content is required', 400);
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

    const post = await prisma.post.create({
      data: {
        userId: user.id,
        content: content.trim(),
        imageUrl: imageUrl || null,
        expiresAt,
        status: 'ACTIVE',
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
        imageUrl: post.imageUrl,
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
 * Get all active posts (paginated)
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const skip = (page - 1) * limit;

    const posts = await prisma.post.findMany({
      where: {
        status: 'ACTIVE',
        expiresAt: {
          gt: new Date(), // Only show posts that haven't expired
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
        votes: {
          select: {
            id: true,
            userId: true,
            voteType: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      skip,
      take: limit,
    });

    const total = await prisma.post.count({
      where: {
        status: 'ACTIVE',
        expiresAt: {
          gt: new Date(),
        },
      },
    });

    res.json({
      success: true,
      posts: posts.map((post) => ({
        id: post.id,
        content: post.content,
        imageUrl: post.imageUrl,
        stayVotes: post.stayVotes,
        dropVotes: post.dropVotes,
        status: post.status,
        expiresAt: post.expiresAt,
        createdAt: post.createdAt,
        user: post.user,
        userVote: null, // Will be set by frontend based on votes array
      })),
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
        imageUrl: post.imageUrl,
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
