import { Server as SocketIOServer, Socket } from 'socket.io';
import { verifyToken } from '../auth/jwt';
import { logger } from '../utils/logger';

let ioInstance: SocketIOServer | null = null;
const buildUserRoom = (userId: string) => `user:${userId}`;

const extractToken = (socket: Socket) => {
  const authToken =
    typeof socket.handshake.auth?.token === 'string'
      ? socket.handshake.auth.token
      : '';
  const headerAuth =
    typeof socket.handshake.headers?.authorization === 'string'
      ? socket.handshake.headers.authorization
      : '';
  return (authToken || headerAuth).replace(/^Bearer\s+/i, '').trim();
};

/**
 * Setup WebSocket server for real-time updates.
 */
export function setupWebSocket(io: SocketIOServer): void {
  ioInstance = io;

  ioInstance.use((socket, next) => {
    try {
      const token = extractToken(socket);
      if (!token) {
        return next();
      }
      const payload = verifyToken(token);
      socket.data.userId = payload.userId;
      return next();
    } catch (error) {
      logger.warn('Socket auth failed', { error });
      return next(new Error('Unauthorized'));
    }
  });

  ioInstance.on('connection', (socket) => {
    logger.info(`Client connected: ${socket.id}`);

    if (socket.data.userId) {
      socket.join(buildUserRoom(socket.data.userId));
      socket.emit('notifications.subscribed', { userId: socket.data.userId });
    }

    socket.on('notifications.subscribe', (payload?: { token?: string }) => {
      try {
        const token = (payload?.token || '').replace(/^Bearer\s+/i, '');
        const resolvedUserId = socket.data.userId || (token ? verifyToken(token).userId : '');
        if (!resolvedUserId) {
          socket.emit('notifications.error', { message: 'Missing auth token' });
          return;
        }
        socket.data.userId = resolvedUserId;
        socket.join(buildUserRoom(resolvedUserId));
        socket.emit('notifications.subscribed', { userId: resolvedUserId });
      } catch {
        socket.emit('notifications.error', { message: 'Invalid auth token' });
      }
    });

    socket.on('join-post', (postId: string) => {
      socket.join(`post:${postId}`);
      logger.debug(`Client ${socket.id} joined post room: ${postId}`);
    });

    socket.on('leave-post', (postId: string) => {
      socket.leave(`post:${postId}`);
      logger.debug(`Client ${socket.id} left post room: ${postId}`);
    });

    socket.on('disconnect', () => {
      logger.info(`Client disconnected: ${socket.id}`);
    });
  });

  logger.info('WebSocket server initialized');
  logger.info(`WebSocket domain: ${process.env.DOMAIN || 'localhost'}`);
}

/**
 * Get Socket.IO instance.
 */
export function getIO(): SocketIOServer {
  if (!ioInstance) {
    throw new Error('Socket.IO not initialized. Call setupWebSocket first.');
  }
  return ioInstance;
}

export function io(): SocketIOServer {
  return getIO();
}
