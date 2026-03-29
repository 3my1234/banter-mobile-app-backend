import { Router, Request, Response } from 'express';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from './service';
import { registerPushToken, unregisterPushToken } from './pushService';
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

/**
 * POST /api/notifications/push-token
 * Register/update current device push token for authenticated user.
 */
router.post('/push-token', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      throw new AppError('User not authenticated', 401);
    }

    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    const platform = typeof req.body?.platform === 'string' ? req.body.platform : undefined;
    const appVersion = typeof req.body?.appVersion === 'string' ? req.body.appVersion : undefined;

    if (!token.trim()) {
      throw new AppError('Push token is required', 400);
    }

    await registerPushToken({
      userId,
      token,
      platform,
      appVersion,
    });

    return res.json({ success: true });
  } catch (error: any) {
    logger.error('Register push token error', { error });
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    const message = String(error?.message || '');
    if (message.includes('Invalid Expo push token')) {
      return res.status(400).json({ success: false, message: 'Invalid push token' });
    }
    return res.status(500).json({ success: false, message: 'Failed to register push token' });
  }
});

/**
 * DELETE /api/notifications/push-token
 * Deactivate current device push token (or all user tokens when token omitted).
 */
router.delete('/push-token', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      throw new AppError('User not authenticated', 401);
    }

    const token = typeof req.body?.token === 'string' ? req.body.token : undefined;
    await unregisterPushToken({ userId, token });
    return res.json({ success: true });
  } catch (error) {
    logger.error('Unregister push token error', { error });
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    return res.status(500).json({ success: false, message: 'Failed to unregister push token' });
  }
});

export default router;
