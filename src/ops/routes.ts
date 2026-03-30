import { Router, Request, Response } from 'express';
import axios from 'axios';
import { prisma } from '../index';
import { logger } from '../utils/logger';
import { AppError } from '../utils/errorHandler';
import { syncMovementBalance, syncSolanaBalance } from '../wallet/balanceIndexer';
import { createNotification } from '../notification/service';
import { getRolleyServiceBaseUrl } from '../points/service';
import { Connection, PublicKey } from '@solana/web3.js';

const router = Router();

const MOVEMENT_INDEXER_URL =
  process.env.MOVEMENT_INDEXER_URL || 'https://indexer.testnet.movementnetwork.xyz/v1/graphql';
const MOVEMENT_TESTNET_RPC =
  process.env.MOVEMENT_TESTNET_RPC || 'https://testnet.movementnetwork.xyz/v1';
const MOVEMENT_TESTNET_RPC_FALLBACK = process.env.MOVEMENT_TESTNET_RPC_FALLBACK || '';
const MOVEMENT_RPC_URL = process.env.MOVEMENT_RPC_URL || '';
const MOVEMENT_USDC_ADDRESS = (process.env.MOVEMENT_USDC_ADDRESS || '').trim().replace(/[>\s]+$/g, '');
const MOVEMENT_NATIVE_TOKEN = '0x1::aptos_coin::AptosCoin';
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const SOLANA_USDC_MINT = process.env.SOLANA_USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOLANA_TX_HISTORY_LIMIT = Number.parseInt(process.env.SOLANA_TX_HISTORY_LIMIT || '50', 10);
const ROLLEY_SERVICE_BASE = getRolleyServiceBaseUrl();
const resolveRolleyAdminKey = () => {
  const directCandidates = [
    process.env.ROLLEY_ADMIN_KEY,
    process.env.VITE_ROLLEY_ADMIN_KEY,
    process.env.ADMIN_REFRESH_KEY,
  ];
  for (const value of directCandidates) {
    const token = (value || '').trim();
    if (token) return token;
  }
  const firstFromList = (process.env.ADMIN_REFRESH_KEYS || '')
    .split(',')
    .map((item) => item.trim())
    .find(Boolean);
  return firstFromList || '';
};
const ROLLEY_ADMIN_KEY = resolveRolleyAdminKey();

type RolleyStakeSnapshot = {
  id: string;
  user_id: string;
  sport?: 'SOCCER' | 'BASKETBALL' | string;
  stake_asset?: 'USD' | 'USDC' | 'ROL' | string;
  status?: 'ACTIVE' | 'LOST' | 'MATURED' | 'WITHDRAWN' | string;
  latest_outcome?: 'PENDING' | 'WIN' | 'LOSS' | 'VOID' | string | null;
  principal_amount?: number;
  current_amount?: number;
  lock_days?: number;
  days_completed?: number;
  days_remaining?: number;
};

const toRawBigInt = (value: string | null | undefined) => {
  try {
    return BigInt(value || '0');
  } catch {
    return BigInt(0);
  }
};

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

type SolanaIndexedTx = {
  txHash: string;
  txType: string;
  amount: string;
  decimals: number;
  fromAddress?: string;
  toAddress?: string;
  createdAt?: Date;
};

const readSolanaTransfers = (parsedTx: any, tokenAccountSet: Set<string>) => {
  const instructions = [
    ...(parsedTx?.transaction?.message?.instructions || []),
    ...(parsedTx?.meta?.innerInstructions?.flatMap((item: any) => item.instructions) || []),
  ];
  const transfers: Array<{
    source?: string;
    destination?: string;
    mint?: string;
    amount?: string;
    decimals?: number;
  }> = [];

  for (const ix of instructions) {
    const parsed = ix?.parsed;
    const type = parsed?.type;
    if (type !== 'transfer' && type !== 'transferChecked') continue;
    const info = parsed?.info || {};
    const source = info.source;
    const destination = info.destination;
    const mint = info.mint;
    let amount = info.amount;
    let decimals = info.tokenAmount?.decimals;
    if (info.tokenAmount?.amount) amount = info.tokenAmount.amount;
    if (!amount && typeof info.uiAmountString === 'string') amount = info.uiAmountString;

    const touchesWallet =
      (source && tokenAccountSet.has(source)) ||
      (destination && tokenAccountSet.has(destination));
    if (!touchesWallet) continue;
    if (mint && mint !== SOLANA_USDC_MINT) continue;

    transfers.push({ source, destination, mint, amount, decimals });
  }

  return transfers;
};

async function fetchSolanaUSDCHistory(walletAddress: string): Promise<SolanaIndexedTx[]> {
  try {
    const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
    const owner = new PublicKey(walletAddress);
    const mint = new PublicKey(SOLANA_USDC_MINT);
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(owner, { mint }, 'confirmed');
    const tokenAccountKeys = tokenAccounts.value.map((account) => account.pubkey.toBase58());
    if (!tokenAccountKeys.length) {
      return [];
    }

    const signatureMap = new Map<string, { blockTime?: number }>();
    for (const account of tokenAccountKeys) {
      const signatures = await connection.getSignaturesForAddress(
        new PublicKey(account),
        { limit: SOLANA_TX_HISTORY_LIMIT }
      );
      for (const sig of signatures) {
        if (!signatureMap.has(sig.signature)) {
          signatureMap.set(sig.signature, { blockTime: sig.blockTime ?? undefined });
        }
      }
    }

    const orderedSignatures = Array.from(signatureMap.entries())
      .sort((a, b) => (b[1].blockTime || 0) - (a[1].blockTime || 0))
      .slice(0, SOLANA_TX_HISTORY_LIMIT)
      .map(([signature]) => signature);

    const tokenAccountSet = new Set(tokenAccountKeys);
    const results: SolanaIndexedTx[] = [];

    for (const signature of orderedSignatures) {
      const parsedTx = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      });
      if (!parsedTx?.meta) continue;

      const accountKeys = (parsedTx.transaction?.message?.accountKeys || []).map((key: any) => {
        if (!key) return '';
        if (typeof key === 'string') return key;
        if (typeof key === 'object' && typeof key.pubkey?.toBase58 === 'function') {
          return key.pubkey.toBase58();
        }
        if (typeof key?.toBase58 === 'function') return key.toBase58();
        if (typeof key?.toString === 'function') return key.toString();
        return String(key);
      });

      const isWalletTokenAccount = (entry: any) => {
        const idx = entry?.accountIndex;
        if (typeof idx !== 'number') return false;
        const accountKey = accountKeys[idx];
        return !!accountKey && tokenAccountSet.has(accountKey);
      };

      const preBalances =
        (parsedTx.meta.preTokenBalances || []).filter(
          (b: any) => b.mint === SOLANA_USDC_MINT && isWalletTokenAccount(b)
        );
      const postBalances =
        (parsedTx.meta.postTokenBalances || []).filter(
          (b: any) => b.mint === SOLANA_USDC_MINT && isWalletTokenAccount(b)
        );

      const decimals =
        postBalances[0]?.uiTokenAmount?.decimals ??
        preBalances[0]?.uiTokenAmount?.decimals ??
        6;

      const sumAmounts = (balances: any[]): bigint =>
        balances.reduce((acc, entry) => acc + toRawBigInt(entry.uiTokenAmount?.amount), 0n);
      const preSum = sumAmounts(preBalances);
      const postSum = sumAmounts(postBalances);
      const transfers = readSolanaTransfers(parsedTx, tokenAccountSet);

      let net = postSum - preSum;
      if (net === 0n && transfers.length > 0) {
        net = transfers.reduce((acc, t) => {
          const raw = toRawBigInt(t.amount || '0');
          if (t.destination && tokenAccountSet.has(String(t.destination))) {
            return acc + raw;
          }
          if (t.source && tokenAccountSet.has(String(t.source))) {
            return acc - raw;
          }
          return acc;
        }, 0n);
      }

      if (net === 0n) continue;

      const isDeposit = net > 0n;
      const amount = (isDeposit ? net : -net).toString();
      const preferred = transfers.find((t) =>
        isDeposit ? tokenAccountSet.has(String(t.destination)) : tokenAccountSet.has(String(t.source))
      );

      results.push({
        txHash: signature,
        txType: isDeposit ? 'DEPOSIT' : 'WITHDRAW',
        amount,
        decimals,
        fromAddress: isDeposit ? preferred?.source : walletAddress,
        toAddress: isDeposit ? walletAddress : preferred?.destination,
        createdAt: parsedTx.blockTime ? new Date(parsedTx.blockTime * 1000) : undefined,
      });
    }

    return results;
  } catch (error) {
    logger.warn('Ops cron: Failed to fetch Solana USDC history', { error, walletAddress });
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

async function syncSolanaIndexerTransactionsForAllWallets() {
  const solanaWallets = await prisma.wallet.findMany({
    where: { blockchain: 'SOLANA' },
    select: { id: true, address: true, userId: true },
  });

  let upserted = 0;
  let failed = 0;

  for (const wallet of solanaWallets) {
    try {
      const activities = await fetchSolanaUSDCHistory(wallet.address);
      for (const txItem of activities) {
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
            tokenAddress: SOLANA_USDC_MINT,
            tokenSymbol: 'USDC',
            fromAddress: txItem.fromAddress,
            toAddress: txItem.toAddress,
            status: 'COMPLETED',
            blockTime: txItem.createdAt || null,
            description: 'Indexed Solana transaction',
            metadata: { source: 'cron-indexer', decimals: txItem.decimals },
          },
        });
        upserted += 1;

        try {
          await notifyWalletTransaction({
            userId: wallet.userId,
            txHash: txItem.txHash,
            txType: txItem.txType,
            tokenSymbol: 'USDC',
            amount: txItem.amount,
            decimals: txItem.decimals,
          });
        } catch (error) {
          logger.warn('Ops cron: solana wallet notification emit failed', {
            walletId: wallet.id,
            txHash: txItem.txHash,
            error,
          });
        }
      }
    } catch (error) {
      failed += 1;
      logger.warn('Ops cron: solana tx indexing failed', {
        walletId: wallet.id,
        address: wallet.address,
        error,
      });
    }
  }

  return { wallets: solanaWallets.length, upserted, failed };
}

async function fetchRolleyPositionsForAsset(asset: 'USD' | 'USDC' | 'ROL', asOfDate: string) {
  const headers: Record<string, string> = {};
  if (ROLLEY_ADMIN_KEY) {
    headers['X-Admin-Key'] = ROLLEY_ADMIN_KEY;
  }
  const response = await axios.get(`${ROLLEY_SERVICE_BASE}/api/v1/admin/rollover/positions`, {
    params: {
      as_of_date: asOfDate,
      stake_asset: asset,
    },
    headers,
    timeout: 15000,
  });
  return Array.isArray(response.data?.stakes) ? (response.data.stakes as RolleyStakeSnapshot[]) : [];
}

async function syncRolleyStakeStatusNotifications() {
  const asOfDate = new Date().toISOString().slice(0, 10);
  const assets: Array<'USD' | 'USDC' | 'ROL'> = ['USD', 'USDC', 'ROL'];
  let scanned = 0;
  let created = 0;
  let failed = 0;

  for (const asset of assets) {
    let stakes: RolleyStakeSnapshot[] = [];
    try {
      stakes = await fetchRolleyPositionsForAsset(asset, asOfDate);
    } catch (error) {
      failed += 1;
      logger.warn('Ops cron: Rolley positions fetch failed', { asset, asOfDate, error });
      continue;
    }

    for (const stake of stakes) {
      scanned += 1;
      const status = String(stake.status || '').toUpperCase();
      const latestOutcome = String(stake.latest_outcome || '').toUpperCase();
      const normalizedStatus = status === 'ACTIVE' && latestOutcome === 'LOSS' ? 'LOST' : status;
      if (normalizedStatus !== 'LOST' && normalizedStatus !== 'MATURED') {
        continue;
      }
      if (!stake.id || !stake.user_id) {
        continue;
      }

      const reference = `rolley_stake_status:${stake.id}:${normalizedStatus}`;
      try {
        const existing = await prisma.notification.findUnique({
          where: { reference },
          select: { id: true },
        });
        if (existing) {
          continue;
        }

        const sport = String(stake.sport || '').toUpperCase();
        const assetCode = String(stake.stake_asset || asset).toUpperCase();
        const lockDays = Number(stake.lock_days || 0);
        const daysCompleted = Number(stake.days_completed || 0);
        const principal = Number(stake.principal_amount || 0);
        const current = Number(stake.current_amount || 0);
        const title =
          normalizedStatus === 'LOST' ? 'Rolley stake settled as loss' : 'Rolley stake matured';
        const body =
          normalizedStatus === 'LOST'
            ? `Your ${sport ? `${sport} ` : ''}${assetCode} rollover position ended as LOSS.`
            : `Your ${sport ? `${sport} ` : ''}${assetCode} rollover position matured successfully.`;

        await createNotification({
          userId: stake.user_id,
          type: 'SYSTEM',
          title,
          body,
          data: {
            stakeId: stake.id,
            sport: sport || null,
            stakeAsset: assetCode,
            status: normalizedStatus,
            latestOutcome: latestOutcome || null,
            principalAmount: principal,
            currentAmount: current,
            lockDays: Number.isFinite(lockDays) ? lockDays : 0,
            daysCompleted: Number.isFinite(daysCompleted) ? daysCompleted : 0,
          },
          reference,
        });
        created += 1;
      } catch (error) {
        failed += 1;
        logger.warn('Ops cron: Rolley stake notification sync failed', {
          stakeId: stake.id,
          userId: stake.user_id,
          status: normalizedStatus,
          error,
        });
      }
    }
  }

  return { scanned, created, failed };
}

router.post('/cron/wallet-indexing', async (req: Request, res: Response): Promise<Response> => {
  try {
    assertCronAuthorized(req);

    const balanceSummary = await syncBalancesForAllWallets();
    const movementTxSummary = await syncMovementIndexerTransactionsForAllWallets();
    const solanaTxSummary = await syncSolanaIndexerTransactionsForAllWallets();
    const rolleyStakeSummary = await syncRolleyStakeStatusNotifications();

    return res.json({
      success: true,
      balances: balanceSummary,
      movementTransactions: movementTxSummary,
      solanaTransactions: solanaTxSummary,
      rolleyStakeStatusNotifications: rolleyStakeSummary,
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
