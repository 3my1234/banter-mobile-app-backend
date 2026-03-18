import { Router, Request, Response } from 'express';
import { ConversationStatus, NotificationType } from '@prisma/client';
import { prisma } from '../index';
import { AppError } from '../utils/errorHandler';
import { logger } from '../utils/logger';
import { createNotification, emitToUser } from '../notification/service';

const router = Router();

const PREVIEW_LIMIT = 140;

const requireUserId = (req: Request) => {
  const userId = req.user?.userId;
  if (!userId) {
    throw new AppError('User not authenticated', 401);
  }
  return userId;
};

const sanitizeBody = (value: unknown) => String(value || '').trim();

const buildPair = (left: string, right: string) =>
  left.localeCompare(right) <= 0
    ? { userAId: left, userBId: right }
    : { userAId: right, userBId: left };

const previewText = (body: string) =>
  body.length > PREVIEW_LIMIT ? `${body.slice(0, PREVIEW_LIMIT - 1)}…` : body;

const isParticipant = (conversation: { userAId: string; userBId: string }, userId: string) =>
  conversation.userAId === userId || conversation.userBId === userId;

const getOtherParticipant = <
  T extends {
    userAId: string;
    userBId: string;
    userA?: any;
    userB?: any;
  },
>(
  conversation: T,
  userId: string
) => (conversation.userAId === userId ? conversation.userB : conversation.userA);

const normalizeConversation = async (
  conversation: {
    id: string;
    userAId: string;
    userBId: string;
    requestedById: string;
    status: ConversationStatus;
    approvedAt: Date | null;
    rejectedAt: Date | null;
    lastMessageAt: Date | null;
    lastMessagePreview: string | null;
    createdAt: Date;
    userA?: any;
    userB?: any;
    messages?: Array<{ id: string; body: string; createdAt: Date; senderId: string; readAt: Date | null }>;
  },
  userId: string
) => {
  const otherUser = getOtherParticipant(conversation, userId);
  const latestMessage = conversation.messages?.[0] || null;
  const unreadCount = await prisma.directMessage.count({
    where: {
      conversationId: conversation.id,
      senderId: { not: userId },
      readAt: null,
    },
  });

  return {
    id: conversation.id,
    conversationId: conversation.id,
    status: conversation.status,
    pendingIncoming:
      conversation.status === 'PENDING' && conversation.requestedById !== userId,
    pendingOutgoing:
      conversation.status === 'PENDING' && conversation.requestedById === userId,
    participant: otherUser
      ? {
          id: otherUser.id,
          displayName: otherUser.displayName,
          username: otherUser.username,
          avatarUrl: otherUser.avatarUrl,
        }
      : null,
    senderName: otherUser?.displayName || otherUser?.username || 'User',
    preview: latestMessage?.body || conversation.lastMessagePreview || '',
    lastSenderId: latestMessage?.senderId || null,
    unread: unreadCount > 0,
    unreadCount,
    createdAt: conversation.lastMessageAt || conversation.createdAt,
    approvedAt: conversation.approvedAt,
    rejectedAt: conversation.rejectedAt,
  };
};

const notifyMessageRequest = async (recipientId: string, sender: { id: string; displayName: string | null; username: string | null }, conversationId: string, body: string) => {
  const senderName = sender.displayName || sender.username || 'Someone';
  await createNotification({
    userId: recipientId,
    type: NotificationType.MESSAGE_REQUEST,
    title: `${senderName} sent you a message request`,
    body: previewText(body),
    reference: `message-request:${conversationId}:${recipientId}`,
    data: {
      conversationId,
      senderId: sender.id,
    },
  });
  emitToUser(recipientId, 'messages.requested', { conversationId, senderId: sender.id });
};

const notifyDirectMessage = async (
  recipientId: string,
  sender: { id: string; displayName: string | null; username: string | null },
  conversationId: string,
  messageId: string,
  body: string
) => {
  const senderName = sender.displayName || sender.username || 'Someone';
  await createNotification({
    userId: recipientId,
    type: NotificationType.DIRECT_MESSAGE,
    title: senderName,
    body: previewText(body),
    reference: `direct-message:${messageId}:${recipientId}`,
    data: {
      conversationId,
      senderId: sender.id,
      messageId,
    },
  });
  emitToUser(recipientId, 'messages.new', { conversationId, messageId, senderId: sender.id });
};

router.get('/unread-count', async (req: Request, res: Response) => {
  try {
    const userId = requireUserId(req);
    const count = await prisma.directMessage.count({
      where: {
        readAt: null,
        senderId: { not: userId },
        conversation: {
          status: 'ACTIVE',
          OR: [{ userAId: userId }, { userBId: userId }],
        },
      },
    });
    res.json({ success: true, unreadCount: count });
  } catch (error) {
    logger.error('Get message unread count error', { error });
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Failed to load unread count', 500);
  }
});

router.get('/with/:userId', async (req: Request, res: Response) => {
  try {
    const viewerId = requireUserId(req);
    const targetId = String(req.params.userId || '');
    if (!targetId) {
      throw new AppError('User ID is required', 400);
    }
    const pair = buildPair(viewerId, targetId);
    const conversation = await prisma.conversation.findUnique({
      where: {
        userAId_userBId: pair,
      },
      include: {
        userA: { select: { id: true, displayName: true, username: true, avatarUrl: true } },
        userB: { select: { id: true, displayName: true, username: true, avatarUrl: true } },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true, body: true, createdAt: true, senderId: true, readAt: true },
        },
      },
    });

    res.json({
      success: true,
      conversation: conversation ? await normalizeConversation(conversation, viewerId) : null,
    });
  } catch (error) {
    logger.error('Get conversation by user error', { error });
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Failed to load conversation', 500);
  }
});

router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = requireUserId(req);
    const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 100);

    const conversations = await prisma.conversation.findMany({
      where: {
        OR: [{ userAId: userId }, { userBId: userId }],
      },
      include: {
        userA: { select: { id: true, displayName: true, username: true, avatarUrl: true } },
        userB: { select: { id: true, displayName: true, username: true, avatarUrl: true } },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true, body: true, createdAt: true, senderId: true, readAt: true },
        },
      },
      orderBy: [{ lastMessageAt: 'desc' }, { updatedAt: 'desc' }],
      take: limit,
    });

    const normalized = await Promise.all(
      conversations.map((conversation) => normalizeConversation(conversation, userId))
    );

    const unreadCount = normalized.reduce((sum, item) => sum + item.unreadCount, 0);

    res.json({
      success: true,
      messages: normalized,
      unreadCount,
    });
  } catch (error) {
    logger.error('List messages error', { error });
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Failed to load messages', 500);
  }
});

router.get('/conversations/:id', async (req: Request, res: Response) => {
  try {
    const userId = requireUserId(req);
    const conversationId = String(req.params.id || '');
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        userA: { select: { id: true, displayName: true, username: true, avatarUrl: true } },
        userB: { select: { id: true, displayName: true, username: true, avatarUrl: true } },
        messages: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            body: true,
            createdAt: true,
            readAt: true,
            senderId: true,
            sender: {
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

    if (!conversation || !isParticipant(conversation, userId)) {
      throw new AppError('Conversation not found', 404);
    }

    if (conversation.status === 'ACTIVE') {
      const unreadIds = conversation.messages
        .filter((message) => message.senderId !== userId && !message.readAt)
        .map((message) => message.id);
      if (unreadIds.length) {
        await prisma.directMessage.updateMany({
          where: { id: { in: unreadIds } },
          data: { readAt: new Date() },
        });
        emitToUser(userId, 'messages.read', { conversationId, count: unreadIds.length });
      }
    }

    const otherUser = getOtherParticipant(conversation, userId);

    res.json({
      success: true,
      conversation: {
        id: conversation.id,
        status: conversation.status,
        pendingIncoming:
          conversation.status === 'PENDING' && conversation.requestedById !== userId,
        pendingOutgoing:
          conversation.status === 'PENDING' && conversation.requestedById === userId,
        participant: otherUser
          ? {
              id: otherUser.id,
              displayName: otherUser.displayName,
              username: otherUser.username,
              avatarUrl: otherUser.avatarUrl,
            }
          : null,
        messages: conversation.messages.map((message) => ({
          id: message.id,
          body: message.body,
          createdAt: message.createdAt,
          readAt: message.readAt,
          senderId: message.senderId,
          sender: message.sender,
          mine: message.senderId === userId,
        })),
      },
    });
  } catch (error) {
    logger.error('Get conversation detail error', { error });
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Failed to load conversation', 500);
  }
});

router.post('/start', async (req: Request, res: Response) => {
  try {
    const userId = requireUserId(req);
    const recipientId = String(req.body?.recipientId || '').trim();
    const body = sanitizeBody(req.body?.body);

    if (!recipientId) {
      throw new AppError('Recipient is required', 400);
    }
    if (recipientId === userId) {
      throw new AppError('You cannot message yourself', 400);
    }
    if (!body) {
      throw new AppError('Message cannot be empty', 400);
    }

    const [sender, recipient] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, displayName: true, username: true },
      }),
      prisma.user.findUnique({
        where: { id: recipientId },
        select: { id: true, displayName: true, username: true },
      }),
    ]);

    if (!sender || !recipient) {
      throw new AppError('User not found', 404);
    }

    const pair = buildPair(userId, recipientId);
    const existing = await prisma.conversation.findUnique({
      where: { userAId_userBId: pair },
    });

    let conversationId = existing?.id || '';
    let createdMessageId = '';
    let finalStatus = existing?.status || ConversationStatus.PENDING;

    await prisma.$transaction(async (tx) => {
      const now = new Date();
      if (!existing) {
        const created = await tx.conversation.create({
          data: {
            ...pair,
            requestedById: userId,
            status: 'PENDING',
            lastMessageAt: now,
            lastMessagePreview: previewText(body),
            messages: {
              create: {
                senderId: userId,
                body,
              },
            },
          },
          include: {
            messages: {
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: { id: true },
            },
          },
        });
        conversationId = created.id;
        createdMessageId = created.messages[0]?.id || '';
        finalStatus = created.status;
        return;
      }

      if (existing.status === 'PENDING' && existing.requestedById === userId) {
        throw new AppError('Waiting for the other user to approve your message request', 409);
      }

      if (existing.status === 'REJECTED' || (existing.status === 'PENDING' && existing.requestedById !== userId)) {
        await tx.conversation.update({
          where: { id: existing.id },
          data: {
            status: 'ACTIVE',
            approvedAt: now,
            rejectedAt: null,
            lastMessageAt: now,
            lastMessagePreview: previewText(body),
          },
        });
        finalStatus = 'ACTIVE';
      } else {
        await tx.conversation.update({
          where: { id: existing.id },
          data: {
            lastMessageAt: now,
            lastMessagePreview: previewText(body),
          },
        });
      }

      const message = await tx.directMessage.create({
        data: {
          conversationId: existing.id,
          senderId: userId,
          body,
        },
        select: { id: true },
      });
      conversationId = existing.id;
      createdMessageId = message.id;
    });

    if (finalStatus === 'PENDING') {
      await notifyMessageRequest(recipientId, sender, conversationId, body);
    } else {
      await notifyDirectMessage(recipientId, sender, conversationId, createdMessageId, body);
      emitToUser(recipientId, 'messages.request_resolved', {
        conversationId,
        status: 'ACTIVE',
      });
    }

    res.json({
      success: true,
      conversationId,
      status: finalStatus,
    });
  } catch (error) {
    logger.error('Start message conversation error', { error });
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Failed to send message', 500);
  }
});

router.post('/conversations/:id/send', async (req: Request, res: Response) => {
  try {
    const userId = requireUserId(req);
    const conversationId = String(req.params.id || '');
    const body = sanitizeBody(req.body?.body);
    if (!body) {
      throw new AppError('Message cannot be empty', 400);
    }

    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        userA: { select: { id: true, displayName: true, username: true } },
        userB: { select: { id: true, displayName: true, username: true } },
      },
    });

    if (!conversation || !isParticipant(conversation, userId)) {
      throw new AppError('Conversation not found', 404);
    }

    if (conversation.status !== 'ACTIVE') {
      throw new AppError('This conversation is waiting for approval', 409);
    }

    const message = await prisma.$transaction(async (tx) => {
      await tx.conversation.update({
        where: { id: conversationId },
        data: {
          lastMessageAt: new Date(),
          lastMessagePreview: previewText(body),
        },
      });
      return tx.directMessage.create({
        data: {
          conversationId,
          senderId: userId,
          body,
        },
        select: {
          id: true,
          body: true,
          createdAt: true,
          senderId: true,
        },
      });
    });

    const recipientId = conversation.userAId === userId ? conversation.userBId : conversation.userAId;
    const sender = conversation.userAId === userId ? conversation.userA : conversation.userB;
    await notifyDirectMessage(recipientId, sender, conversationId, message.id, body);

    res.json({
      success: true,
      message: {
        ...message,
        mine: true,
      },
    });
  } catch (error) {
    logger.error('Send direct message error', { error });
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Failed to send message', 500);
  }
});

router.post('/conversations/:id/accept', async (req: Request, res: Response) => {
  try {
    const userId = requireUserId(req);
    const conversationId = String(req.params.id || '');
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
    });

    if (!conversation || !isParticipant(conversation, userId)) {
      throw new AppError('Conversation not found', 404);
    }
    if (conversation.status !== 'PENDING' || conversation.requestedById === userId) {
      throw new AppError('No incoming request to accept', 409);
    }

    const updated = await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        status: 'ACTIVE',
        approvedAt: new Date(),
        rejectedAt: null,
      },
    });

    const requesterId = conversation.requestedById;
    emitToUser(requesterId, 'messages.request_resolved', {
      conversationId,
      status: 'ACTIVE',
    });

    res.json({ success: true, conversation: updated });
  } catch (error) {
    logger.error('Accept message request error', { error });
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Failed to accept request', 500);
  }
});

router.post('/conversations/:id/reject', async (req: Request, res: Response) => {
  try {
    const userId = requireUserId(req);
    const conversationId = String(req.params.id || '');
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
    });

    if (!conversation || !isParticipant(conversation, userId)) {
      throw new AppError('Conversation not found', 404);
    }
    if (conversation.status !== 'PENDING' || conversation.requestedById === userId) {
      throw new AppError('No incoming request to reject', 409);
    }

    const updated = await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        status: 'REJECTED',
        rejectedAt: new Date(),
      },
    });

    emitToUser(conversation.requestedById, 'messages.request_resolved', {
      conversationId,
      status: 'REJECTED',
    });

    res.json({ success: true, conversation: updated });
  } catch (error) {
    logger.error('Reject message request error', { error });
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Failed to reject request', 500);
  }
});

export default router;
