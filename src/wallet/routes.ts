import { Router, Request, Response } from 'express';
import { prisma } from '../index';
import { logger } from '../utils/logger';
import { AppError } from '../utils/errorHandler';
import { syncMovementBalance, syncSolanaBalance } from './balanceIndexer';
import axios from 'axios';
import { createNotification } from '../notification/service';
import { Connection, PublicKey } from '@solana/web3.js';

const router = Router();
const MOVEMENT_INDEXER_URL = process.env.MOVEMENT_INDEXER_URL || 'https://indexer.testnet.movementnetwork.xyz/v1/graphql';
const MOVEMENT_TESTNET_RPC = process.env.MOVEMENT_TESTNET_RPC || 'https://testnet.movementnetwork.xyz/v1';
const MOVEMENT_TESTNET_RPC_FALLBACK = process.env.MOVEMENT_TESTNET_RPC_FALLBACK || '';
const MOVEMENT_RPC_URL = process.env.MOVEMENT_RPC_URL || '';
const MOVEMENT_USDC_ADDRESS = (process.env.MOVEMENT_USDC_ADDRESS || '').trim().replace(/[>\s]+$/g, '');
const MOVEMENT_NATIVE_TOKEN = '0x1::aptos_coin::AptosCoin';
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const SOLANA_USDC_MINT = process.env.SOLANA_USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOLANA_TX_HISTORY_LIMIT = Number.parseInt(process.env.SOLANA_TX_HISTORY_LIMIT || '50', 10);
const WALLET_SYNC_TTL_MS = Number.parseInt(process.env.WALLET_SYNC_TTL_MS || '300000', 10);
const INDEXER_FETCH_TTL_MS = Number.parseInt(process.env.WALLET_INDEXER_FETCH_TTL_MS || '300000', 10);
const recentWalletSyncs = new Map<string, number>();
const recentIndexerFetches = new Map<string, number>();
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

const isThrottleExpired = (cache: Map<string, number>, key: string, ttlMs: number) => {
  const lastRunAt = cache.get(key) || 0;
  return Date.now() - lastRunAt > ttlMs;
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
  const token = params.tokenSymbol || 'TOKEN';

  await createNotification({
    userId: params.userId,
    type: isReceive ? 'WALLET_RECEIVE' : 'WALLET_TRANSFER',
    title: isReceive ? 'Wallet credited' : 'Wallet transfer sent',
    body: `${isReceive ? '+' : '-'}${amountDisplay} ${token}`,
    data: {
      txHash: params.txHash,
      txType: params.txType,
      tokenSymbol: token,
      amountRaw: params.amount,
    },
    reference: `wallet_tx:${params.userId}:${params.txHash}:${isReceive ? 'in' : 'out'}`,
  });
};

const upsertIndexerTransactions = async (userId: string, txItems: any[]) => {
  let upserted = 0;
  for (const txItem of txItems) {
    try {
      const existing = await prisma.walletTransaction.findUnique({
        where: { txHash: txItem.txHash },
        select: { id: true },
      });
      if (existing) {
        continue;
      }

      await prisma.walletTransaction.create({
        data: {
          walletId: txItem.walletId,
          txHash: txItem.txHash,
          txType: txItem.txType,
          amount: txItem.amount,
          tokenAddress: txItem.tokenAddress,
          tokenSymbol: txItem.tokenSymbol,
          fromAddress: txItem.fromAddress,
          toAddress: txItem.toAddress,
          status: txItem.status || 'COMPLETED',
          description:
            txItem.tokenSymbol === 'USDC'
              ? 'Indexed Solana transaction'
              : 'Indexed Movement transaction',
          metadata: { source: 'indexer', decimals: txItem.metadata?.decimals },
        },
      });

      await notifyWalletTransaction({
        userId,
        txHash: txItem.txHash,
        txType: txItem.txType,
        tokenSymbol: txItem.tokenSymbol,
        amount: txItem.amount,
        decimals: txItem.metadata?.decimals,
      });

      upserted += 1;
    } catch {
      // ignore duplicates or invalid
    }
  }
  return upserted;
};

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
    ...(parsedTx?.meta?.innerInstructions?.flatMap((i: any) => i.instructions) || []),
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
        balances.reduce(
          (acc, entry) => acc + toRawBigInt(entry.uiTokenAmount?.amount),
          0n
        );
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
    logger.warn('Failed to fetch Solana USDC history', { error, walletAddress });
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
      ROL: { balance: user.rolBalanceRaw.toString(), balanceUsd: null, decimals: 8 },
      SOL: { balance: '0', balanceUsd: null, decimals: 9 },
      USDC: { balance: '0', balanceUsd: null, decimals: 6 },
      'USDC.E': { balance: '0', balanceUsd: null, decimals: 6 },
    };

    // Aggregate balances from all wallets
    for (const wallet of user.wallets) {
      for (const balance of wallet.walletBalances) {
        const symbol = balance.tokenSymbol.toUpperCase();
        if (symbol === 'ROL' || symbol === 'SOL' || symbol === 'USDC' || symbol === 'USDC.E') {
          const key = symbol;
          const existingBalanceData = balances[key] as {
            balance: string;
            balanceUsd: number | null;
            decimals: number;
          };
          const existingBalance = toRawBigInt(existingBalanceData.balance);
          const newBalance = toRawBigInt(balance.balance);
          balances[key] = {
            balance: (existingBalance + newBalance).toString(),
            balanceUsd: balance.balanceUsd,
            decimals: balance.decimals,
          };
        }
      }
    }

    // Indexer fallback for Movement USDC if balance still zero
    const usdcBalanceData = balances['USDC.E'] as { balance: string; balanceUsd: number | null; decimals: number };
    if (usdcBalanceData && (!usdcBalanceData.balance || usdcBalanceData.balance === '0')) {
      const movementWallets = user.wallets.filter((w) => w.blockchain === 'MOVEMENT');
      if (movementWallets.length) {
        const indexerBalance = await fetchMovementUSDCBalance(movementWallets[0].address);
        if (indexerBalance && indexerBalance.balance !== '0') {
          balances['USDC.E'] = {
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

    if (!isThrottleExpired(recentWalletSyncs, wallet.id, WALLET_SYNC_TTL_MS)) {
      const cachedWallet = await prisma.wallet.findUnique({
        where: { id: walletId },
        include: {
          walletBalances: true,
        },
      });
      return res.json({
        success: true,
        wallet: cachedWallet,
        skipped: true,
      });
    }

    recentWalletSyncs.set(wallet.id, Date.now());

    // Sync balance based on blockchain
    if (wallet.blockchain === 'MOVEMENT') {
      await syncMovementBalance(wallet.id, wallet.address);
    } else if (wallet.blockchain === 'SOLANA') {
      await syncSolanaBalance(wallet.id, wallet.address);
      const shouldFetchSolanaHistory = isThrottleExpired(
        recentIndexerFetches,
        wallet.address,
        INDEXER_FETCH_TTL_MS
      );
      const solanaActivities = shouldFetchSolanaHistory ? await fetchSolanaUSDCHistory(wallet.address) : [];
      if (solanaActivities.length > 0) {
        recentIndexerFetches.set(wallet.address, Date.now());
        const solanaTxItems = solanaActivities.map((activity) => ({
          id: `sol-${activity.txHash}`,
          walletId: wallet.id,
          txHash: activity.txHash,
          txType: activity.txType,
          amount: activity.amount,
          tokenAddress: SOLANA_USDC_MINT,
          tokenSymbol: 'USDC',
          fromAddress: activity.fromAddress || wallet.address,
          toAddress: activity.toAddress || wallet.address,
          status: 'COMPLETED',
          createdAt: activity.createdAt || new Date(),
          source: 'indexer',
          metadata: { decimals: activity.decimals },
        }));
        await upsertIndexerTransactions(userId, solanaTxItems);
      }
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
        where: {
          walletId: { in: walletIds },
          OR: [
            { paymentId: null },
            { payment: { status: 'COMPLETED' } },
          ],
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.walletTransaction.count({
        where: {
          walletId: { in: walletIds },
          OR: [
            { paymentId: null },
            { payment: { status: 'COMPLETED' } },
          ],
        },
      }),
    ]);

    let indexerTransactions: any[] = [];
    if (includeIndexer && syncIndexer) {
      const movementWallets = await prisma.wallet.findMany({
        where: { userId, blockchain: 'MOVEMENT' },
      });
      const solanaWallets = await prisma.wallet.findMany({
        where: { userId, blockchain: 'SOLANA' },
      });

      for (const wallet of movementWallets) {
        const shouldFetchIndexer = isThrottleExpired(
          recentIndexerFetches,
          wallet.address,
          INDEXER_FETCH_TTL_MS
        );
        if (!shouldFetchIndexer) continue;

        const activities = await fetchMovementUSDCHistory(wallet.address);
        const moveActivities = await fetchMovementMoveHistory(wallet.address);
        const toIndexerRow = (activity: any, tokenAddress: string, tokenSymbol: string) => {
          const type = (activity.type || 'TRANSFER').toUpperCase();
          const isDeposit = type.includes('DEPOSIT');
          const decimals = tokenSymbol === 'MOVE' ? 8 : 6;
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
            metadata: { decimals },
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
        recentIndexerFetches.set(wallet.address, Date.now());
      }

      for (const wallet of solanaWallets) {
        const shouldFetchIndexer = isThrottleExpired(
          recentIndexerFetches,
          wallet.address,
          INDEXER_FETCH_TTL_MS
        );
        if (!shouldFetchIndexer) continue;

        const solanaActivities = await fetchSolanaUSDCHistory(wallet.address);
        for (const activity of solanaActivities) {
          indexerTransactions.push({
            id: `sol-${activity.txHash}`,
            walletId: wallet.id,
            txHash: activity.txHash,
            txType: activity.txType,
            amount: activity.amount,
            tokenAddress: SOLANA_USDC_MINT,
            tokenSymbol: 'USDC',
            fromAddress: activity.fromAddress || wallet.address,
            toAddress: activity.toAddress || wallet.address,
            status: 'COMPLETED',
            createdAt: activity.createdAt || new Date(),
            source: 'indexer',
            metadata: { decimals: activity.decimals },
          });
        }
        recentIndexerFetches.set(wallet.address, Date.now());
      }
    }

    if (syncIndexer && indexerTransactions.length > 0) {
      await upsertIndexerTransactions(userId, indexerTransactions);
    }

    const mergedTransactions = includeIndexer
      ? [...indexerTransactions, ...transactions]
      : transactions;
    mergedTransactions.sort((a: any, b: any) => {
      const aTime = new Date(a.createdAt || 0).getTime();
      const bTime = new Date(b.createdAt || 0).getTime();
      return bTime - aTime;
    });

    return res.json({
      success: true,
      transactions: mergedTransactions,
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
