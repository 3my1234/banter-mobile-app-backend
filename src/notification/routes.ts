import { Router, Request, Response } from 'express';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from './service';
import { AppError } from '../utils/errorHandler';
import { logger } from '../utils/logger';

const router = Router();

/**
 * GET /api/notifications
 * List current user's notifications.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      throw new AppError('User not authenticated', 401);
    }

    const unreadOnly = req.query.unreadOnly === '1' || req.query.unreadOnly === 'true';
    const limit = Number(req.query.limit || 100);
    const items = await listNotifications(userId, unreadOnly, limit);

    return res.json({
      success: true,
      notifications: items,
    });
  } catch (error) {
    logger.error('List notifications error', { error });
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    return res.status(500).json({ success: false, message: 'Failed to list notifications' });
  }
});

/**
 * POST /api/notifications/:id/read
 * Mark a single notification as read.
 */
router.post('/:id/read', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      throw new AppError('User not authenticated', 401);
    }

    const updated = await markNotificationRead(userId, req.params.id);
    if (!updated) {
      throw new AppError('Notification not found', 404);
    }

    return res.json({
      success: true,
      notification: updated,
    });
  } catch (error) {
    logger.error('Mark notification read error', { error });
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    return res.status(500).json({ success: false, message: 'Failed to mark notification as read' });
  }
});

/**
 * POST /api/notifications/read-all
 * Mark all notifications as read for current user.
 */
router.post('/read-all', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      throw new AppError('User not authenticated', 401);
    }

    await markAllNotificationsRead(userId);
    return res.json({ success: true });
  } catch (error) {
    logger.error('Mark all notifications read error', { error });
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    return res.status(500).json({ success: false, message: 'Failed to mark all as read' });
  }
});

export default router;
