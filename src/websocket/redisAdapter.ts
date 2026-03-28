import Redis from 'ioredis';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Server as SocketIOServer } from 'socket.io';
import { getRedisConfig } from '../queue/redisConfig';
import { logger } from '../utils/logger';

let pubClient: Redis | null = null;
let subClient: Redis | null = null;

function shouldEnableSocketRedisAdapter() {
  if (process.env.SOCKET_IO_REDIS_ENABLED === '0') {
    return false;
  }
  return Boolean(process.env.REDIS_URL || process.env.REDIS_HOST);
}

export async function setupSocketRedisAdapter(io: SocketIOServer) {
  if (!shouldEnableSocketRedisAdapter()) {
    logger.info('Socket.IO Redis adapter disabled');
    return false;
  }

  const redisConfig = getRedisConfig();
  try {
    pubClient = new Redis({
      ...redisConfig,
      lazyConnect: true,
      maxRetriesPerRequest: null,
    });
    subClient = pubClient.duplicate();

    await Promise.all([pubClient.connect(), subClient.connect()]);
    await Promise.all([pubClient.ping(), subClient.ping()]);

    io.adapter(createAdapter(pubClient, subClient));
    logger.info(`Socket.IO Redis adapter enabled on ${redisConfig.host}:${redisConfig.port}`);
    return true;
  } catch (error) {
    logger.warn('Socket.IO Redis adapter setup failed; continuing without cross-instance websocket fanout', {
      error,
      host: redisConfig.host,
      port: redisConfig.port,
    });

    if (pubClient) {
      await pubClient.quit().catch(() => undefined);
      pubClient = null;
    }
    if (subClient) {
      await subClient.quit().catch(() => undefined);
      subClient = null;
    }
    return false;
  }
}

export async function closeSocketRedisAdapter() {
  if (pubClient) {
    await pubClient.quit().catch(() => undefined);
    pubClient = null;
  }
  if (subClient) {
    await subClient.quit().catch(() => undefined);
    subClient = null;
  }
}
