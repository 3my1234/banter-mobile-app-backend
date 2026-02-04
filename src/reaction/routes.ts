import { Router, Request, Response } from 'express';
import { prisma } from '../index';
import { logger } from '../utils/logger';
import { AppError } from '../utils/errorHandler';

const router = Router();

const VALID_REACTION_TYPES = ['LIKE', 'LOVE', 'LAUGH', 'FIRE', 'ANGRY', 'SAD'];

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
    if (existingReaction) {
      if (existingReaction.type === type) {
        // Same reaction, remove it (toggle off)
        await prisma.reaction.delete({
          where: { id: existingReaction.id },
        });
        logger.info(`Removed reaction ${type} on post ${postId} by user ${user.id}`);
        return res.json({
          success: true,
          reaction: null,
          message: 'Reaction removed',
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
    });
  } catch (error) {
    logger.error('Reaction error', { error });
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Failed to create reaction', 500);
  }
});

export default router;
