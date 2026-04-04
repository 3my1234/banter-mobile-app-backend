import { Router, Request, Response } from 'express';
import { prisma } from '../index';
import { logger } from '../utils/logger';
import { AppError } from '../utils/errorHandler';
import { getIO } from '../websocket/socket';

const router = Router();

const VALID_REACTION_TYPES = ['LIKE', 'LOVE', 'LAUGH', 'FIRE', 'ANGRY', 'SAD'];

async function getReactionMetrics(postId: string) {
  const reactionCount = await prisma.reaction.count({ where: { postId } });
  const grouped = await prisma.reaction.groupBy({
    by: ['type'],
    where: { postId },
    _count: { type: true },
  });
  const reactionBreakdown = grouped.reduce<Record<string, number>>((acc, row) => {
    acc[row.type] = row._count.type;
    return acc;
  }, {});
  return { reactionCount, reactionBreakdown };
}

/**
 * POST /api/reactions
 * Add or update a reaction on a post
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      throw new AppError('User not authenticated', 401);
    }

    const { postId, type } = req.body;

    if (!postId) {
      throw new AppError('Post ID is required', 400);
    }

    if (!type || !VALID_REACTION_TYPES.includes(type)) {
      throw new AppError(`Reaction type must be one of: ${VALID_REACTION_TYPES.join(', ')}`, 400);
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new AppError('User not found', 404);
    }

    // Check if post exists
    const post = await prisma.post.findUnique({
      where: { id: postId },
    });

    if (!post) {
      throw new AppError('Post not found', 404);
    }

    if (post.status !== 'ACTIVE') {
      throw new AppError('Cannot react to inactive post', 400);
    }
    if (!post.isRoast || !post.expiresAt || post.expiresAt <= new Date()) {
      throw new AppError('Post not found', 404);
    }

    // Check if user already reacted
    const existingReaction = await prisma.reaction.findUnique({
      where: {
        postId_userId: {
          postId,
          userId: user.id,
        },
      },
    });

    let reaction;
    let action: 'created' | 'updated' | 'removed' = 'created';
    if (existingReaction) {
      if (existingReaction.type === type) {
        // Same reaction, remove it (toggle off)
        try {
          await prisma.reaction.delete({
            where: { id: existingReaction.id },
          });
        } catch (error: any) {
          if (error?.code !== 'P2025') {
            throw error;
          }
        }
        logger.info(`Removed reaction ${type} on post ${postId} by user ${user.id}`);
        action = 'removed';
        const { reactionCount, reactionBreakdown } = await getReactionMetrics(postId);
        try {
          getIO().emit('reaction-update', {
            postId,
            reactionCount,
            reactionBreakdown,
            action,
            type,
            userId: user.id,
          });
        } catch (error) {
          logger.warn('WebSocket not available for reaction-update event', { error });
        }
        return res.json({
          success: true,
          reaction: null,
          message: 'Reaction removed',
          reactionCount,
          reactionBreakdown,
        });
      } else {
        // Update reaction type
        reaction = await prisma.reaction.update({
          where: { id: existingReaction.id },
          data: { type },
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
        });
        logger.info(`Updated reaction to ${type} on post ${postId} by user ${user.id}`);
        action = 'updated';
      }
    } else {
      // Create new reaction
      reaction = await prisma.reaction.create({
        data: {
          postId,
          userId: user.id,
          type,
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
        },
      });
      logger.info(`Created reaction ${type} on post ${postId} by user ${user.id}`);
      action = 'created';
    }

    const { reactionCount, reactionBreakdown } = await getReactionMetrics(postId);
    try {
      getIO().emit('reaction-update', {
        postId,
        reactionCount,
        reactionBreakdown,
        action,
        type,
        userId: user.id,
      });
    } catch (error) {
      logger.warn('WebSocket not available for reaction-update event', { error });
    }

    return res.json({
      success: true,
      reaction: {
        id: reaction.id,
        postId: reaction.postId,
        userId: reaction.userId,
        type: reaction.type,
        createdAt: reaction.createdAt,
        user: reaction.user,
      },
      reactionCount,
      reactionBreakdown,
    });
  } catch (error) {
    logger.error('Reaction error', { error });
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message,
      });
    }
    const postId = typeof req.body?.postId === 'string' ? req.body.postId : null;
    const userId = req.user?.userId;

    if ((error as any)?.code === 'P2002' && postId && userId) {
      const existingReaction = await prisma.reaction.findUnique({
        where: {
          postId_userId: {
            postId,
            userId,
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
        },
      });
      const { reactionCount, reactionBreakdown } = await getReactionMetrics(postId);
      return res.status(200).json({
        success: true,
        reaction: existingReaction,
        reactionCount,
        reactionBreakdown,
        message: 'Reaction already processed',
      });
    }

    if ((error as any)?.code === 'P2025' && postId) {
      const { reactionCount, reactionBreakdown } = await getReactionMetrics(postId);
      return res.status(200).json({
        success: true,
        reaction: null,
        reactionCount,
        reactionBreakdown,
        message: 'Reaction already processed',
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Failed to create reaction',
    });
  }
});

export default router;
