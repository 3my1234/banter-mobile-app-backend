import { Server as SocketIOServer } from 'socket.io';
import { logger } from '../utils/logger';

let ioInstance: SocketIOServer | null = null;

/**
 * Setup WebSocket server for real-time updates
 */
export function setupWebSocket(io: SocketIOServer): void {
  ioInstance = io;

  ioInstance.on('connection', (socket) => {
    logger.info(`Client connected: ${socket.id}`);

    // Join room for a specific post
    socket.on('join-post', (postId: string) => {
      socket.join(`post:${postId}`);
      logger.debug(`Client ${socket.id} joined post room: ${postId}`);
    });

    // Leave post room
    socket.on('leave-post', (postId: string) => {
      socket.leave(`post:${postId}`);
      logger.debug(`Client ${socket.id} left post room: ${postId}`);
    });

    socket.on('disconnect', () => {
      logger.info(`Client disconnected: ${socket.id}`);
    });
  });

  logger.info('✅ WebSocket server initialized');
  logger.info(`📡 Domain: ${process.env.DOMAIN || 'localhost'}`);
}

/**
 * Get Socket.IO instance
 */
export function getIO(): SocketIOServer {
  if (!ioInstance) {
    throw new Error('Socket.IO not initialized. Call setupWebSocket first.');
  }
  return ioInstance;
}

// Export function to get io instance
export function io(): SocketIOServer {
  return getIO();
}
