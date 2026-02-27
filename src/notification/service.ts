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

type NotificationRecord = {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  body: string | null;
  data: Prisma.JsonValue | null;
  reference: string | null;
  readAt: Date | null;
  createdAt: Date;
};

const toCleanString = (value: unknown) => {
  if (typeof value !== 'string') return '';
  return value.trim();
};

const getDataObject = (data: Prisma.JsonValue | Prisma.InputJsonValue | null | undefined) => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {} as Record<string, unknown>;
  return data as Record<string, unknown>;
};

const formatFromRaw = (amountRaw: string, decimals: number) => {
  const raw = Number(amountRaw || '0');
  if (!Number.isFinite(raw)) return amountRaw;
  return (raw / 10 ** decimals).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: Math.min(decimals, 6),
  });
};

export const resolveNotificationMessage = (input: {
  type: NotificationType;
  title: string;
  body?: string | null;
  data?: Prisma.JsonValue | Prisma.InputJsonValue | null;
}) => {
  const explicitBody = toCleanString(input.body);
  if (explicitBody) return explicitBody;

  const data = getDataObject(input.data || null);
  const type = input.type;

  if (type === 'DAILY_ROL') {
    return 'You received your daily ROL reward.';
  }

  if (type === 'VOTE_PURCHASE') {
    const votes = Number(data.votes || 0);
    const amount = toCleanString(data.amount);
    const currency = toCleanString(data.currency) || 'USD';
    if (votes > 0 && amount) return `You received ${votes} vote${votes === 1 ? '' : 's'} for ${amount} ${currency}.`;
    if (votes > 0) return `You received ${votes} vote${votes === 1 ? '' : 's'}.`;
  }

  if (type === 'WALLET_RECEIVE' || type === 'WALLET_TRANSFER') {
    const amountDisplay = toCleanString(data.amountDisplay);
    const tokenSymbol = toCleanString(data.tokenSymbol) || 'TOKEN';
    if (amountDisplay) {
      return `${type === 'WALLET_RECEIVE' ? '+' : '-'}${amountDisplay} ${tokenSymbol}`;
    }
    const raw = toCleanString(data.amountRaw);
    const decimals = Number(data.decimals || (tokenSymbol === 'MOVE' ? 8 : 6));
    if (raw) {
      const display = Number.isFinite(decimals) ? formatFromRaw(raw, decimals) : raw;
      return `${type === 'WALLET_RECEIVE' ? '+' : '-'}${display} ${tokenSymbol}`;
    }
  }

  if (type === 'COMMENT_REPLY') {
    return 'Someone interacted with your post/comment.';
  }

  return toCleanString(input.title) || 'New notification';
};

export const normalizeNotificationForClient = (notification: NotificationRecord) => {
  const message = resolveNotificationMessage({
    type: notification.type,
    title: notification.title,
    body: notification.body,
    data: notification.data,
  });

  return {
    ...notification,
    body: message,
    message,
  };
};

export async function createNotification(input: CreateNotificationInput) {
  try {
    const resolvedBody = resolveNotificationMessage({
      type: input.type,
      title: input.title,
      body: input.body,
      data: input.data,
    });
    const created = await prisma.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: resolvedBody,
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
  const normalized = normalizeNotificationForClient(notification as NotificationRecord);
  emitToUser(notification.userId, 'notifications.new', {
    id: normalized.id,
    type: normalized.type,
    title: normalized.title,
    body: normalized.body,
    message: normalized.message,
    data: normalized.data,
    readAt: normalized.readAt,
    createdAt: normalized.createdAt,
  });
}

export async function listNotifications(userId: string, unreadOnly = false, limit = 100) {
  const items = await prisma.notification.findMany({
    where: {
      userId,
      ...(unreadOnly ? { readAt: null } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 200),
  });
  return items.map((item) => normalizeNotificationForClient(item as NotificationRecord));
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
  return normalizeNotificationForClient(updated as NotificationRecord);
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
