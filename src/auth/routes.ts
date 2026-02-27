import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../index';
import { jwtAuthMiddleware } from './jwtMiddleware';
import { logger } from '../utils/logger';
import { AppError } from '../utils/errorHandler';
import { generateToken } from './jwt';
import { PrivyClient } from '@privy-io/server-auth';
import { createNotification } from '../notification/service';

const router = Router();
const privyClient = new PrivyClient(
  process.env.PRIVY_APP_ID || '',
  process.env.PRIVY_APP_SECRET || ''
);
const DAILY_ROL_REWARD_RAW = BigInt(10000); // 0.0001 ROL (8 decimals)

const getLocalDayStart = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate());

const getLocalDayKey = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const mapPrivyWallets = (linkedAccounts: any[] = []) => {
  const wallets: Array<{
    address: string;
    blockchain: 'MOVEMENT' | 'SOLANA';
    type: string;
    walletClient: string;
  }> = [];
  const added = new Set<string>();

  for (const account of linkedAccounts) {
    const rawAddress = (account?.address || '').trim();
    if (!rawAddress) continue;
    const chainTypeRaw = account?.chainType || account?.chain_type || '';
    const chainType = String(chainTypeRaw).toLowerCase();
    let blockchain: 'MOVEMENT' | 'SOLANA' | null = null;

    if (chainType.includes('aptos') || chainType.includes('movement')) {
      blockchain = 'MOVEMENT';
    } else if (chainType.includes('solana')) {
      blockchain = 'SOLANA';
    }

    if (!blockchain) continue;
    const address = blockchain === 'MOVEMENT' ? rawAddress.toLowerCase() : rawAddress;
    const key = `${address}-${blockchain}`;
    if (added.has(key)) continue;
    added.add(key);

    const connectorType = account?.connectorType || account?.connector_type || '';
    const walletClientType =
      account?.walletClientType ||
      account?.walletClient ||
      account?.wallet_client ||
      '';

    const type =
      connectorType === 'embedded'
        ? 'PRIVY_EMBEDDED'
        : connectorType === 'smart_wallet'
        ? 'PRIVY_SMART_WALLET'
        : 'PRIVY_EXTERNAL';
    const walletClient = walletClientType ? walletClientType.toLowerCase() : 'privy';

    wallets.push({
      address,
      blockchain,
      type,
      walletClient,
    });
  }

  return wallets;
};

const pickPrimaryWalletsByChain = (
  wallets: Array<{
    address: string;
    blockchain: 'MOVEMENT' | 'SOLANA';
    type: string;
    walletClient: string;
  }>
) => {
  const rank = (wallet: { type: string }) => {
    if (wallet.type === 'PRIVY_EMBEDDED') return 0;
    if (wallet.type === 'PRIVY_SMART_WALLET') return 1;
    return 2;
  };

  const pickForChain = (blockchain: 'MOVEMENT' | 'SOLANA') => {
    const options = wallets.filter((wallet) => wallet.blockchain === blockchain);
    if (options.length === 0) return null;
    options.sort((a, b) => rank(a) - rank(b));
    return options[0];
  };

  return {
    movement: pickForChain('MOVEMENT'),
    solana: pickForChain('SOLANA'),
  };
};

const resolvePrivyEmail = (privyUser: any, linkedAccounts: any[] = []) => {
  const directEmail = privyUser?.email?.address || privyUser?.email || '';
  if (typeof directEmail === 'string' && directEmail.includes('@')) {
    return directEmail.trim().toLowerCase();
  }

  const linkedEmail = linkedAccounts.find((account: any) => {
    const email = account?.email;
    return typeof email === 'string' && email.includes('@');
  })?.email;

  if (typeof linkedEmail === 'string' && linkedEmail.includes('@')) {
    return linkedEmail.trim().toLowerCase();
  }

  return null;
};

/**
 * POST /api/auth/privy/verify
 * Verify Privy token, sync wallets, return JWT
 * Request: { privyToken: string }
 */
router.post('/privy/verify', async (req: Request, res: Response): Promise<void> => {
  try {
    const { privyToken } = req.body || {};
    if (!privyToken || typeof privyToken !== 'string') {
      throw new AppError('Privy token is required', 400);
    }

    if (!process.env.PRIVY_APP_ID || !process.env.PRIVY_APP_SECRET) {
      throw new AppError('Privy credentials not configured', 500);
    }

    const claims = await privyClient.verifyAuthToken(privyToken);
    const privyUser = await privyClient.getUserById((claims as any).userId);

    const linkedAccounts =
      (privyUser as any)?.linkedAccounts ||
      (privyUser as any)?.linked_accounts ||
      [];
    const email = resolvePrivyEmail(privyUser, linkedAccounts);
    if (!email) {
      throw new AppError('Privy email not available', 400);
    }

    const displayName =
      (privyUser as any)?.name ||
      (privyUser as any)?.displayName ||
      (privyUser as any)?.google?.name ||
      null;

    const mappedWallets = mapPrivyWallets(linkedAccounts);
    const selectedWallets = pickPrimaryWalletsByChain(mappedWallets);
    const movementWallet = selectedWallets.movement || undefined;
    const solanaWallet = selectedWallets.solana || undefined;

    const now = new Date();
    const localDayStart = getLocalDayStart(now);
    const dayKey = getLocalDayKey(now);
    let dailyRolAwarded = false;

    const user = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const syncedUser = await tx.user.upsert({
        where: { email },
        create: {
          email,
          displayName: displayName || null,
          movementAddress: movementWallet?.address || null,
          solanaAddress: solanaWallet?.address || null,
        },
        update: {
          ...(displayName ? { displayName } : {}),
          movementAddress: movementWallet?.address || null,
          solanaAddress: solanaWallet?.address || null,
        },
      });

      // Reconcile SOLANA wallet strictly to current Privy state (single wallet per chain).
      if (solanaWallet) {
        // Delete first, then recreate to avoid unique conflicts from stale duplicates.
        await tx.wallet.deleteMany({
          where: { userId: syncedUser.id, blockchain: 'SOLANA' },
        });
        await tx.wallet.create({
          data: {
            userId: syncedUser.id,
            address: solanaWallet.address,
            blockchain: 'SOLANA',
            type: solanaWallet.type,
            walletClient: solanaWallet.walletClient,
            isPrimary: false,
          },
        });
      }

      // Reconcile MOVEMENT wallet strictly to current Privy state (single wallet per chain).
      await tx.wallet.deleteMany({
        where: { userId: syncedUser.id, blockchain: 'MOVEMENT' },
      });
      if (movementWallet) {
        await tx.wallet.create({
          data: {
            userId: syncedUser.id,
            address: movementWallet.address,
            blockchain: 'MOVEMENT',
            type: movementWallet.type,
            walletClient: movementWallet.walletClient,
            isPrimary: false,
          },
        });
      }

      const rewardUpdate = await tx.user.updateMany({
        where: {
          id: syncedUser.id,
          OR: [{ lastDailyRolAt: null }, { lastDailyRolAt: { lt: localDayStart } }],
        },
        data: {
          lastDailyRolAt: now,
          rolBalanceRaw: {
            increment: DAILY_ROL_REWARD_RAW,
          },
        },
      });
      dailyRolAwarded = rewardUpdate.count > 0;
      logger.info('Daily ROL check (privy verify)', {
        userId: syncedUser.id,
        awarded: dailyRolAwarded,
        localDayStart: localDayStart.toISOString(),
      });

      return syncedUser;
    });

    if (dailyRolAwarded) {
      await createNotification({
        userId: user.id,
        type: 'DAILY_ROL',
        title: 'Daily ROL received',
        body: 'You received 0.0001 ROL for today login.',
        data: {
          amountRaw: DAILY_ROL_REWARD_RAW.toString(),
          amountDisplay: '0.0001',
        },
        reference: `daily_rol:${user.id}:${dayKey}`,
      });
    }

    const refreshedUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: {
        id: true,
        email: true,
        displayName: true,
        movementAddress: true,
        solanaAddress: true,
        rolBalanceRaw: true,
        lastDailyRolAt: true,
      },
    });

    if (!refreshedUser) {
      throw new AppError('User not found after Privy sync', 500);
    }

    const token = generateToken(user.id, user.email || '');
    res.json({
      token,
      user: {
        id: refreshedUser.id,
        email: refreshedUser.email,
        displayName: refreshedUser.displayName,
        movementAddress: refreshedUser.movementAddress,
        solanaAddress: refreshedUser.solanaAddress,
        rolBalanceRaw: refreshedUser.rolBalanceRaw.toString(),
        lastDailyRolAt: refreshedUser.lastDailyRolAt,
      },
    });
  } catch (error) {
    logger.error('Privy verify error', { error });
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: 'Failed to verify privy token' });
  }
});

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

    const now = new Date();
    const localDayStart = getLocalDayStart(now);
    const dayKey = getLocalDayKey(now);
    const rewardUpdate = await prisma.user.updateMany({
      where: {
        id: user.id,
        OR: [{ lastDailyRolAt: null }, { lastDailyRolAt: { lt: localDayStart } }],
      },
      data: {
        lastDailyRolAt: now,
        rolBalanceRaw: {
          increment: DAILY_ROL_REWARD_RAW,
        },
      },
    });
    logger.info('Daily ROL check (login)', {
      userId: user.id,
      awarded: rewardUpdate.count > 0,
      localDayStart: localDayStart.toISOString(),
    });
    if (rewardUpdate.count > 0) {
      await createNotification({
        userId: user.id,
        type: 'DAILY_ROL',
        title: 'Daily ROL received',
        body: 'You received 0.0001 ROL for today login.',
        data: {
          amountRaw: DAILY_ROL_REWARD_RAW.toString(),
          amountDisplay: '0.0001',
        },
        reference: `daily_rol:${user.id}:${dayKey}`,
      });
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

    const now = new Date();
    const localDayStart = getLocalDayStart(now);
    const dayKey = getLocalDayKey(now);
    const rewardUpdate = await prisma.user.updateMany({
      where: {
        id: user.id,
        OR: [{ lastDailyRolAt: null }, { lastDailyRolAt: { lt: localDayStart } }],
      },
      data: {
        lastDailyRolAt: now,
        rolBalanceRaw: {
          increment: DAILY_ROL_REWARD_RAW,
        },
      },
    });
    logger.info('Daily ROL check (/me)', {
      userId: user.id,
      awarded: rewardUpdate.count > 0,
      localDayStart: localDayStart.toISOString(),
      previousRolRaw: user.rolBalanceRaw.toString(),
    });

    let effectiveRolBalanceRaw = user.rolBalanceRaw;
    let effectiveLastDailyRolAt = user.lastDailyRolAt;

    if (rewardUpdate.count > 0) {
      effectiveRolBalanceRaw = user.rolBalanceRaw + DAILY_ROL_REWARD_RAW;
      effectiveLastDailyRolAt = now;
      await createNotification({
        userId: user.id,
        type: 'DAILY_ROL',
        title: 'Daily ROL received',
        body: 'You received 0.0001 ROL for today login.',
        data: {
          amountRaw: DAILY_ROL_REWARD_RAW.toString(),
          amountDisplay: '0.0001',
        },
        reference: `daily_rol:${user.id}:${dayKey}`,
      });
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
        rolBalanceRaw: effectiveRolBalanceRaw.toString(),
        lastDailyRolAt: effectiveLastDailyRolAt,
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
