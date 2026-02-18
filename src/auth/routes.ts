import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../index';
import { jwtAuthMiddleware } from './jwtMiddleware';
import { logger } from '../utils/logger';
import { AppError } from '../utils/errorHandler';
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

    const normalizedSolanaAddress = solanaAddress.trim();
    const normalizedMovementAddress = movementAddress.trim().toLowerCase();

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
      where: { solanaAddress: normalizedSolanaAddress },
    });

    if (existingSolana) {
      throw new AppError('Solana address already registered', 409);
    }

    const existingMovement = await prisma.user.findUnique({
      where: { movementAddress: normalizedMovementAddress },
    });

    if (existingMovement) {
      throw new AppError('Movement address already registered', 409);
    }

    // Create new user
    const user = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const createdUser = await tx.user.create({
        data: {
          email,
          displayName: displayName || null,
          username: username || null,
          solanaAddress: normalizedSolanaAddress,
          movementAddress: normalizedMovementAddress,
        },
      });

      await tx.wallet.createMany({
        data: [
          {
            userId: createdUser.id,
            address: normalizedMovementAddress,
            blockchain: 'MOVEMENT',
            type: 'WEB3AUTH',
            walletClient: 'MOVEMENT_WEB3AUTH',
            isPrimary: true,
          },
          {
            userId: createdUser.id,
            address: normalizedSolanaAddress,
            blockchain: 'SOLANA',
            type: 'WEB3AUTH',
            walletClient: 'SOLANA_WEB3AUTH',
            isPrimary: false,
          },
        ],
      });

      return createdUser;
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
        voteBalance: user.voteBalance,
        avatarUrl: user.avatarUrl,
        bannerUrl: user.bannerUrl,
        bio: user.bio,
        phone: user.phone,
        country: user.country,
        dateOfBirth: user.dateOfBirth,
        clubs: user.clubs,
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

/**
 * PATCH /api/auth/me
 * Update current authenticated user profile
 */
router.patch('/me', jwtAuthMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      throw new AppError('User not authenticated', 401);
    }

    const {
      displayName,
      username,
      bio,
      phone,
      country,
      dateOfBirth,
      clubs,
      avatarUrl,
      bannerUrl,
    } = req.body || {};

    if (username) {
      const existing = await prisma.user.findUnique({ where: { username } });
      if (existing && existing.id !== userId) {
        throw new AppError('Username already taken', 409);
      }
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        displayName: typeof displayName === 'string' ? displayName : undefined,
        username: typeof username === 'string' ? username : undefined,
        bio: typeof bio === 'string' ? bio : undefined,
        phone: typeof phone === 'string' ? phone : undefined,
        country: typeof country === 'string' ? country : undefined,
        dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : undefined,
        clubs: Array.isArray(clubs) ? clubs : undefined,
        avatarUrl: typeof avatarUrl === 'string' ? avatarUrl : undefined,
        bannerUrl: typeof bannerUrl === 'string' ? bannerUrl : undefined,
      },
    });

    res.json({
      success: true,
      user: {
        id: updated.id,
        email: updated.email,
        displayName: updated.displayName,
        username: updated.username,
        solanaAddress: updated.solanaAddress,
        movementAddress: updated.movementAddress,
        avatarUrl: updated.avatarUrl,
        bannerUrl: updated.bannerUrl,
        bio: updated.bio,
        phone: updated.phone,
        country: updated.country,
        dateOfBirth: updated.dateOfBirth,
        clubs: updated.clubs,
      },
    });
  } catch (error) {
    logger.error('Update me error', { error });
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: 'Failed to update user' });
  }
});

export default router;
