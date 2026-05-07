import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import { randomUUID } from 'crypto';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { logger } from './utils/logger';
import { errorHandler } from './utils/errorHandler';
import { jwtAuthMiddleware } from './auth/jwtMiddleware';
import { setupWebSocket } from './websocket/socket';
import { closeSocketRedisAdapter, setupSocketRedisAdapter } from './websocket/redisAdapter';
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
import pointsRoutes from './points/routes';
import adsRoutes from './ads/routes';
import messageRoutes from './message/routes';
import { buildPrismaDatasourceUrl, getPerformanceConfig } from './config/performance';

dotenv.config();

const app = express();
const httpServer = createServer(app);
const performance = getPerformanceConfig();
const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || process.env.API_URL || '*',
    methods: ['GET', 'POST'],
  },
});

// Initialize Prisma Client
const prismaDatasourceUrl = buildPrismaDatasourceUrl();
const prismaConfig: ConstructorParameters<typeof PrismaClient>[0] = {
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
};
if (prismaDatasourceUrl) {
  prismaConfig.datasources = {
    db: { url: prismaDatasourceUrl },
  };
}
export const prisma = new PrismaClient(prismaConfig);

// Middleware
app.use(helmet());
app.set('trust proxy', 1);

const apiLimiter = rateLimit({
  windowMs: performance.apiRateLimitWindowMs,
  max: performance.apiRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/health' || req.path === '/api/health',
});
const authLimiter = rateLimit({
  windowMs: performance.authRateLimitWindowMs,
  max: performance.authRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});
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
app.use('/api', apiLimiter);
app.use('/api/auth/privy/verify', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use((req, res, next) => {
  const start = Date.now();
  const requestId = randomUUID();
  const instanceName = process.env.SERVICE_NAME || 'banter-mobile-app-backend';

  res.setHeader('x-request-id', requestId);
  res.setHeader('x-api-instance', instanceName);

  res.on('finish', () => {
    logger.info('http_request', {
      requestId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - start,
      origin: req.headers.origin || null,
      userAgent: req.headers['user-agent'] || null,
      ip: req.ip,
    });
  });

  next();
});

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
// Public image/video view redirects (no auth headers required by RN Image/Video components)
app.use('/api/public/images', imageRoutes);
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
app.use('/api/ads', adsRoutes); // Public ad settings + campaigns
app.use('/api/users', jwtAuthMiddleware, userRoutes);
app.use('/api/notifications', jwtAuthMiddleware, notificationRoutes);
app.use('/api/messages', jwtAuthMiddleware, messageRoutes);
app.use('/api/pca', jwtAuthMiddleware, pcaRoutes);
app.use('/api/rewards', jwtAuthMiddleware, pointsRoutes);
app.use('/api/admin', adminRoutes);

// Error handling
app.use(errorHandler);

function shouldRunQueueWorkers() {
  const appRole = (process.env.APP_ROLE || 'all').trim().toLowerCase();
  if (appRole === 'api') return false;
  return process.env.RUN_QUEUE_WORKERS !== '0' && process.env.DISABLE_BACKGROUND_QUEUE !== '1';
}

async function bootstrap() {
  await setupSocketRedisAdapter(io);
  setupWebSocket(io);

  if (shouldRunQueueWorkers()) {
    await setupQueueWorkers();
  } else {
    logger.info('Queue workers disabled via RUN_QUEUE_WORKERS=0 or DISABLE_BACKGROUND_QUEUE=1');
  }

  const PORT = process.env.PORT || 3001;
  httpServer.listen(PORT, () => {
    logger.info(`🚀 Banter Backend Server running on port ${PORT}`);
    logger.info(`📡 Environment: ${process.env.NODE_ENV || 'development'}`);
    logger.info(`🌐 Domain: ${process.env.DOMAIN || 'localhost'}`);
    logger.info(`🔗 API URL: ${process.env.API_URL || `http://localhost:${PORT}`}`);
    logger.info(`🧵 Queue workers: ${shouldRunQueueWorkers() ? 'enabled' : 'disabled'}`);
    logger.info(`⚙️ DB pool: limit=${performance.dbConnectionLimit}, timeout=${performance.dbPoolTimeoutSeconds}s, pgbouncer=${performance.dbUsePgBouncer ? 'on' : 'off'}`);
    logger.info(`🛡️ Rate limits: api=${performance.apiRateLimitMax}/${Math.round(performance.apiRateLimitWindowMs / 1000)}s, auth=${performance.authRateLimitMax}/${Math.round(performance.authRateLimitWindowMs / 1000)}s`);
  });
}

void bootstrap().catch(async (error) => {
  logger.error('Failed to bootstrap backend', { error });
  await closeSocketRedisAdapter().catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  await closeSocketRedisAdapter().catch(() => undefined);
  await prisma.$disconnect();
  httpServer.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully...');
  await closeSocketRedisAdapter().catch(() => undefined);
  await prisma.$disconnect();
  httpServer.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});
