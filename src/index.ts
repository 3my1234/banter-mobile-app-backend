import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { logger } from './utils/logger';
import { errorHandler } from './utils/errorHandler';
import { jwtAuthMiddleware } from './auth/jwtMiddleware';
import { setupWebSocket } from './websocket/socket';
import { setupQueueWorkers } from './queue/workers';
import authRoutes from './auth/routes';
import walletRoutes from './wallet/routes';
import postRoutes from './post/routes';
import voteRoutes from './vote/routes';
import imageRoutes from './image/routes';
import commentRoutes from './comment/routes';
import reactionRoutes from './reaction/routes';
import tagRoutes from './tag/routes';
import leagueRoutes from './league/routes';
import userRoutes from './user/routes';
import paymentRoutes from './payment/routes';
import mediaRoutes from './media/routes';
import opsRoutes from './ops/routes';
import notificationRoutes from './notification/routes';
import adminRoutes from './admin/routes';
import pcaRoutes from './pca/routes';

dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || process.env.API_URL || '*',
    methods: ['GET', 'POST'],
  },
});

// Initialize Prisma Client
export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

// Middleware
app.use(helmet());
const allowedOrigins = [
  process.env.FRONTEND_URL,
  process.env.ADMIN_FRONTEND_URL,
  process.env.API_URL,
  'http://localhost:19006',
  'http://localhost:8081',
  'http://localhost:5173',
].filter(Boolean) as string[];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  })
);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Privy OAuth redirect helper: bounce HTTPS callback to app deep link
const handlePrivyOAuthRedirect = (req: express.Request, res: express.Response) => {
  const params = new URLSearchParams(req.query as Record<string, string>);
  const query = params.toString();
  const target = `banterv3://oauth${query ? `?${query}` : ''}`;
  res.redirect(302, target);
};

app.get('/privy/oauth', handlePrivyOAuthRedirect);
app.get('/oauth', handlePrivyOAuthRedirect);

// Health check (root)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Health check (explicit route for debugging)
app.get('/api/health', (_req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV 
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/wallet', jwtAuthMiddleware, walletRoutes);
app.use('/api/posts', jwtAuthMiddleware, postRoutes);
app.use('/api/votes', jwtAuthMiddleware, voteRoutes);
app.use('/api/images', jwtAuthMiddleware, imageRoutes);
app.use('/api/comments', jwtAuthMiddleware, commentRoutes);
app.use('/api/reactions', jwtAuthMiddleware, reactionRoutes);
// Public health/debug endpoints for payments (no auth)
app.use('/api/public/payments', paymentRoutes);
// Authenticated payments
app.use('/api/payments', jwtAuthMiddleware, paymentRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/ops', opsRoutes);
app.use('/api/tags', tagRoutes); // Public endpoint
app.use('/api/leagues', leagueRoutes); // Public endpoint
app.use('/api/users', jwtAuthMiddleware, userRoutes);
app.use('/api/notifications', jwtAuthMiddleware, notificationRoutes);
app.use('/api/pca', jwtAuthMiddleware, pcaRoutes);
app.use('/api/admin', adminRoutes);

// Error handling
app.use(errorHandler);

// Setup WebSocket
setupWebSocket(io);

// Setup Queue Workers
setupQueueWorkers();

// Start server
const PORT = process.env.PORT || 3001;

httpServer.listen(PORT, () => {
  logger.info(`🚀 Banter Backend Server running on port ${PORT}`);
  logger.info(`📡 Environment: ${process.env.NODE_ENV || 'development'}`);
  logger.info(`🌐 Domain: ${process.env.DOMAIN || 'localhost'}`);
  logger.info(`🔗 API URL: ${process.env.API_URL || `http://localhost:${PORT}`}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  await prisma.$disconnect();
  httpServer.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully...');
  await prisma.$disconnect();
  httpServer.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});
