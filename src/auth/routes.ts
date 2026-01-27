import { Router, Request, Response } from 'express';
import { prisma } from '../index';
import { privyAuthMiddleware, PrivyUser } from './privyAuth';
import { logger } from '../utils/logger';
import { AppError } from '../utils/errorHandler';
import { createMovementWallet, createSolanaWallet } from '../wallet/walletService';

const router = Router();

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
    const movementWallet = await createMovementWallet(user.id, privyUser);
    const solanaWallet = await createSolanaWallet(user.id, privyUser);

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
router.get('/me', privyAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const privyDid = req.privyDid;
    if (!privyDid) {
      throw new AppError('User not authenticated', 401);
    }

    const user = await prisma.user.findUnique({
      where: { privyDid },
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
        privyDid: user.privyDid,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
        bio: user.bio,
        wallets: user.wallets,
      },
    });
  } catch (error) {
    logger.error('Get me error', { error });
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Failed to get user', 500);
  }
});

export default router;
