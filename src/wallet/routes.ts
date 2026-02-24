import { Router, Request, Response } from 'express';
import { prisma } from '../index';
import { logger } from '../utils/logger';
import { AppError } from '../utils/errorHandler';
import { syncMovementBalance, syncSolanaBalance } from './balanceIndexer';
import axios from 'axios';

const router = Router();
const MOVEMENT_INDEXER_URL = process.env.MOVEMENT_INDEXER_URL || 'https://indexer.testnet.movementnetwork.xyz/v1/graphql';
const MOVEMENT_TESTNET_RPC = process.env.MOVEMENT_TESTNET_RPC || 'https://testnet.movementnetwork.xyz/v1';
const MOVEMENT_TESTNET_RPC_FALLBACK = process.env.MOVEMENT_TESTNET_RPC_FALLBACK || '';
const MOVEMENT_RPC_URL = process.env.MOVEMENT_RPC_URL || '';
const MOVEMENT_USDC_ADDRESS = (process.env.MOVEMENT_USDC_ADDRESS || '').trim().replace(/[>\s]+$/g, '');
const MOVEMENT_NATIVE_TOKEN = '0x1::aptos_coin::AptosCoin';

const getMovementRpcUrls = () => {
  const urls = [MOVEMENT_RPC_URL, MOVEMENT_TESTNET_RPC, MOVEMENT_TESTNET_RPC_FALLBACK]
    .map((u) => (u || '').trim())
    .filter((u) => u.length > 0);
  return Array.from(new Set(urls));
};

async function fetchMovementTxByVersion(version: string | number) {
  const rpcUrls = getMovementRpcUrls();
  let lastError: unknown = null;

  for (const rpcUrl of rpcUrls) {
    try {
      const txRes = await axios.get(
        `${rpcUrl}/transactions/by_version/${version}`,
        { timeout: 10000 }
      );
      if (txRes.data) return txRes.data;
    } catch (error) {
      lastError = error;
      logger.warn('Movement tx version fetch failed on RPC', { rpcUrl, version });
    }
  }

  if (lastError) {
    throw lastError;
  }

  return null;
}

async function fetchMovementUSDCBalance(walletAddress: string): Promise<{ balance: string; decimals: number } | null> {
  if (!MOVEMENT_USDC_ADDRESS) return null;
  const query = {
    query: `
      query GetFungibleAssetBalances($owner: String!, $assetType: String!) {
        current_fungible_asset_balances(
          where: {
            owner_address: { _eq: $owner }
            asset_type: { _eq: $assetType }
          }
        ) {
          amount
          metadata {
            decimals
          }
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
      logger.warn('Movement indexer errors while fetching balance', { errors: response.data.errors });
      return null;
    }
    const balances = response.data?.data?.current_fungible_asset_balances || [];
    if (!balances.length) return null;
    return {
      balance: balances[0].amount?.toString() || '0',
      decimals: balances[0].metadata?.decimals ?? 6,
    };
  } catch (error) {
    logger.warn('Failed to fetch Movement USDC balance from indexer', { error });
    return null;
  }
}

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
        const txRes = await fetchMovementTxByVersion(activity.transaction_version);
        if (txRes?.hash) {
          detailed.push({
            ...activity,
            transaction_hash: txRes.hash,
            requestor_address: txRes.sender || walletAddress,
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

async function fetchMovementMoveHistory(walletAddress: string): Promise<any[]> {
  const query = {
    query: `
      query GetUserMOVEHistory($owner: String!, $coinType: String!) {
        coin_activities(
          where: {
            owner_address: { _eq: $owner }
            coin_type: { _eq: $coinType }
          }
          order_by: { transaction_timestamp: desc }
          limit: 25
        ) {
          transaction_version
          amount
          activity_type
          transaction_timestamp
        }
      }
    `,
    variables: {
      owner: walletAddress.toLowerCase(),
      coinType: MOVEMENT_NATIVE_TOKEN,
    },
  };

  try {
    const response = await axios.post(MOVEMENT_INDEXER_URL, query, { timeout: 10000 });
    if (response.data?.errors) {
      logger.warn('Movement indexer MOVE errors', { errors: response.data.errors });
      return [];
    }

    const activities = response.data?.data?.coin_activities || [];
    const detailed: any[] = [];

    for (const activity of activities) {
      try {
        const txRes = await fetchMovementTxByVersion(activity.transaction_version);
        if (txRes?.hash) {
          detailed.push({
            ...activity,
            transaction_hash: txRes.hash,
            requestor_address: txRes.sender || walletAddress,
            type: activity.activity_type,
          });
        }
      } catch {
        // ignore individual failures
      }
    }

    return detailed;
  } catch (error) {
    logger.warn('Failed to fetch Movement MOVE history', { error });
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

    // Indexer fallback for Movement USDC if balance still zero
    const usdcBalanceData = balances.USDC as { balance: string; balanceUsd: number | null; decimals: number };
    if (usdcBalanceData && (!usdcBalanceData.balance || usdcBalanceData.balance === '0')) {
      const movementWallets = user.wallets.filter((w) => w.blockchain === 'MOVEMENT');
      if (movementWallets.length) {
        const indexerBalance = await fetchMovementUSDCBalance(movementWallets[0].address);
        if (indexerBalance && indexerBalance.balance !== '0') {
          balances.USDC = {
            balance: indexerBalance.balance,
            balanceUsd: null,
            decimals: indexerBalance.decimals,
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
    const syncIndexer = req.query.sync === '1';

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
        const moveActivities = await fetchMovementMoveHistory(wallet.address);
        const toIndexerRow = (activity: any, tokenAddress: string, tokenSymbol: string) => {
          const type = (activity.type || 'TRANSFER').toUpperCase();
          const isDeposit = type.includes('DEPOSIT');
          return {
            id: `idx-${activity.transaction_version}`,
            walletId: wallet.id,
            txHash: activity.transaction_hash || `v-${activity.transaction_version}`,
            txType: type,
            amount: activity.amount?.toString() || '0',
            tokenAddress,
            tokenSymbol,
            fromAddress: isDeposit ? activity.requestor_address : wallet.address,
            toAddress: isDeposit ? wallet.address : activity.requestor_address,
            status: 'COMPLETED',
            createdAt: activity.transaction_timestamp,
            source: 'indexer',
          };
        };

        const normalized = [
          ...activities.map((activity: any) =>
            toIndexerRow(activity, MOVEMENT_USDC_ADDRESS, 'USDC.e')
          ),
          ...moveActivities.map((activity: any) =>
            toIndexerRow(activity, MOVEMENT_NATIVE_TOKEN, 'MOVE')
          ),
        ];

        // De-duplicate by txHash; collapse DEPOSIT+WITHDRAW into TRANSFER
        const byHash = new Map<string, any>();
        for (const item of normalized) {
          const key = item.txHash;
          const existing = byHash.get(key);
          if (!existing) {
            byHash.set(key, item);
            continue;
          }

          const existingType = (existing.txType || '').toUpperCase();
          const nextType = (item.txType || '').toUpperCase();
          const isOpposite =
            (existingType.includes('DEPOSIT') && nextType.includes('WITHDRAW')) ||
            (existingType.includes('WITHDRAW') && nextType.includes('DEPOSIT'));

          if (isOpposite) {
            existing.txType = 'TRANSFER';
            existing.fromAddress = item.fromAddress || existing.fromAddress;
            existing.toAddress = item.toAddress || existing.toAddress;
          }
        }

        indexerTransactions = indexerTransactions.concat(Array.from(byHash.values()));
      }
    }

    if (syncIndexer && indexerTransactions.length > 0) {
      for (const txItem of indexerTransactions) {
        try {
          await prisma.walletTransaction.upsert({
            where: { txHash: txItem.txHash },
            create: {
              walletId: txItem.walletId,
              txHash: txItem.txHash,
              txType: txItem.txType,
              amount: txItem.amount,
              tokenAddress: txItem.tokenAddress,
              tokenSymbol: txItem.tokenSymbol,
              fromAddress: txItem.fromAddress,
              toAddress: txItem.toAddress,
              status: txItem.status,
              description: 'Indexed Movement transaction',
              metadata: { source: 'indexer' },
            },
            update: {},
          });
        } catch {
          // ignore duplicates or invalid
        }
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
