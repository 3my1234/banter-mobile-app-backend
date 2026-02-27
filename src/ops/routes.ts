import { Router, Request, Response } from 'express';
import axios from 'axios';
import { prisma } from '../index';
import { logger } from '../utils/logger';
import { AppError } from '../utils/errorHandler';
import { syncMovementBalance, syncSolanaBalance } from '../wallet/balanceIndexer';
import { createNotification } from '../notification/service';

const router = Router();

const MOVEMENT_INDEXER_URL =
  process.env.MOVEMENT_INDEXER_URL || 'https://indexer.testnet.movementnetwork.xyz/v1/graphql';
const MOVEMENT_TESTNET_RPC =
  process.env.MOVEMENT_TESTNET_RPC || 'https://testnet.movementnetwork.xyz/v1';
const MOVEMENT_TESTNET_RPC_FALLBACK = process.env.MOVEMENT_TESTNET_RPC_FALLBACK || '';
const MOVEMENT_RPC_URL = process.env.MOVEMENT_RPC_URL || '';
const MOVEMENT_USDC_ADDRESS = (process.env.MOVEMENT_USDC_ADDRESS || '').trim().replace(/[>\s]+$/g, '');
const MOVEMENT_NATIVE_TOKEN = '0x1::aptos_coin::AptosCoin';

const formatAmount = (raw: string, decimals: number) => {
  const amount = Number(raw || '0');
  if (!Number.isFinite(amount)) return raw;
  return (amount / 10 ** decimals).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: Math.min(decimals, 6),
  });
};

const notifyWalletTransaction = async (params: {
  userId: string;
  txHash: string;
  txType: string;
  tokenSymbol: string;
  amount: string;
  decimals?: number;
}) => {
  const type = (params.txType || '').toUpperCase();
  const isReceive =
    type.includes('DEPOSIT') || type.includes('CREDIT') || type.includes('RECEIVE');
  const isTransferOut =
    type.includes('WITHDRAW') || type.includes('DEBIT') || type.includes('TRANSFER');
  if (!isReceive && !isTransferOut) {
    return;
  }

  const decimals = typeof params.decimals === 'number' ? params.decimals : 6;
  const amountDisplay = formatAmount(params.amount, decimals);

  await createNotification({
    userId: params.userId,
    type: isReceive ? 'WALLET_RECEIVE' : 'WALLET_TRANSFER',
    title: isReceive ? 'Wallet credited' : 'Wallet transfer sent',
    body: `${isReceive ? '+' : '-'}${amountDisplay} ${params.tokenSymbol}`,
    data: {
      txHash: params.txHash,
      txType: params.txType,
      tokenSymbol: params.tokenSymbol,
      amountRaw: params.amount,
    },
    reference: `wallet_tx:${params.userId}:${params.txHash}:${isReceive ? 'in' : 'out'}`,
  });
};

const getMovementRpcUrls = () => {
  const urls = [MOVEMENT_RPC_URL, MOVEMENT_TESTNET_RPC, MOVEMENT_TESTNET_RPC_FALLBACK]
    .map((u) => (u || '').trim())
    .filter((u) => u.length > 0);
  return Array.from(new Set(urls));
};

const assertCronAuthorized = (req: Request) => {
  const expected =
    process.env.CRON_SYNC_SECRET ||
    process.env.CRON_SECRET ||
    process.env.MEDIA_PIPELINE_SECRET ||
    '';
  if (!expected) {
    throw new AppError('Cron secret is not configured', 500);
  }

  const received =
    (req.headers['x-cron-secret'] as string) ||
    (req.query.secret as string) ||
    '';
  if (received !== expected) {
    throw new AppError('Unauthorized', 401);
  }
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
      logger.warn('Ops cron: Movement tx version fetch failed on RPC', { rpcUrl, version });
    }
  }

  if (lastError) {
    throw lastError;
  }

  return null;
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
      logger.warn('Ops cron: Movement indexer errors', { errors: response.data.errors });
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
        // ignore per-tx failures
      }
    }

    return detailed;
  } catch (error) {
    logger.warn('Ops cron: Failed to fetch Movement USDC history', { error });
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
      logger.warn('Ops cron: Movement indexer MOVE errors', { errors: response.data.errors });
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
        // ignore per-tx failures
      }
    }

    return detailed;
  } catch (error) {
    logger.warn('Ops cron: Failed to fetch Movement MOVE history', { error });
    return [];
  }
}

async function syncBalancesForAllWallets() {
  const wallets = await prisma.wallet.findMany({
    select: {
      id: true,
      address: true,
      blockchain: true,
    },
  });

  let synced = 0;
  let failed = 0;

  for (const wallet of wallets) {
    try {
      if (wallet.blockchain === 'MOVEMENT') {
        await syncMovementBalance(wallet.id, wallet.address);
      } else if (wallet.blockchain === 'SOLANA') {
        await syncSolanaBalance(wallet.id, wallet.address);
      }
      synced += 1;
    } catch (error) {
      failed += 1;
      logger.warn('Ops cron: wallet balance sync failed', {
        walletId: wallet.id,
        blockchain: wallet.blockchain,
        error,
      });
    }
  }

  return { total: wallets.length, synced, failed };
}

async function syncMovementIndexerTransactionsForAllWallets() {
  const movementWallets = await prisma.wallet.findMany({
    where: { blockchain: 'MOVEMENT' },
    select: { id: true, address: true, userId: true },
  });

  let upserted = 0;
  let failed = 0;

  for (const wallet of movementWallets) {
    try {
      const activities = await fetchMovementUSDCHistory(wallet.address);
      const moveActivities = await fetchMovementMoveHistory(wallet.address);
      const normalized = [
        ...activities.map((activity: any) => ({
          txHash: activity.transaction_hash || `v-${activity.transaction_version}`,
          txType: (activity.type || 'TRANSFER').toUpperCase(),
          amount: activity.amount?.toString() || '0',
          tokenAddress: MOVEMENT_USDC_ADDRESS,
          tokenSymbol: 'USDC.e',
          fromAddress: activity.requestor_address || wallet.address,
          toAddress: wallet.address,
          createdAt: activity.transaction_timestamp,
        })),
        ...moveActivities.map((activity: any) => ({
          txHash: activity.transaction_hash || `v-${activity.transaction_version}`,
          txType: (activity.type || 'TRANSFER').toUpperCase(),
          amount: activity.amount?.toString() || '0',
          tokenAddress: MOVEMENT_NATIVE_TOKEN,
          tokenSymbol: 'MOVE',
          fromAddress: activity.requestor_address || wallet.address,
          toAddress: wallet.address,
          createdAt: activity.transaction_timestamp,
        })),
      ];

      for (const txItem of normalized) {
        const existing = await prisma.walletTransaction.findUnique({
          where: { txHash: txItem.txHash },
          select: { id: true },
        });
        if (existing) {
          continue;
        }

        await prisma.walletTransaction.create({
          data: {
            walletId: wallet.id,
            txHash: txItem.txHash,
            txType: txItem.txType,
            amount: txItem.amount,
            tokenAddress: txItem.tokenAddress,
            tokenSymbol: txItem.tokenSymbol,
            fromAddress: txItem.fromAddress,
            toAddress: txItem.toAddress,
            status: 'COMPLETED',
            description: 'Indexed Movement transaction',
            metadata: { source: 'cron-indexer' },
          },
        });
        upserted += 1;

        try {
          await notifyWalletTransaction({
            userId: wallet.userId,
            txHash: txItem.txHash,
            txType: txItem.txType,
            tokenSymbol: txItem.tokenSymbol,
            amount: txItem.amount,
            decimals: txItem.tokenSymbol === 'MOVE' ? 8 : 6,
          });
        } catch (error) {
          logger.warn('Ops cron: wallet notification emit failed', {
            walletId: wallet.id,
            txHash: txItem.txHash,
            error,
          });
        }
      }
    } catch (error) {
      failed += 1;
      logger.warn('Ops cron: movement tx indexing failed', {
        walletId: wallet.id,
        address: wallet.address,
        error,
      });
    }
  }

  return { wallets: movementWallets.length, upserted, failed };
}

router.post('/cron/wallet-indexing', async (req: Request, res: Response): Promise<Response> => {
  try {
    assertCronAuthorized(req);

    const balanceSummary = await syncBalancesForAllWallets();
    const txSummary = await syncMovementIndexerTransactionsForAllWallets();

    return res.json({
      success: true,
      balances: balanceSummary,
      movementTransactions: txSummary,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Ops cron wallet indexing error', { error });
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    return res.status(500).json({ success: false, message: 'Failed to run cron wallet indexing' });
  }
});

export default router;
