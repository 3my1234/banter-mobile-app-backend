import { Router, Request, Response } from 'express';
import { prisma } from '../index';
import { logger } from '../utils/logger';
import { AppError } from '../utils/errorHandler';
import { getIO } from '../websocket/socket';
import { jwtAuthMiddleware } from '../auth/jwtMiddleware';

const router = Router();

/**
 * GET /api/comments/:commentId/replies
 * Get replies for a comment
 */
router.get('/replies/:commentId', async (req: Request, res: Response): Promise<Response | void> => {
  try {
    const commentId = req.params.commentId;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const skip = (page - 1) * limit;

    const parent = await prisma.comment.findUnique({
      where: { id: commentId },
    });

    if (!parent) {
      return res.status(404).json({ success: false, message: 'Comment not found' });
    }

    const replies = await prisma.comment.findMany({
      where: { parentId: commentId },
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
      where: { parentId: commentId },
    });

    return res.json({
      success: true,
      replies: replies.map((comment) => ({
        id: comment.id,
        postId: comment.postId,
        userId: comment.userId,
        parentId: comment.parentId,
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
    logger.error('Get comment replies error', { error });
    return res.status(500).json({ success: false, message: 'Failed to get comment replies' });
  }
});

/**
 * POST /api/comments
 * Create a comment on a post
 */
router.post('/', async (req: Request, res: Response): Promise<Response | void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'User not authenticated' });
    }

    const { postId, content, parentId } = req.body;

    if (!postId) {
      return res.status(400).json({ success: false, message: 'Post ID is required' });
    }

    if (!content || content.trim().length === 0) {
      return res.status(400).json({ success: false, message: 'Comment content is required' });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Check if post exists
    const post = await prisma.post.findUnique({
      where: { id: postId },
    });

    if (!post) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }

    if (post.status !== 'ACTIVE') {
      return res.status(400).json({ success: false, message: 'Cannot comment on inactive post' });
    }

    let parent: { id: string; postId: string; parentId: string | null } | null = null;
    if (parentId) {
      parent = await prisma.comment.findUnique({
        where: { id: parentId },
        select: { id: true, postId: true, parentId: true },
      });

      if (!parent) {
        return res.status(404).json({ success: false, message: 'Parent comment not found' });
      }

      if (parent.postId !== postId) {
        return res.status(400).json({ success: false, message: 'Parent comment does not belong to this post' });
      }

      if (parent.parentId) {
        return res.status(400).json({ success: false, message: 'Replies are only supported one level deep' });
      }
    }

    const comment = await prisma.comment.create({
      data: {
        postId,
        userId: user.id,
        content: content.trim(),
        parentId: parent?.id ?? null,
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
          parentId: comment.parentId,
          content: comment.content,
          createdAt: comment.createdAt,
          user: comment.user,
        },
        commentCount,
      });
    } catch (error) {
      logger.warn('WebSocket not available for comment-created event', { error });
    }

    return res.status(201).json({
      success: true,
      comment: {
        id: comment.id,
        postId: comment.postId,
        userId: comment.userId,
        parentId: comment.parentId,
        content: comment.content,
        createdAt: comment.createdAt,
        user: comment.user,
      },
      commentCount,
    });
  } catch (error) {
    logger.error('Create comment error', { error });
    return res.status(500).json({ success: false, message: 'Failed to create comment' });
  }
});

/**
 * GET /api/comments/:postId
 * Get all comments for a post (top-level by default)
 */
router.get('/:postId', async (req: Request, res: Response): Promise<Response | void> => {
  try {
    const postId = req.params.postId;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const parentId = typeof req.query.parentId === 'string' ? req.query.parentId : undefined;
    const includeReplies = req.query.includeReplies === '1';
    const skip = (page - 1) * limit;

    // Check if post exists
    const post = await prisma.post.findUnique({
      where: { id: postId },
    });

    if (!post) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }

    const comments = await prisma.comment.findMany({
      where: { postId, parentId: parentId ?? null },
      include: {
        user: {
          select: {
            id: true,
            displayName: true,
            username: true,
            avatarUrl: true,
          },
        },
        replies: includeReplies
          ? {
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
              orderBy: { createdAt: 'desc' },
              take: 2,
            }
          : undefined,
        _count: {
          select: { replies: true },
        },
      },
      orderBy: {
        createdAt: 'asc',
      },
      skip,
      take: limit,
    });

    const total = await prisma.comment.count({
      where: { postId, parentId: parentId ?? null },
    });

    return res.json({
      success: true,
      comments: comments.map((comment) => {
        const replyList = includeReplies
          ? (comment.replies as any[] | undefined)
          : undefined;
        return {
        id: comment.id,
        postId: comment.postId,
        userId: comment.userId,
        parentId: comment.parentId,
        content: comment.content,
        createdAt: comment.createdAt,
        user: comment.user,
        replyCount: comment._count?.replies || 0,
        replies: replyList
          ? replyList.map((reply) => ({
              id: reply.id,
              postId: reply.postId,
              userId: reply.userId,
              parentId: reply.parentId,
              content: reply.content,
              createdAt: reply.createdAt,
              user: reply.user,
            }))
          : undefined,
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
    logger.error('Get comments error', { error });
    return res.status(500).json({ success: false, message: 'Failed to get comments' });
  }
});

/**
 * PATCH /api/comments/:id
 * Edit a comment
 */
router.patch('/:id', jwtAuthMiddleware, async (req: Request, res: Response): Promise<Response | void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'User not authenticated' });
    }

    const commentId = req.params.id;
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';

    if (!content) {
      return res.status(400).json({ success: false, message: 'Comment content is required' });
    }

    const comment = await prisma.comment.findUnique({
      where: { id: commentId },
    });

    if (!comment) {
      return res.status(404).json({ success: false, message: 'Comment not found' });
    }

    if (comment.userId !== userId) {
      return res.status(403).json({ success: false, message: 'Not authorized to edit this comment' });
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
        _count: {
          select: { replies: true },
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
          parentId: updated.parentId,
          content: updated.content,
          createdAt: updated.createdAt,
          user: updated.user,
          replyCount: updated._count?.replies || 0,
        },
      });
    } catch (error) {
      logger.warn('WebSocket not available for comment-updated event', { error });
    }

    return res.json({
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
    return res.status(500).json({ success: false, message: 'Failed to edit comment' });
  }
});

/**
 * DELETE /api/comments/:id
 * Delete a comment
 */
router.delete('/:id', jwtAuthMiddleware, async (req: Request, res: Response): Promise<Response | void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'User not authenticated' });
    }

    const commentId = req.params.id;
    const comment = await prisma.comment.findUnique({
      where: { id: commentId },
    });

    if (!comment) {
      return res.status(404).json({ success: false, message: 'Comment not found' });
    }

    if (comment.userId !== userId) {
      return res.status(403).json({ success: false, message: 'Not authorized to delete this comment' });
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

    return res.json({
      success: true,
      commentId,
      commentCount,
    });
  } catch (error) {
    logger.error('Delete comment error', { error });
    return res.status(500).json({ success: false, message: 'Failed to delete comment' });
  }
});

export default router;
