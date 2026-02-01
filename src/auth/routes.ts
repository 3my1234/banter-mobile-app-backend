import { Router, Request, Response } from 'express';
import { prisma } from '../index';
import { privyAuthMiddleware, PrivyUser } from './privyAuth';
import { jwtAuthMiddleware } from './jwtMiddleware';
import { logger } from '../utils/logger';
import { AppError } from '../utils/errorHandler';
import { createMovementWallet, createSolanaWallet } from '../wallet/walletService';
import { generateToken } from './jwt';

const router = Router();

/**
 * POST /api/auth/check
 * Check if a user exists by email
 * Request: { email: string }
 * Response: { exists: boolean, token?: string }
 */
router.post('/check', async (req: Request, res: Response): Promise<void> => {
  try {
    const { email } = req.body;

    if (!email || typeof email !== 'string') {
      throw new AppError('Email is required', 400);
    }

    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (user) {
      // User exists, generate token for immediate login
      const token = generateToken(user.id, user.email || '');
      res.json({
        exists: true,
        token,
      });
    } else {
      // User does not exist
      res.json({
        exists: false,
      });
    }
  } catch (error) {
    logger.error('Auth check error', { error });
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: 'Failed to check user' });
  }
});

/**
 * POST /api/auth/login
 * Login an existing user
 * Request: { email: string }
 * Response: { token: string }
 */
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  try {
    const { email } = req.body;

    if (!email || typeof email !== 'string') {
      throw new AppError('Email is required', 400);
    }

    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      throw new AppError('User not found', 404);
    }

    const token = generateToken(user.id, user.email || '');
    
    res.json({
      token,
    });
  } catch (error) {
    logger.error('Auth login error', { error });
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: 'Failed to login user' });
  }
});

/**
 * POST /api/auth/register
 * Register a new user
 * Request: { email: string, displayName?: string, username?: string, solanaAddress: string, movementAddress: string }
 * Response: { token: string }
 */
router.post('/register', async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, displayName, username, solanaAddress, movementAddress } = req.body;

    if (!email || typeof email !== 'string') {
      throw new AppError('Email is required', 400);
    }

    if (!solanaAddress || typeof solanaAddress !== 'string') {
      throw new AppError('Solana address is required', 400);
    }

    if (!movementAddress || typeof movementAddress !== 'string') {
      throw new AppError('Movement address is required', 400);
    }

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      throw new AppError('User already exists', 409);
    }

    // Check if username is taken (if provided)
    if (username) {
      const existingUsername = await prisma.user.findUnique({
        where: { username },
      });

      if (existingUsername) {
        throw new AppError('Username already taken', 409);
      }
    }

    // Check if addresses are already in use
    const existingSolana = await prisma.user.findUnique({
      where: { solanaAddress },
    });

    if (existingSolana) {
      throw new AppError('Solana address already registered', 409);
    }

    const existingMovement = await prisma.user.findUnique({
      where: { movementAddress },
    });

    if (existingMovement) {
      throw new AppError('Movement address already registered', 409);
    }

    // Create new user
    const user = await prisma.user.create({
      data: {
        email,
        displayName: displayName || null,
        username: username || null,
        solanaAddress,
        movementAddress,
      },
    });

    logger.info(`Created new user: ${user.id}`);

    // Generate token
    const token = generateToken(user.id, user.email || '');

    res.json({
      token,
    });
  } catch (error) {
    logger.error('Auth register error', { error });
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: 'Failed to register user' });
  }
});

/**
 * POST /api/auth/sync
 * Sync user from Privy and ensure wallets exist
 * This is called after user logs in via Privy
 */
router.post('/sync', privyAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const privyUser = req.user as PrivyUser;
    if (!privyUser || !privyUser.id) {
      throw new AppError('Invalid user data', 400);
    }

    const privyDid = privyUser.id;
    const email = privyUser.email || null;

    logger.info(`Syncing user: ${privyDid}`);

    // Find or create user in database
    let user = await prisma.user.findUnique({
      where: { privyDid },
    });

    if (!user) {
      // Create new user
      user = await prisma.user.create({
        data: {
          privyDid,
          privyUserId: privyUser.userId,
          email,
          name: privyUser.email?.split('@')[0] || null,
        },
      });
      logger.info(`Created new user: ${user.id}`);
    } else {
      // Update last login info
      await prisma.user.update({
        where: { id: user.id },
        data: {
          privyUserId: privyUser.userId,
          email: email || user.email,
          updatedAt: new Date(),
        },
      });
    }

    // Ensure wallets exist (idempotent)
    await createMovementWallet(user.id, privyUser);
    await createSolanaWallet(user.id, privyUser);

    // Get user with wallets
    const userWithWallets = await prisma.user.findUnique({
      where: { id: user.id },
      include: {
        wallets: {
          include: {
            walletBalances: {
              orderBy: { lastUpdated: 'desc' },
              take: 10, // Latest 10 balances
            },
          },
        },
      },
    });

    res.json({
      success: true,
      user: {
        id: userWithWallets?.id,
        privyDid: userWithWallets?.privyDid,
        email: userWithWallets?.email,
        name: userWithWallets?.name,
        avatarUrl: userWithWallets?.avatarUrl,
        wallets: userWithWallets?.wallets || [],
      },
    });
  } catch (error) {
    logger.error('Auth sync error', { error });
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Failed to sync user', 500);
  }
});

/**
 * GET /api/auth/me
 * Get current authenticated user
 */
router.get('/me', jwtAuthMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      throw new AppError('User not authenticated', 401);
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        wallets: {
          include: {
            walletBalances: {
              orderBy: { lastUpdated: 'desc' },
            },
          },
        },
      },
    });

    if (!user) {
      throw new AppError('User not found', 404);
    }

    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        username: user.username,
        solanaAddress: user.solanaAddress,
        movementAddress: user.movementAddress,
        avatarUrl: user.avatarUrl,
        bio: user.bio,
        wallets: user.wallets,
      },
    });
  } catch (error) {
    logger.error('Get me error', { error });
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: 'Failed to get user' });
  }
});

export default router;
