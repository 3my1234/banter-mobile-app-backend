import axios from 'axios';
import { prisma } from '../index';
import { logger } from '../utils/logger';

const EXPO_PUSH_API_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_PUSH_TOKEN_RE = /^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/;

const normalizeToken = (input: string) => input.trim();

const isExpoPushToken = (token: string) => EXPO_PUSH_TOKEN_RE.test(token);

export const registerPushToken = async (params: {
  userId: string;
  token: string;
  platform?: string;
  appVersion?: string;
}) => {
  const token = normalizeToken(params.token);
  if (!isExpoPushToken(token)) {
    throw new Error('Invalid Expo push token');
  }

  const now = new Date();
  return prisma.devicePushToken.upsert({
    where: { token },
    update: {
      userId: params.userId,
      platform: params.platform || null,
      appVersion: params.appVersion || null,
      active: true,
      lastSeenAt: now,
    },
    create: {
      userId: params.userId,
      token,
      platform: params.platform || null,
      appVersion: params.appVersion || null,
      active: true,
      lastSeenAt: now,
    },
  });
};

export const unregisterPushToken = async (params: {
  userId: string;
  token?: string;
}) => {
  const token = params.token ? normalizeToken(params.token) : '';
  if (token) {
    await prisma.devicePushToken.updateMany({
      where: {
        userId: params.userId,
        token,
      },
      data: {
        active: false,
        lastSeenAt: new Date(),
      },
    });
    return;
  }

  await prisma.devicePushToken.updateMany({
    where: {
      userId: params.userId,
      active: true,
    },
    data: {
      active: false,
      lastSeenAt: new Date(),
    },
  });
};

const buildExpoHeaders = () => {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  const accessToken = (process.env.EXPO_ACCESS_TOKEN || '').trim();
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  return headers;
};

export const sendPushToUser = async (params: {
  userId: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}) => {
  const tokens = await prisma.devicePushToken.findMany({
    where: {
      userId: params.userId,
      active: true,
    },
    select: {
      id: true,
      token: true,
    },
    take: 20,
  });

  if (!tokens.length) {
    return;
  }

  const messages = tokens.map((tokenRecord) => ({
    to: tokenRecord.token,
    sound: 'default',
    title: params.title,
    body: params.body,
    data: params.data || {},
    priority: 'high',
    channelId: 'default',
  }));

  try {
    const response = await axios.post(EXPO_PUSH_API_URL, messages, {
      headers: buildExpoHeaders(),
      timeout: 12000,
    });
    const results = Array.isArray(response.data?.data) ? response.data.data : [];
    if (!results.length) {
      return;
    }

    const invalidIds: string[] = [];
    results.forEach((result: any, index: number) => {
      if (result?.status !== 'error') return;
      const errorCode = result?.details?.error;
      if (errorCode === 'DeviceNotRegistered') {
        const tokenRecord = tokens[index];
        if (tokenRecord?.id) invalidIds.push(tokenRecord.id);
      } else {
        logger.warn('Expo push send returned error', {
          userId: params.userId,
          errorCode,
          details: result?.details,
        });
      }
    });

    if (invalidIds.length) {
      await prisma.devicePushToken.updateMany({
        where: { id: { in: invalidIds } },
        data: { active: false, lastSeenAt: new Date() },
      });
    }
  } catch (error) {
    logger.warn('Expo push send failed', {
      userId: params.userId,
      error,
    });
  }
};
