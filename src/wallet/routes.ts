import { Router, Request, Response } from 'express';
import { prisma } from '../index';
import { logger } from '../utils/logger';
import { AppError } from '../utils/errorHandler';
import { syncMovementBalance, syncSolanaBalance } from './balanceIndexer';
import axios from 'axios';

const router = Router();
const MOVEMENT_INDEXER_URL = process.env.MOVEMENT_INDEXER_URL || 'https://indexer.testnet.movementnetwork.xyz/v1/graphql';
const MOVEMENT_TESTNET_RPC = process.env.MOVEMENT_TESTNET_RPC || 'https://testnet.movementnetwork.xyz/v1';
const MOVEMENT_USDC_ADDRESS = (process.env.MOVEMENT_USDC_ADDRESS || '').trim().replace(/[>\s]+$/g, '');

async function fetchMovementUSDCHistory(walletAddress: string): Promise<any[]> {
  if (!MOVEMENT_USDC_ADDRESS) return [];
  const query = {
    query: `
      query GetUserUSDCHistory($owner: String!, $assetType: String!) {
        fungible_asset_activities(
          where: {
            owner_address: { _eq: $owner },
            asset_type: { _eq: $assetType }
          }
          order_by: { transaction_timestamp: desc }
          limit: 25
        ) {
          transaction_version
          amount
          type
          transaction_timestamp
        }
      }
    `,
    variables: {
      owner: walletAddress.toLowerCase(),
      assetType: MOVEMENT_USDC_ADDRESS.toLowerCase(),
    },
  };

  try {
    const response = await axios.post(MOVEMENT_INDEXER_URL, query, { timeout: 10000 });
    if (response.data?.errors) {
      logger.warn('Movement indexer errors', { errors: response.data.errors });
      return [];
    }

    const activities = response.data?.data?.fungible_asset_activities || [];
    const detailed: any[] = [];

    for (const activity of activities) {
      try {
        const txRes = await axios.get(
          `${MOVEMENT_TESTNET_RPC}/transactions/by_version/${activity.transaction_version}`
        );
        if (txRes.data?.hash) {
          detailed.push({
            ...activity,
            transaction_hash: txRes.data.hash,
            requestor_address: txRes.data.sender || walletAddress,
          });
        }
      } catch {
        // ignore individual failures
      }
    }

    return detailed;
  } catch (error) {
    logger.warn('Failed to fetch Movement USDC history', { error });
    return [];
  }
}

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

    return res.json({
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
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    return res.status(500).json({ success: false, message: 'Failed to get balances' });
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

    return res.json({
      success: true,
      wallet: updatedWallet,
    });
  } catch (error) {
    logger.error('Sync wallet error', { error });
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    return res.status(500).json({ success: false, message: 'Failed to sync wallet' });
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

    const includeIndexer = req.query.includeIndexer === '1';

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

    let indexerTransactions: any[] = [];
    if (includeIndexer) {
      const movementWallets = await prisma.wallet.findMany({
        where: { userId, blockchain: 'MOVEMENT' },
      });
      for (const wallet of movementWallets) {
        const activities = await fetchMovementUSDCHistory(wallet.address);
        indexerTransactions = indexerTransactions.concat(
          activities.map((activity: any) => ({
            id: `idx-${activity.transaction_version}`,
            txHash: activity.transaction_hash || `v-${activity.transaction_version}`,
            txType: (activity.type || 'TRANSFER').toUpperCase(),
            amount: activity.amount?.toString() || '0',
            tokenAddress: MOVEMENT_USDC_ADDRESS,
            tokenSymbol: 'USDC.e',
            fromAddress: activity.type?.toUpperCase().includes('DEPOSIT')
              ? activity.requestor_address
              : wallet.address,
            toAddress: activity.type?.toUpperCase().includes('DEPOSIT')
              ? wallet.address
              : activity.requestor_address,
            status: 'COMPLETED',
            createdAt: activity.transaction_timestamp,
            source: 'indexer',
          }))
        );
      }
    }

    return res.json({
      success: true,
      transactions: includeIndexer ? [...indexerTransactions, ...transactions] : transactions,
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
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    return res.status(500).json({ success: false, message: 'Failed to get transactions' });
  }
});

export default router;
