import { NotificationType, Prisma } from '@prisma/client';
import { prisma } from '../index';
import { logger } from '../utils/logger';
import { getIO } from '../websocket/socket';

export const buildUserRoom = (userId: string) => `user:${userId}`;

type CreateNotificationInput = {
  userId: string;
  type: NotificationType;
  title: string;
  body?: string | null;
  data?: Prisma.InputJsonValue;
  reference?: string;
};

export async function createNotification(input: CreateNotificationInput) {
  try {
    const created = await prisma.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        data: input.data,
        reference: input.reference,
      },
    });
    emitNotificationCreated(created);
    return created;
  } catch (error: any) {
    // Idempotent duplicate guard (e.g., same daily reward reference).
    if (error?.code === 'P2002' && input.reference) {
      return prisma.notification.findUnique({
        where: { reference: input.reference },
      });
    }
    throw error;
  }
}

export function emitToUser(userId: string, event: string, payload: unknown) {
  try {
    getIO().to(buildUserRoom(userId)).emit(event, payload);
  } catch (error) {
    logger.warn('WebSocket emit skipped (socket not ready)', { userId, event, error });
  }
}

export function emitNotificationCreated(notification: {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  body: string | null;
  data: Prisma.JsonValue | null;
  readAt: Date | null;
  createdAt: Date;
}) {
  emitToUser(notification.userId, 'notifications.new', {
    id: notification.id,
    type: notification.type,
    title: notification.title,
    body: notification.body,
    data: notification.data,
    readAt: notification.readAt,
    createdAt: notification.createdAt,
  });
}

export async function listNotifications(userId: string, unreadOnly = false, limit = 100) {
  return prisma.notification.findMany({
    where: {
      userId,
      ...(unreadOnly ? { readAt: null } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 200),
  });
}

export async function markNotificationRead(userId: string, notificationId: string) {
  const notification = await prisma.notification.findUnique({
    where: { id: notificationId },
  });
  if (!notification || notification.userId !== userId) {
    return null;
  }
  const updated = await prisma.notification.update({
    where: { id: notificationId },
    data: { readAt: new Date() },
  });
  emitToUser(userId, 'notifications.read', { id: updated.id, readAt: updated.readAt });
  return updated;
}

export async function markAllNotificationsRead(userId: string) {
  const now = new Date();
  await prisma.notification.updateMany({
    where: {
      userId,
      readAt: null,
    },
    data: {
      readAt: now,
    },
  });
  emitToUser(userId, 'notifications.read_all', { readAt: now });
}
