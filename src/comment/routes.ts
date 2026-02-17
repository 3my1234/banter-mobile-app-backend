import { Router, Request, Response } from 'express';
import { prisma } from '../index';
import { logger } from '../utils/logger';
import { AppError } from '../utils/errorHandler';
import { getIO } from '../websocket/socket';
import { jwtAuthMiddleware } from '../auth/jwtMiddleware';

const router = Router();

/**
 * POST /api/comments
 * Create a comment on a post
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      throw new AppError('User not authenticated', 401);
    }

    const { postId, content } = req.body;

    if (!postId) {
      throw new AppError('Post ID is required', 400);
    }

    if (!content || content.trim().length === 0) {
      throw new AppError('Comment content is required', 400);
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
      throw new AppError('Cannot comment on inactive post', 400);
    }

    const comment = await prisma.comment.create({
      data: {
        postId,
        userId: user.id,
        content: content.trim(),
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

    logger.info(`Created comment ${comment.id} on post ${postId} by user ${user.id}`);

    const commentCount = await prisma.comment.count({
      where: { postId },
    });

    try {
      getIO().emit('comment-created', {
        postId,
        comment: {
          id: comment.id,
          postId: comment.postId,
          userId: comment.userId,
          content: comment.content,
          createdAt: comment.createdAt,
          user: comment.user,
        },
        commentCount,
      });
    } catch (error) {
      logger.warn('WebSocket not available for comment-created event', { error });
    }

    res.status(201).json({
      success: true,
      comment: {
        id: comment.id,
        postId: comment.postId,
        userId: comment.userId,
        content: comment.content,
        createdAt: comment.createdAt,
        user: comment.user,
      },
      commentCount,
    });
  } catch (error) {
    logger.error('Create comment error', { error });
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Failed to create comment', 500);
  }
});

/**
 * GET /api/comments/:postId
 * Get all comments for a post
 */
router.get('/:postId', async (req: Request, res: Response) => {
  try {
    const postId = req.params.postId;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const skip = (page - 1) * limit;

    // Check if post exists
    const post = await prisma.post.findUnique({
      where: { id: postId },
    });

    if (!post) {
      throw new AppError('Post not found', 404);
    }

    const comments = await prisma.comment.findMany({
      where: { postId },
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
      orderBy: {
        createdAt: 'asc',
      },
      skip,
      take: limit,
    });

    const total = await prisma.comment.count({
      where: { postId },
    });

    res.json({
      success: true,
      comments: comments.map((comment) => ({
        id: comment.id,
        postId: comment.postId,
        userId: comment.userId,
        content: comment.content,
        createdAt: comment.createdAt,
        user: comment.user,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    logger.error('Get comments error', { error });
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Failed to get comments', 500);
  }
});

/**
 * PATCH /api/comments/:id
 * Edit a comment
 */
router.patch('/:id', jwtAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      throw new AppError('User not authenticated', 401);
    }

    const commentId = req.params.id;
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';

    if (!content) {
      throw new AppError('Comment content is required', 400);
    }

    const comment = await prisma.comment.findUnique({
      where: { id: commentId },
    });

    if (!comment) {
      throw new AppError('Comment not found', 404);
    }

    if (comment.userId !== userId) {
      throw new AppError('Not authorized to edit this comment', 403);
    }

    const updated = await prisma.comment.update({
      where: { id: commentId },
      data: { content },
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

    try {
      getIO().emit('comment-updated', {
        postId: updated.postId,
        comment: {
          id: updated.id,
          postId: updated.postId,
          userId: updated.userId,
          content: updated.content,
          createdAt: updated.createdAt,
          user: updated.user,
        },
      });
    } catch (error) {
      logger.warn('WebSocket not available for comment-updated event', { error });
    }

    res.json({
      success: true,
      comment: {
        id: updated.id,
        postId: updated.postId,
        userId: updated.userId,
        content: updated.content,
        createdAt: updated.createdAt,
        user: updated.user,
      },
    });
  } catch (error) {
    logger.error('Edit comment error', { error });
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Failed to edit comment', 500);
  }
});

/**
 * DELETE /api/comments/:id
 * Delete a comment
 */
router.delete('/:id', jwtAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      throw new AppError('User not authenticated', 401);
    }

    const commentId = req.params.id;
    const comment = await prisma.comment.findUnique({
      where: { id: commentId },
    });

    if (!comment) {
      throw new AppError('Comment not found', 404);
    }

    if (comment.userId !== userId) {
      throw new AppError('Not authorized to delete this comment', 403);
    }

    await prisma.comment.delete({
      where: { id: commentId },
    });

    const commentCount = await prisma.comment.count({
      where: { postId: comment.postId },
    });

    try {
      getIO().emit('comment-deleted', {
        postId: comment.postId,
        commentId,
        commentCount,
      });
    } catch (error) {
      logger.warn('WebSocket not available for comment-deleted event', { error });
    }

    res.json({
      success: true,
      commentId,
      commentCount,
    });
  } catch (error) {
    logger.error('Delete comment error', { error });
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Failed to delete comment', 500);
  }
});

export default router;
