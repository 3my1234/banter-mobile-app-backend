import { Router, Request, Response } from 'express';
import { prisma } from '../index';
import { logger } from '../utils/logger';
import { AppError } from '../utils/errorHandler';

const router = Router();

/**
 * GET /api/users/:id/posts
 * Get all posts by a specific user (for Profile page)
 */
router.get('/:id/posts', async (req: Request, res: Response) => {
  try {
    const userId = req.params.id;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const skip = (page - 1) * limit;

    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new AppError('User not found', 404);
    }

    const posts = await prisma.post.findMany({
      where: {
        userId,
        status: 'ACTIVE',
        OR: [
          { isRoast: false },
          {
            isRoast: true,
            expiresAt: { gt: new Date() },
          },
        ],
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
      orderBy: {
        createdAt: 'desc',
      },
      skip,
      take: limit,
    });

    const total = await prisma.post.count({
      where: {
        userId,
        status: 'ACTIVE',
        OR: [
          { isRoast: false },
          {
            isRoast: true,
            expiresAt: { gt: new Date() },
          },
        ],
      },
    });

    res.json({
      success: true,
      posts: posts.map((post) => ({
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
        commentCount: post._count.comments,
        reactionCount: post._count.reactions,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    logger.error('Get user posts error', { error });
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Failed to get user posts', 500);
  }
});

/**
 * GET /api/users/:id
 * Get user profile with follow stats
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.params.id;
    const viewerId = req.user?.userId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        displayName: true,
        username: true,
        avatarUrl: true,
        bannerUrl: true,
        bio: true,
        createdAt: true,
      },
    });

    if (!user) {
      throw new AppError('User not found', 404);
    }

    const [followersCount, followingCount, isFollowing] = await Promise.all([
      prisma.follow.count({ where: { followingId: userId } }),
      prisma.follow.count({ where: { followerId: userId } }),
      viewerId
        ? prisma.follow.findUnique({
            where: {
              followerId_followingId: {
                followerId: viewerId,
                followingId: userId,
              },
            },
          })
        : Promise.resolve(null),
    ]);

    res.json({
      success: true,
      user: {
        ...user,
        followersCount,
        followingCount,
      },
      isFollowing: !!isFollowing,
    });
  } catch (error) {
    logger.error('Get user profile error', { error });
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Failed to get user profile', 500);
  }
});

/**
 * POST /api/users/:id/follow
 * Follow a user
 */
router.post('/:id/follow', async (req: Request, res: Response) => {
  try {
    const targetId = req.params.id;
    const viewerId = req.user?.userId;
    if (!viewerId) {
      throw new AppError('User not authenticated', 401);
    }
    if (viewerId === targetId) {
      throw new AppError('Cannot follow yourself', 400);
    }

    const target = await prisma.user.findUnique({ where: { id: targetId } });
    if (!target) {
      throw new AppError('User not found', 404);
    }

    await prisma.follow.upsert({
      where: {
        followerId_followingId: {
          followerId: viewerId,
          followingId: targetId,
        },
      },
      update: {},
      create: {
        followerId: viewerId,
        followingId: targetId,
      },
    });

    res.json({ success: true, following: true });
  } catch (error) {
    logger.error('Follow user error', { error });
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Failed to follow user', 500);
  }
});

/**
 * DELETE /api/users/:id/follow
 * Unfollow a user
 */
router.delete('/:id/follow', async (req: Request, res: Response) => {
  try {
    const targetId = req.params.id;
    const viewerId = req.user?.userId;
    if (!viewerId) {
      throw new AppError('User not authenticated', 401);
    }
    if (viewerId === targetId) {
      throw new AppError('Cannot unfollow yourself', 400);
    }

    await prisma.follow.deleteMany({
      where: {
        followerId: viewerId,
        followingId: targetId,
      },
    });

    res.json({ success: true, following: false });
  } catch (error) {
    logger.error('Unfollow user error', { error });
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Failed to unfollow user', 500);
  }
});

export default router;
