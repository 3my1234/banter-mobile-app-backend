import { Router, Request, Response } from 'express';
import { prisma } from '../index';
import { logger } from '../utils/logger';
import { AppError } from '../utils/errorHandler';
import { syncMovementBalance, syncSolanaBalance } from './balanceIndexer';

const router = Router();

/**
 * GET /api/wallet/balances
 * Get all wallet balances for authenticated user
 */
router.get('/balances', async (req: Request, res: Response) => {
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

    // Format balances for frontend
    const balances: Record<string, unknown> = {
      ROL: { balance: '0', balanceUsd: null, decimals: 8 },
      SOL: { balance: '0', balanceUsd: null, decimals: 9 },
      USDC: { balance: '0', balanceUsd: null, decimals: 6 },
    };

    // Aggregate balances from all wallets
    for (const wallet of user.wallets) {
      for (const balance of wallet.walletBalances) {
        const symbol = balance.tokenSymbol.toUpperCase();
        if (symbol === 'ROL' || symbol === 'SOL' || symbol === 'USDC' || symbol === 'USDC.E') {
          const key = symbol === 'USDC.E' ? 'USDC' : symbol;
          const existingBalanceData = balances[key] as { balance: string; balanceUsd: number | null; decimals: number };
          const existingBalance = parseFloat(existingBalanceData.balance) || 0;
          const newBalance = parseFloat(balance.balance) || 0;
          balances[key] = {
            balance: (existingBalance + newBalance).toString(),
            balanceUsd: balance.balanceUsd,
            decimals: balance.decimals,
          };
        }
      }
    }

    res.json({
      success: true,
      balances,
      wallets: user.wallets.map((w: typeof user.wallets[0]) => ({
        id: w.id,
        address: w.address,
        blockchain: w.blockchain,
        balances: w.walletBalances,
      })),
    });
  } catch (error) {
    logger.error('Get balances error', { error });
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Failed to get balances', 500);
  }
});

/**
 * POST /api/wallet/sync/:walletId
 * Manually sync wallet balance
 */
router.post('/sync/:walletId', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    const walletId = req.params.walletId;

    if (!userId) {
      throw new AppError('User not authenticated', 401);
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new AppError('User not found', 404);
    }

    const wallet = await prisma.wallet.findUnique({
      where: { id: walletId },
    });

    if (!wallet || wallet.userId !== user.id) {
      throw new AppError('Wallet not found', 404);
    }

    // Sync balance based on blockchain
    if (wallet.blockchain === 'MOVEMENT') {
      await syncMovementBalance(wallet.id, wallet.address);
    } else if (wallet.blockchain === 'SOLANA') {
      await syncSolanaBalance(wallet.id, wallet.address);
    }

    // Get updated balances
    const updatedWallet = await prisma.wallet.findUnique({
      where: { id: walletId },
      include: {
        walletBalances: true,
      },
    });

    res.json({
      success: true,
      wallet: updatedWallet,
    });
  } catch (error) {
    logger.error('Sync wallet error', { error });
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Failed to sync wallet', 500);
  }
});

/**
 * GET /api/wallet/transactions
 * Get recent wallet transactions for authenticated user
 */
router.get('/transactions', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      throw new AppError('User not authenticated', 401);
    }

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const skip = (page - 1) * limit;

    const wallets = await prisma.wallet.findMany({
      where: { userId },
      select: { id: true },
    });

    const walletIds = wallets.map((w) => w.id);
    if (walletIds.length === 0) {
      return res.json({ success: true, transactions: [], pagination: { page, limit, total: 0, totalPages: 0 } });
    }

    const [transactions, total] = await Promise.all([
      prisma.walletTransaction.findMany({
        where: { walletId: { in: walletIds } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.walletTransaction.count({
        where: { walletId: { in: walletIds } },
      }),
    ]);

    return res.json({
      success: true,
      transactions,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    logger.error('Get transactions error', { error });
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Failed to get transactions', 500);
  }
});

export default router;
