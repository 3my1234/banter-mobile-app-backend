import { Router, Request, Response } from 'express';
import { Connection } from '@solana/web3.js';
import bs58 from 'bs58';
import axios from 'axios';
import { prisma } from '../index';
import { logger } from '../utils/logger';
import { AppError } from '../utils/errorHandler';
import {
  initializeFlutterwavePayment,
  verifyFlutterwavePayment,
  findFlutterwaveTransactionByRef,
} from './flutterwave';
import { createNotification } from '../notification/service';
import { awardFirstRolleyStakePoints, getRolleyServiceBaseUrl } from '../points/service';

const router = Router();

// Public health check for payments (mounted at /api/public/payments and /api/payments)
router.get('/health', (_req: Request, res: Response): Response => {
  return res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const SOLANA_USDC_MINT =
  process.env.SOLANA_USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOLANA_USDC_RECEIVER =
  process.env.SOLANA_USDC_RECEIVER || process.env.SOLANA_ADMIN_WALLET || '';
const SOLANA_MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const MOVEMENT_RPC_URL =
  process.env.MOVEMENT_TESTNET_RPC || 'https://testnet.movementnetwork.xyz/v1';
const MOVEMENT_RPC_FALLBACK =
  process.env.MOVEMENT_TESTNET_RPC_FALLBACK || '';
const MOVEMENT_USDC_ADDRESS =
  (process.env.MOVEMENT_USDC_ADDRESS || '').trim().replace(/[>\s]+$/g, '');
const MOVEMENT_USDC_RECEIVER =
  (process.env.MOVEMENT_USDC_RECEIVER ||
    process.env.MOVEMENT_ADMIN_WALLET ||
    '').trim();
const MOVEMENT_USDC_DECIMALS = 6;

const VOTE_BUNDLES = [
  { id: 'b1', votes: 1, price: 1 },
  { id: 'b2', votes: 10, price: 10 },
  { id: 'b3', votes: 100, price: 100 },
  { id: 'b4', votes: 1000, price: 1000 },
  { id: 'b5', votes: 10000, price: 10000 },
];

const USDC_DECIMALS = 6;

const priceToRaw = (price: number) =>
  Math.round(price * 10 ** USDC_DECIMALS).toString();

const findBundle = (bundleId: string) =>
  VOTE_BUNDLES.find((bundle) => bundle.id === bundleId);

const normalizeAddress = (value: string) => value.trim().toLowerCase();
const normalizePhone = (value: string) => {
  const digits = (value || '').replace(/\D+/g, '');
  if (digits.length < 8) return '0000000000';
  return digits;
};
const normalizeEmail = (value: string | null | undefined, userId: string) => {
  const raw = (value || '').trim().toLowerCase();
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw);
  const isLocal = raw.endsWith('.local');
  if (isEmail && !isLocal) {
    return raw;
  }
  return `user-${userId}@banter.app`;
};
const parseFxRate = (value: string | undefined) => {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};
const EXCHANGERATE_HOST_KEY = (
  process.env.EXCHANGERATE_HOST_KEY ||
  process.env.EXCHANGE_RATE_HOST_KEY ||
  ''
).trim();
const FX_RATE_TTL_MS = Math.max(
  60_000,
  Number(process.env.FX_RATE_TTL_SECONDS || 900) * 1000
);
let cachedFxRates: { rates: Record<string, number>; expiresAt: number } | null = null;
const getUsdFxRate = async (currency: string) => {
  const target = currency.toUpperCase();
  if (target === 'USD') {
    return 1;
  }

  const now = Date.now();
  if (cachedFxRates && cachedFxRates.expiresAt > now && cachedFxRates.rates[target]) {
    return cachedFxRates.rates[target];
  }

  const configured = parseFxRate(
    process.env.FLUTTERWAVE_NGN_RATE || process.env.EXCHANGE_RATE_USD_NGN
  );
  if (target === 'NGN' && configured) {
    cachedFxRates = {
      rates: { ...(cachedFxRates?.rates || {}), NGN: configured },
      expiresAt: now + FX_RATE_TTL_MS,
    };
    return configured;
  }

  const sources = [
    async () => {
      const response = await axios.get('https://open.er-api.com/v6/latest/USD', {
        timeout: 5000,
      });
      return response?.data?.rates || {};
    },
    async () => {
      if (target !== 'NGN' || !EXCHANGERATE_HOST_KEY) return {};
      const base = 'https://api.exchangerate.host/latest?base=USD&symbols=NGN';
      const url = `${base}&access_key=${encodeURIComponent(EXCHANGERATE_HOST_KEY)}`;
      const response = await axios.get(url, { timeout: 5000 });
      if (response?.data?.success === false) {
        return {};
      }
      return response?.data?.rates || {};
    },
  ];
  for (const fetchRate of sources) {
    try {
      const rates = await fetchRate();
      const rate = Number(rates?.[target] || 0);
      if (Number.isFinite(rate) && rate > 0) {
        cachedFxRates = { rates, expiresAt: now + FX_RATE_TTL_MS };
        return rate;
      }
    } catch {
      // try next provider
    }
  }
  throw new AppError(`Unable to fetch USD->${target} rate`, 500);
};
const isNigeriaUser = (user?: { country?: string | null; phone?: string | null }) => {
  const country = (user?.country || '').trim().toLowerCase();
  if (country === 'nigeria' || country === 'ng') return true;
  const phoneDigits = (user?.phone || '').replace(/\D+/g, '');
  return phoneDigits.startsWith('234');
};

const EURO_COUNTRY_CODES = new Set([
  'at', 'be', 'cy', 'de', 'ee', 'es', 'fi', 'fr', 'gr', 'hr', 'ie', 'it', 'lt',
  'lu', 'lv', 'mt', 'nl', 'pt', 'si', 'sk',
]);

const EURO_COUNTRY_NAMES = new Set([
  'austria', 'belgium', 'cyprus', 'germany', 'estonia', 'spain', 'finland',
  'france', 'greece', 'croatia', 'ireland', 'italy', 'lithuania', 'luxembourg',
  'latvia', 'malta', 'netherlands', 'portugal', 'slovenia', 'slovakia',
]);

const normalizeUserCountry = (user?: { country?: string | null }) =>
  (user?.country || '').trim().toLowerCase();

const isUkUser = (user?: { country?: string | null }) => {
  const country = normalizeUserCountry(user);
  return country === 'uk' || country === 'gb' || country === 'united kingdom' || country === 'great britain';
};

const isEuroUser = (user?: { country?: string | null }) => {
  const country = normalizeUserCountry(user);
  return EURO_COUNTRY_CODES.has(country) || EURO_COUNTRY_NAMES.has(country);
};

const resolveFlutterwaveCurrency = (
  requested: unknown,
  user?: { country?: string | null; phone?: string | null }
) => {
  const normalized = typeof requested === 'string' ? requested.trim().toUpperCase() : '';
  if (isNigeriaUser(user)) return 'NGN';
  if (isUkUser(user)) return 'GBP';
  if (isEuroUser(user)) return 'EUR';
  if (normalized === 'USD' || normalized === 'NGN' || normalized === 'GBP' || normalized === 'EUR') {
    return normalized;
  }
  return 'USD';
};
const resolveFlutterwavePaymentOptions = (user?: { country?: string | null; phone?: string | null }) => {
  if (isNigeriaUser(user)) {
    return 'banktransfer,ussd,card';
  }
  return 'card';
};
const resolveFlutterwaveAmount = async (usdAmount: number, currency: string) => {
  if (currency !== 'USD') {
    const rate = await getUsdFxRate(currency);
    const converted = Math.round(usdAmount * rate * 100) / 100;
    return converted;
  }
  return usdAmount;
};

const getMovementRpcUrls = () => {
  const urls = [MOVEMENT_RPC_URL, MOVEMENT_RPC_FALLBACK]
    .map((u) => (u || '').trim())
    .filter((u) => u.length > 0);
  return Array.from(new Set(urls));
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeMemo = (value: string) => value.trim();

const readMemoFromLogs = (logs: string[] | null | undefined) => {
  if (!logs) return '';
  for (const line of logs) {
    if (!line) continue;
    const trimmed = line.trim();
    const match = trimmed.match(/Memo(?:\s*\(.*?\))?:\s*(.+)$/i);
    if (match?.[1]) {
      return normalizeMemo(match[1]);
    }
  }
  return '';
};

const readMemoFromInstructions = (instructions: any[] | null | undefined) => {
  if (!instructions) return '';
  for (const ix of instructions) {
    const programId = ix?.programId?.toString?.() || ix?.programId || '';
    const program = ix?.program || '';
    if (program !== 'spl-memo' && programId !== SOLANA_MEMO_PROGRAM_ID) {
      continue;
    }
    const parsed = ix?.parsed;
    if (typeof parsed === 'string') {
      return normalizeMemo(parsed);
    }
    if (parsed?.type === 'memo' && typeof parsed?.info?.memo === 'string') {
      return normalizeMemo(parsed.info.memo);
    }
    if (typeof ix?.data === 'string' && ix.data.length > 0) {
      try {
        const decoded = Buffer.from(bs58.decode(ix.data)).toString('utf8');
        if (decoded) return normalizeMemo(decoded);
      } catch {
        // ignore decode errors
      }
    }
  }
  return '';
};

const extractSolanaMemo = (parsed: any) => {
  const fromLogs = readMemoFromLogs(parsed?.meta?.logMessages);
  if (fromLogs) return fromLogs;

  const fromTop = readMemoFromInstructions(parsed?.transaction?.message?.instructions);
  if (fromTop) return fromTop;

  const inner = parsed?.meta?.innerInstructions || [];
  for (const group of inner) {
    const memo = readMemoFromInstructions(group?.instructions);
    if (memo) return memo;
  }
  return '';
};

const getSolanaBalanceDelta = (parsed: any, receiver: string, mint: string) => {
  const preBalances = parsed.meta?.preTokenBalances || [];
  const postBalances = parsed.meta?.postTokenBalances || [];
  const accountKeys = (parsed.transaction?.message?.accountKeys || []).map((key: any) =>
    key?.pubkey?.toBase58 ? key.pubkey.toBase58() : key?.pubkey?.toString?.() || ''
  );

  const matchBalance = (balances: typeof preBalances) =>
    balances.find((b: any) => {
      if (b.mint !== mint) return false;
      const accountKey = accountKeys[b.accountIndex] || '';
      return b.owner === receiver || accountKey === receiver;
    });

  const pre = matchBalance(preBalances);
  const post = matchBalance(postBalances);

  const preAmount = BigInt(pre?.uiTokenAmount?.amount || '0');
  const postAmount = BigInt(post?.uiTokenAmount?.amount || '0');
  return postAmount - preAmount;
};

const fetchMovementTransaction = async (txHash: string) => {
  const rpcUrls = getMovementRpcUrls();
  let lastError: unknown = null;

  for (const rpcUrl of rpcUrls) {
    try {
      const response = await axios.get(
        `${rpcUrl}/transactions/by_hash/${txHash}`,
        { timeout: 15000 }
      );
      return response.data;
    } catch (error) {
      lastError = error;
      logger.warn('Movement tx fetch failed on RPC', { rpcUrl, txHash });
    }
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error('No Movement RPC configured');
};

const fetchMovementTransactionWithRetry = async (txHash: string) => {
  const attempts = 5;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fetchMovementTransaction(txHash);
    } catch (error) {
      logger.warn('Movement tx not found, retrying', { txHash, attempt: i + 1 });
      await sleep(2000 * (i + 1));
    }
  }
  throw new AppError('Transaction not confirmed', 400);
};

const extractAddressArg = (value: any): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return value.toString();
  if (!value || typeof value !== 'object') return '';
  const candidates = [value.address, value.account, value.value, value.inner];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate;
    }
  }
  return '';
};

const extractAmountArg = (value: any): bigint => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return BigInt(0);
    if (/^0x[0-9a-f]+$/i.test(trimmed)) return BigInt(trimmed);
    if (/^\d+$/.test(trimmed)) return BigInt(trimmed);
    const digits = trimmed.match(/\d+/g)?.join('') || '';
    if (digits) return BigInt(digits);
    throw new AppError(`Unable to parse Movement amount: ${trimmed}`, 400);
  }
  if (value && typeof value === 'object') {
    const nestedCandidates = [value.amount, value.value, value.inner, value.vec?.[0]];
    for (const candidate of nestedCandidates) {
      try {
        return extractAmountArg(candidate);
      } catch {
        // keep trying
      }
    }
  }
  throw new AppError('Unable to parse Movement amount from transaction payload', 400);
};

const ensureMovementAccountExists = async (address: string) => {
  const rpcUrls = getMovementRpcUrls();
  const normalizedAddress = normalizeAddress(address);
  let sawAccountNotFound = false;
  let lastError: unknown = null;

  for (const rpcUrl of rpcUrls) {
    try {
      await axios.get(`${rpcUrl}/accounts/${normalizedAddress}`, {
        timeout: 10000,
      });
      return;
    } catch (error: any) {
      const status = error?.response?.status;
      if (status === 404) {
        sawAccountNotFound = true;
        continue;
      }
      lastError = error;
      logger.warn('Movement account existence check failed on RPC', {
        rpcUrl,
        address: normalizedAddress,
      });
    }
  }

  if (sawAccountNotFound) {
    throw new AppError(
      `Movement account not initialized on-chain for ${normalizedAddress}. Fund this wallet with MOVE on Movement testnet, wait confirmation, then retry.`,
      400
    );
  }

  if (lastError) {
    throw lastError;
  }

  throw new AppError('No Movement RPC configured', 500);
};

const isHttpsUrl = (value?: string | null) =>
  typeof value === 'string' && value.trim().toLowerCase().startsWith('https://');

const isDeepLinkUrl = (value?: string | null) => {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) && !trimmed.toLowerCase().startsWith('https://') && !trimmed.toLowerCase().startsWith('http://');
};

const appendQueryParams = (baseUrl: string, params: Record<string, string>) => {
  const query = Object.entries(params)
    .filter(([, value]) => value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  if (!query) return baseUrl;
  const separator = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${separator}${query}`;
};

const getBackendPublicBase = (req?: Request) => {
  const candidates = [
    process.env.BACKEND_PUBLIC_URL,
    process.env.API_URL,
    req ? `${req.protocol}://${req.get('host') || ''}` : '',
  ];
  const picked = candidates.find((value) => isHttpsUrl(value));
  if (!picked) return 'https://sportbanter.online';
  return picked!.trim().replace(/\/+$/, '').replace(/\/api$/, '');
};

const resolveFlutterwaveProviderRedirect = (req?: Request) => {
  const base = getBackendPublicBase(req);
  return `${base}/api/public/payments/flutterwave/callback`;
};

const resolveAppRedirectUrl = (input?: string | null) => {
  if (isDeepLinkUrl(input) || isHttpsUrl(input)) return input!.trim();
  if (isDeepLinkUrl(process.env.FLUTTERWAVE_APP_REDIRECT_URL) || isHttpsUrl(process.env.FLUTTERWAVE_APP_REDIRECT_URL)) {
    return process.env.FLUTTERWAVE_APP_REDIRECT_URL!.trim();
  }
  if (isDeepLinkUrl(process.env.FLUTTERWAVE_REDIRECT_URL) || isHttpsUrl(process.env.FLUTTERWAVE_REDIRECT_URL)) {
    return process.env.FLUTTERWAVE_REDIRECT_URL!.trim();
  }
  return 'banterv3://payments/flutterwave';
};

const findFlutterwavePaymentByRef = async (txRef: string) => {
  const recent = await prisma.payment.findMany({
    where: {
      chain: 'FLUTTERWAVE',
    },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });
  return recent.find((payment) => (payment.metadata as any)?.txRef === txRef) || null;
};

const notifyRolleyStakeFunded = async (payment: {
  id: string;
  userId: string;
  amount: number;
  currency: string;
  metadata: any;
}) => {
  const sport = String(payment?.metadata?.sport || '').toUpperCase();
  const lockDays = Number(payment?.metadata?.lockDays || 0);
  await createNotification({
    userId: payment.userId,
    type: 'SYSTEM',
    title: 'Rolley rollover funded',
    body: `Your ${payment.amount} ${payment.currency} ${sport ? `${sport} ` : ''}rollover for ${lockDays} day${lockDays === 1 ? '' : 's'} is active.`,
    data: {
      paymentId: payment.id,
      amount: payment.amount,
      currency: payment.currency,
      sport,
      lockDays,
      stakeId: payment?.metadata?.rolleyStakeId || null,
    },
    reference: `rolley_payment:${payment.id}`,
  });
};

const createRolleyStakePosition = async (input: {
  userId: string;
  paymentId: string;
  sport: 'SOCCER' | 'BASKETBALL';
  amount: number;
  lockDays: number;
  stakeAsset: 'USD' | 'USDC' | 'ROL';
}) => {
  const response = await axios.post(
    `${getRolleyServiceBaseUrl()}/api/v1/stakes/create`,
    {
      user_id: input.userId,
      external_reference: `payment:${input.paymentId}`,
      sport: input.sport,
      stake_asset: input.stakeAsset,
      amount: input.amount,
      lock_days: input.lockDays,
    },
    {
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' },
    }
  );
  return response.data?.stake || response.data;
};

const notifyVotePurchaseCompleted = async (payment: {
  id: string;
  userId: string;
  amount: number;
  currency: string;
  chain: string;
  metadata: any;
}) => {
  const votes = Number(payment?.metadata?.votes || 0);
  await createNotification({
    userId: payment.userId,
    type: 'VOTE_PURCHASE',
    title: 'Vote purchase successful',
    body: `You received ${votes} vote${votes === 1 ? '' : 's'} for ${payment.amount} ${payment.currency}.`,
    data: {
      paymentId: payment.id,
      chain: payment.chain,
      amount: payment.amount,
      currency: payment.currency,
      votes,
    },
    reference: `vote_purchase:${payment.id}`,
  });
};

const finalizeFlutterwaveVotePayment = async (opts: {
  payment: any;
  transactionId?: string;
  txRef?: string;
}) => {
  const { payment, transactionId, txRef } = opts;

  if (payment.status === 'COMPLETED') {
    return { payment, transactionId: payment.txHash || '' };
  }

  let resolvedTransactionId = transactionId;
  if (!resolvedTransactionId && txRef) {
    const byRef = await findFlutterwaveTransactionByRef(txRef);
    resolvedTransactionId = byRef || undefined;
  }
  if (!resolvedTransactionId) {
    throw new AppError('transactionId or txRef is required', 400);
  }

  const verification = await verifyFlutterwavePayment(resolvedTransactionId);
  if (verification.data.status !== 'successful') {
    throw new AppError('Payment verification failed', 400);
  }

  if (txRef && verification.data.tx_ref !== txRef) {
    throw new AppError('Reference mismatch', 400);
  }

  if (verification.data.currency && payment.currency &&
      verification.data.currency.toUpperCase() !== String(payment.currency).toUpperCase()) {
    throw new AppError('Payment currency mismatch', 400);
  }

  if (verification.data.amount < payment.amount) {
    throw new AppError('Payment amount mismatch', 400);
  }

  const updated = await prisma.$transaction(async (tx) => {
    const latest = await tx.payment.findUnique({ where: { id: payment.id } });
    if (!latest) {
      throw new AppError('Payment not found', 404);
    }
    if (latest.status === 'COMPLETED') {
      return latest;
    }

    const updatedPayment = await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: 'COMPLETED',
        txHash: String(resolvedTransactionId),
        completedAt: new Date(),
        metadata: {
          ...(latest.metadata as any),
          flutterwave: verification.data,
        },
      },
    });

    const bundleVotes = Number((latest.metadata as any)?.votes || 0);
    if (bundleVotes > 0) {
      await tx.user.update({
        where: { id: latest.userId },
        data: {
          voteBalance: {
            increment: bundleVotes,
          },
        },
      });
    }

    return updatedPayment;
  });

  await notifyVotePurchaseCompleted(updated as any);

  return { payment: updated, transactionId: String(resolvedTransactionId) };
};

const finalizeFlutterwaveRolleyPayment = async (opts: {
  payment: any;
  transactionId?: string;
  txRef?: string;
}) => {
  const { payment, transactionId, txRef } = opts;

  const metadata = (payment.metadata as any) || {};
  const existingStakeId = metadata?.rolleyStakeId;
  if (payment.status === 'COMPLETED' && existingStakeId) {
    return { payment, transactionId: payment.txHash || '' };
  }

  let resolvedTransactionId = transactionId;
  if (!resolvedTransactionId && txRef) {
    const byRef = await findFlutterwaveTransactionByRef(txRef);
    resolvedTransactionId = byRef || undefined;
  }
  if (!resolvedTransactionId) {
    throw new AppError('transactionId or txRef is required', 400);
  }

  const verification = await verifyFlutterwavePayment(resolvedTransactionId);
  if (verification.data.status !== 'successful') {
    throw new AppError('Payment verification failed', 400);
  }

  if (txRef && verification.data.tx_ref !== txRef) {
    throw new AppError('Reference mismatch', 400);
  }

  if (verification.data.currency && payment.currency &&
      verification.data.currency.toUpperCase() !== String(payment.currency).toUpperCase()) {
    throw new AppError('Payment currency mismatch', 400);
  }

  if (verification.data.amount < payment.amount) {
    throw new AppError('Payment amount mismatch', 400);
  }

  const sport = String(metadata?.sport || '').toUpperCase();
  const lockDays = Number(metadata?.lockDays || 0);
  if ((sport !== 'SOCCER' && sport !== 'BASKETBALL') || !lockDays) {
    throw new AppError('Rolley payment metadata is invalid', 400);
  }

  const paymentCurrency = String(payment.currency || 'USD').toUpperCase();
  const stakeAmount =
    paymentCurrency === 'NGN'
      ? Number(metadata?.usdAmount || 0)
      : Number(payment.amount);
  if (!Number.isFinite(stakeAmount) || stakeAmount <= 0) {
    throw new AppError('Rolley payment amount is invalid', 400);
  }

  const stake = await createRolleyStakePosition({
    userId: payment.userId,
    paymentId: payment.id,
    sport: sport as 'SOCCER' | 'BASKETBALL',
    amount: stakeAmount,
    lockDays,
    stakeAsset: 'USD',
  });

  const updated = await prisma.$transaction(async (tx) => {
    const latest = await tx.payment.findUnique({ where: { id: payment.id } });
    if (!latest) {
      throw new AppError('Payment not found', 404);
    }

    const nextMetadata = {
      ...(latest.metadata as any),
      flutterwave: verification.data,
      rolleyStakeId: stake?.id || null,
      rolleyStake: stake || null,
    };

    const updatedPayment = await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: 'COMPLETED',
        txHash: String(resolvedTransactionId),
        completedAt: new Date(),
        metadata: nextMetadata,
      },
    });

    try {
      await awardFirstRolleyStakePoints(tx, {
        userId: payment.userId,
        stakeId: String(stake?.id || payment.id),
        stakeCreatedAt: stake?.created_at || null,
      });
    } catch (error) {
      logger.warn('Failed to award first Rolley stake points', { error, userId: payment.userId });
    }

    return updatedPayment;
  });

  await notifyRolleyStakeFunded(updated as any);

  return { payment: updated, transactionId: String(resolvedTransactionId) };
};

router.get('/flutterwave/debug', async (_req: Request, res: Response): Promise<Response> => {
  try {
    const secret = process.env.FLUTTERWAVE_SECRET_KEY;
    if (!secret) {
      return res.status(500).json({
        ok: false,
        message: 'FLUTTERWAVE_SECRET_KEY is not set on the server',
      });
    }

    const response = await axios.get('https://api.flutterwave.com/v3/transactions', {
      headers: {
        Authorization: `Bearer ${secret}`,
      },
      params: {
        from: '2020-01-01',
        to: '2020-01-02',
      },
      timeout: 15000,
    });

    return res.json({
      ok: true,
      status: response.status,
      message: 'Flutterwave credentials are accepted',
    });
  } catch (error: any) {
    const message =
      error?.response?.data?.message ||
      error?.response?.data ||
      error?.message ||
      'Flutterwave debug failed';
    return res.status(500).json({
      ok: false,
      message,
    });
  }
});

router.get('/votes/bundles', (_req: Request, res: Response): Response => {
  return res.json({
    success: true,
    bundles: VOTE_BUNDLES.map((bundle) => ({
      id: bundle.id,
      votes: bundle.votes,
      price: bundle.price,
      currency: 'USD',
    })),
    supportedCurrencies: ['USD', 'NGN'],
    decimals: USDC_DECIMALS,
    mint: SOLANA_USDC_MINT,
  });
});

router.get('/flutterwave/callback', async (req: Request, res: Response): Promise<void> => {
  const txRef = String(req.query.tx_ref || req.query.txRef || '');
  const transactionId = String(req.query.transaction_id || req.query.transactionId || '');
  const status = String(req.query.status || '').toLowerCase();

  let appRedirect = resolveAppRedirectUrl();
  try {
    if (!txRef) {
      throw new AppError('tx_ref missing in callback', 400);
    }

    const payment = await findFlutterwavePaymentByRef(txRef);
    if (!payment) {
      throw new AppError('Payment not found for tx_ref', 404);
    }

    appRedirect = resolveAppRedirectUrl((payment.metadata as any)?.appRedirectUrl);

    if (status === 'cancelled') {
      res.redirect(
        302,
        appendQueryParams(appRedirect, {
          status: 'cancelled',
          tx_ref: txRef,
          paymentId: payment.id,
        })
      );
      return;
    }

    const finalized =
      payment.paymentType === 'ROLLEY_STAKE'
        ? await finalizeFlutterwaveRolleyPayment({
            payment,
            transactionId: transactionId || undefined,
            txRef,
          })
        : await finalizeFlutterwaveVotePayment({
            payment,
            transactionId: transactionId || undefined,
            txRef,
          });

    res.redirect(
      302,
      appendQueryParams(appRedirect, {
        status: 'completed',
        tx_ref: txRef,
        paymentId: finalized.payment.id,
        transaction_id: finalized.transactionId,
      })
    );
  } catch (error) {
    logger.error('Flutterwave callback processing error', { error, txRef, transactionId, status });
    res.redirect(
      302,
      appendQueryParams(appRedirect, {
        status: 'failed',
        tx_ref: txRef,
      })
    );
  }
});

router.post('/flutterwave/webhook', async (req: Request, res: Response): Promise<Response> => {
  const expectedHash = process.env.FLUTTERWAVE_WEBHOOK_HASH || '';
  const receivedHash = String(req.headers['verif-hash'] || '');

  if (expectedHash && receivedHash !== expectedHash) {
    return res.status(401).json({ success: false, message: 'Invalid webhook signature' });
  }

  const payload = req.body || {};
  const data = payload?.data || {};
  const txRef = String(data?.tx_ref || '');
  const transactionId = data?.id ? String(data.id) : undefined;
  const paymentStatus = String(data?.status || '').toLowerCase();

  try {
    if (!txRef) {
      return res.status(200).json({ success: true, message: 'Ignored: missing tx_ref' });
    }

    const payment = await findFlutterwavePaymentByRef(txRef);
    if (!payment) {
      return res.status(200).json({ success: true, message: 'Ignored: payment not found' });
    }

    if (paymentStatus !== 'successful') {
      if (payment.status !== 'COMPLETED') {
        await prisma.payment.update({
          where: { id: payment.id },
          data: {
            status: 'FAILED',
            metadata: {
              ...(payment.metadata as any),
              flutterwaveWebhook: payload,
            },
          },
        });
      }
      return res.status(200).json({ success: true, message: 'Marked as failed' });
    }

    if (payment.paymentType === 'ROLLEY_STAKE') {
      await finalizeFlutterwaveRolleyPayment({
        payment,
        transactionId,
        txRef,
      });
    } else {
      await finalizeFlutterwaveVotePayment({
        payment,
        transactionId,
        txRef,
      });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    logger.error('Flutterwave webhook processing error', { error, txRef, transactionId });
    return res.status(500).json({ success: false, message: 'Webhook processing failed' });
  }
});

router.post('/flutterwave/rolley/create', async (req: Request, res: Response): Promise<Response | void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      throw new AppError('User not authenticated', 401);
    }

    const { sport, amount, lockDays, redirectUrl } = req.body || {};
    if (sport !== 'SOCCER' && sport !== 'BASKETBALL') {
      throw new AppError('Sport must be SOCCER or BASKETBALL', 400);
    }
    const parsedAmount = Number(amount);
    const parsedLockDays = Number(lockDays);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      throw new AppError('Amount must be greater than zero', 400);
    }
    if (!Number.isInteger(parsedLockDays) || parsedLockDays < 5 || parsedLockDays > 30) {
      throw new AppError('Lock days must be between 5 and 30', 400);
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new AppError('User not found', 404);
    }

    const txRef = `ROLLEY_${userId}_${Date.now()}`;
    const currency = resolveFlutterwaveCurrency(req.body?.currency, user);
    const chargeAmount = await resolveFlutterwaveAmount(parsedAmount, currency);
    const customerEmail = normalizeEmail(user.email, userId);
    const appRedirectUrl = resolveAppRedirectUrl(redirectUrl);
    const flutterwaveRedirectUrl = resolveFlutterwaveProviderRedirect(req);

    const payment = await prisma.payment.create({
      data: {
        userId,
        paymentType: 'ROLLEY_STAKE',
        chain: 'FLUTTERWAVE',
        amount: chargeAmount,
        amountRaw: chargeAmount.toFixed(2),
        currency,
        tokenAddress: 'FLUTTERWAVE',
        fromAddress: customerEmail,
        toAddress: 'FLUTTERWAVE',
        status: 'PENDING',
        metadata: {
          txRef,
          appRedirectUrl,
          sport,
          lockDays: parsedLockDays,
          stakeAsset: 'USD',
          usdAmount: parsedAmount,
          fxRate: currency !== 'USD' ? await getUsdFxRate(currency) : null,
        },
      },
    });

    const phone = normalizePhone(user.phone || '');
    const logo = process.env.FLUTTERWAVE_LOGO_URL || process.env.MEDIA_CDN_BASE || '';
    const initPayload = {
      email: customerEmail,
      amount: chargeAmount,
      currency,
      tx_ref: txRef,
      customer: {
        email: customerEmail,
        name: user.displayName || user.username || 'Banter User',
        phonenumber: phone,
        phone_number: phone,
      },
      meta: {
        paymentId: payment.id,
        userId,
        sport,
        lockDays: parsedLockDays,
        purpose: 'ROLLEY_STAKE',
      },
      customizations: {
        title: 'Rolley Managed Rollover',
        description: `${sport} rollover for ${parsedLockDays} days`,
        ...(logo ? { logo } : {}),
      },
      redirect_url: flutterwaveRedirectUrl,
      payment_options: resolveFlutterwavePaymentOptions(user),
    };

    const initResult = await initializeFlutterwavePayment(initPayload);

    return res.json({
      success: true,
      paymentId: payment.id,
      reference: txRef,
      paymentUrl: initResult.data.link,
      amount: chargeAmount,
      currency,
      sport,
      lockDays: parsedLockDays,
    });
  } catch (error) {
    const fwError = (error as any)?.response?.data || (error as any)?.message || error;
    logger.error('Create Flutterwave Rolley payment error', { error: fwError });
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    const message =
      (error as any)?.response?.data?.message ||
      (typeof fwError === 'string' ? fwError : 'Failed to create payment');
    return res.status(500).json({ success: false, message });
  }
});

router.post('/flutterwave/rolley/verify', async (req: Request, res: Response): Promise<Response | void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      throw new AppError('User not authenticated', 401);
    }

    const { paymentId, transactionId, txRef } = req.body || {};
    if (!paymentId) {
      throw new AppError('paymentId is required', 400);
    }

    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) {
      throw new AppError('Payment not found', 404);
    }
    if (payment.userId !== userId) {
      throw new AppError('Not authorized to verify this payment', 403);
    }
    if (payment.paymentType !== 'ROLLEY_STAKE') {
      throw new AppError('Payment is not a Rolley stake payment', 400);
    }

    const finalized = await finalizeFlutterwaveRolleyPayment({
      payment,
      transactionId,
      txRef,
    });

    return res.json({ success: true, payment: finalized.payment });
  } catch (error) {
    logger.error('Verify Flutterwave Rolley payment error', { error });
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    return res.status(500).json({ success: false, message: 'Failed to verify payment' });
  }
});

router.get('/flutterwave/rolley/status/:paymentId', async (req: Request, res: Response): Promise<Response | void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      throw new AppError('User not authenticated', 401);
    }

    const paymentId = req.params.paymentId;
    if (!paymentId) {
      throw new AppError('paymentId is required', 400);
    }

    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) {
      throw new AppError('Payment not found', 404);
    }
    if (payment.userId !== userId) {
      throw new AppError('Not authorized to access this payment', 403);
    }
    if (payment.paymentType !== 'ROLLEY_STAKE') {
      throw new AppError('Payment is not a Rolley stake payment', 400);
    }

    return res.json({
      success: true,
      payment: {
        id: payment.id,
        status: payment.status,
        txHash: payment.txHash,
        chain: payment.chain,
        completedAt: payment.completedAt,
        metadata: payment.metadata,
      },
    });
  } catch (error) {
    logger.error('Get Flutterwave Rolley payment status error', { error });
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    return res.status(500).json({ success: false, message: 'Failed to get payment status' });
  }
});

router.post('/flutterwave/votes/create', async (req: Request, res: Response): Promise<Response | void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      throw new AppError('User not authenticated', 401);
    }

    const { bundleId, redirectUrl } = req.body || {};
    logger.error('Flutterwave create request', { userId, bundleId, redirectUrl });
    if (!bundleId || typeof bundleId !== 'string') {
      throw new AppError('Bundle ID is required', 400);
    }

    const bundle = findBundle(bundleId);
    if (!bundle) {
      throw new AppError('Invalid bundle', 400);
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new AppError('User not found', 404);
    }

    const txRef = `BANTER_${userId}_${Date.now()}`;
    const currency = resolveFlutterwaveCurrency(req.body?.currency, user);
    const chargeAmount = await resolveFlutterwaveAmount(bundle.price, currency);
    const customerEmail = normalizeEmail(user.email, userId);
    const appRedirectUrl = resolveAppRedirectUrl(redirectUrl);
    const flutterwaveRedirectUrl = resolveFlutterwaveProviderRedirect(req);

    const payment = await prisma.payment.create({
      data: {
        userId,
        paymentType: 'VOTE_PURCHASE',
        chain: 'FLUTTERWAVE',
        amount: chargeAmount,
        amountRaw: chargeAmount.toFixed(2),
        currency,
        tokenAddress: 'FLUTTERWAVE',
        fromAddress: customerEmail,
        toAddress: 'FLUTTERWAVE',
        status: 'PENDING',
        metadata: {
          bundleId: bundle.id,
          votes: bundle.votes,
          txRef,
          appRedirectUrl,
          usdAmount: bundle.price,
            fxRate: currency !== 'USD' ? await getUsdFxRate(currency) : null,
        },
      },
    });

    const phone = normalizePhone(user.phone || '');
    const logo = process.env.FLUTTERWAVE_LOGO_URL || process.env.MEDIA_CDN_BASE || '';

    const initPayload = {
      email: customerEmail,
      amount: chargeAmount,
      currency,
      tx_ref: txRef,
      customer: {
        email: customerEmail,
        name: user.displayName || user.username || 'Banter User',
        phonenumber: phone,
        phone_number: phone,
      },
      meta: {
        paymentId: payment.id,
        userId,
        bundleId: bundle.id,
      },
      customizations: {
        title: 'Banter Vote Purchase',
        description: `${bundle.votes} votes`,
        ...(logo ? { logo } : {}),
      },
      redirect_url: flutterwaveRedirectUrl,
      // Ensure card checkout is allowed
      payment_options: resolveFlutterwavePaymentOptions(user),
    };
    logger.error('Flutterwave init payload', { initPayload });
    const initResult = await initializeFlutterwavePayment(initPayload);

    return res.json({
      success: true,
      paymentId: payment.id,
      reference: txRef,
      paymentUrl: initResult.data.link,
      amount: chargeAmount,
      currency,
    });
  } catch (error) {
    const fwError = (error as any)?.response?.data || (error as any)?.message || error;
    logger.error('Create Flutterwave vote payment error', { error: fwError });
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    const details =
      (error as any)?.response?.data ||
      (error as any)?.message ||
      'Failed to create payment';
    const message =
      (error as any)?.response?.data?.message ||
      (typeof details === 'string' ? details : 'Failed to create payment');
    return res.status(500).json({ success: false, message, details });
  }
});

router.post('/flutterwave/votes/verify', async (req: Request, res: Response): Promise<Response | void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      throw new AppError('User not authenticated', 401);
    }

    const { paymentId, transactionId, txRef } = req.body || {};
    if (!paymentId) {
      throw new AppError('paymentId is required', 400);
    }

    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) {
      throw new AppError('Payment not found', 404);
    }
    if (payment.userId !== userId) {
      throw new AppError('Not authorized to verify this payment', 403);
    }
    const finalized = await finalizeFlutterwaveVotePayment({
      payment,
      transactionId,
      txRef,
    });

    return res.json({ success: true, payment: finalized.payment });
  } catch (error) {
    logger.error('Verify Flutterwave vote payment error', { error });
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    return res.status(500).json({ success: false, message: 'Failed to verify payment' });
  }
});

router.get('/flutterwave/votes/status/:paymentId', async (req: Request, res: Response): Promise<Response | void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      throw new AppError('User not authenticated', 401);
    }

    const paymentId = req.params.paymentId;
    if (!paymentId) {
      throw new AppError('paymentId is required', 400);
    }

    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) {
      throw new AppError('Payment not found', 404);
    }
    if (payment.userId !== userId) {
      throw new AppError('Not authorized to access this payment', 403);
    }

    return res.json({
      success: true,
      payment: {
        id: payment.id,
        status: payment.status,
        txHash: payment.txHash,
        chain: payment.chain,
        completedAt: payment.completedAt,
      },
    });
  } catch (error) {
    logger.error('Get Flutterwave payment status error', { error });
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    return res.status(500).json({ success: false, message: 'Failed to get payment status' });
  }
});

router.post('/movement/votes/create', async (req: Request, res: Response): Promise<Response | void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      throw new AppError('User not authenticated', 401);
    }

    if (!MOVEMENT_USDC_ADDRESS || !MOVEMENT_USDC_RECEIVER) {
      throw new AppError('Movement payment receiver not configured', 500);
    }

    const { bundleId } = req.body || {};
    if (!bundleId || typeof bundleId !== 'string') {
      throw new AppError('Bundle ID is required', 400);
    }

    const bundle = findBundle(bundleId);
    if (!bundle) {
      throw new AppError('Invalid bundle', 400);
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.movementAddress) {
      throw new AppError('Movement wallet not found', 400);
    }
    await ensureMovementAccountExists(user.movementAddress);

    const rawAmount = Math.round(bundle.price * 10 ** MOVEMENT_USDC_DECIMALS).toString();

    const payment = await prisma.payment.create({
      data: {
        userId,
        paymentType: 'VOTE_PURCHASE',
        chain: 'MOVEMENT',
        amount: bundle.price,
        amountRaw: rawAmount,
        currency: 'USDC',
        tokenAddress: MOVEMENT_USDC_ADDRESS,
        fromAddress: user.movementAddress,
        toAddress: MOVEMENT_USDC_RECEIVER,
        status: 'PENDING',
        metadata: {
          bundleId: bundle.id,
          votes: bundle.votes,
        },
      },
    });

    const clientSidePayload = {
      success: true,
      paymentId: payment.id,
      chain: 'MOVEMENT',
      fromAddress: payment.fromAddress,
      toAddress: payment.toAddress,
      amount: payment.amount,
      amountRaw: payment.amountRaw,
      tokenAddress: payment.tokenAddress,
      decimals: MOVEMENT_USDC_DECIMALS,
      transactionData: {
        type: 'entry_function_payload',
        function: '0x1::primary_fungible_store::transfer',
        type_arguments: ['0x1::fungible_asset::Metadata'],
        arguments: [MOVEMENT_USDC_ADDRESS, MOVEMENT_USDC_RECEIVER, rawAmount],
      },
      message: 'Send Movement USDC.e to complete this purchase.',
    };

    // Keep Movement payment flow aligned with CTO:
    // backend prepares payment + transaction payload, frontend signs/submits, backend verifies.
    return res.json(clientSidePayload);
  } catch (error) {
    logger.error('Create Movement vote payment error', { error });
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    const errorMessage =
      (error as any)?.response?.data?.message ||
      (error as Error)?.message ||
      'Failed to create payment';
    return res.status(500).json({ success: false, message: errorMessage });
  }
});

router.post('/movement/votes/verify', async (req: Request, res: Response): Promise<Response | void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      throw new AppError('User not authenticated', 401);
    }

    const { paymentId, txHash } = req.body || {};
    if (!paymentId || !txHash) {
      throw new AppError('paymentId and txHash are required', 400);
    }

    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) {
      throw new AppError('Payment not found', 404);
    }

    if (payment.userId !== userId) {
      throw new AppError('Not authorized to verify this payment', 403);
    }

    if (payment.status === 'COMPLETED') {
      return res.json({ success: true, payment, message: 'Payment already verified' });
    }

    const tx = await fetchMovementTransactionWithRetry(txHash);
    if (!tx?.success) {
      throw new AppError('Transaction not confirmed', 400);
    }

    const sender = normalizeAddress(tx.sender || '');
    if (sender !== normalizeAddress(payment.fromAddress)) {
      throw new AppError('Transaction sender mismatch', 400);
    }

    const payload = tx.payload || {};
    const func = (payload.function || payload.entry_function_id || '').toString();
    const typeArgs = (payload.type_arguments || payload.typeArguments || []) as string[];
    const args = (payload.arguments || payload.functionArguments || []) as any[];

    let receiverArg = '';
    let amountArg = '';
    let tokenArg = '';

    if (func.includes('primary_fungible_store::transfer')) {
      // args: [metadata_address, recipient, amount]
      tokenArg = extractAddressArg(args[0] || '');
      receiverArg = extractAddressArg(args[1] || '');
      amountArg = args[2] || '';
    } else {
      // coin::transfer args: [recipient, amount]
      receiverArg = extractAddressArg(args[0] || '');
      amountArg = args[1] || '';
      tokenArg = typeArgs[0] || '';
    }

    if (!receiverArg || normalizeAddress(receiverArg) !== normalizeAddress(payment.toAddress)) {
      throw new AppError('Transaction receiver mismatch', 400);
    }

    if (
      tokenArg &&
      normalizeAddress(tokenArg) !== normalizeAddress(payment.tokenAddress)
    ) {
      throw new AppError('Token mismatch', 400);
    }

    const paid = extractAmountArg(amountArg);
    const required = BigInt(payment.amountRaw);
    if (paid < required) {
      throw new AppError('Payment amount mismatch', 400);
    }

    const updated = await prisma.$transaction(async (txDb) => {
      const updatedPayment = await txDb.payment.update({
        where: { id: paymentId },
        data: {
          status: 'COMPLETED',
          txHash,
          completedAt: new Date(),
          metadata: {
            ...(payment.metadata as any),
            movement: tx,
          },
        },
      });

      const bundleVotes = Number((payment.metadata as any)?.votes || 0);
      if (bundleVotes > 0) {
        await txDb.user.update({
          where: { id: userId },
          data: {
            voteBalance: {
              increment: bundleVotes,
            },
          },
        });
      }

      const wallet = await txDb.wallet.findFirst({
        where: {
          userId,
          blockchain: 'MOVEMENT',
        },
      });

      if (wallet) {
        await txDb.walletTransaction.upsert({
          where: { txHash },
          create: {
            walletId: wallet.id,
            txHash,
            txType: 'PAYMENT',
            amount: payment.amountRaw,
            tokenAddress: payment.tokenAddress,
            tokenSymbol: 'USDC.e',
            fromAddress: payment.fromAddress,
            toAddress: payment.toAddress,
            status: 'COMPLETED',
            description: 'Vote bundle purchase',
            paymentId: payment.id,
            metadata: {
              bundleId: (payment.metadata as any)?.bundleId,
              votes: (payment.metadata as any)?.votes,
            },
          },
          update: {
            status: 'COMPLETED',
            paymentId: payment.id,
          },
        });
      }

      return updatedPayment;
    });

    await notifyVotePurchaseCompleted(updated as any);

    return res.json({ success: true, payment: updated });
  } catch (error) {
    logger.error('Verify Movement vote payment error', { error });
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    const errorMessage =
      (error as any)?.response?.data?.message ||
      (error as Error)?.message ||
      'Failed to verify payment';
    return res.status(500).json({ success: false, message: errorMessage });
  }
});

router.post('/solana/votes/create', async (req: Request, res: Response): Promise<Response | void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      throw new AppError('User not authenticated', 401);
    }

    const { bundleId } = req.body || {};
    if (!bundleId || typeof bundleId !== 'string') {
      throw new AppError('Bundle ID is required', 400);
    }

    const bundle = findBundle(bundleId);
    if (!bundle) {
      throw new AppError('Invalid bundle', 400);
    }

    if (!SOLANA_USDC_RECEIVER) {
      throw new AppError('Payment receiver not configured', 500);
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.solanaAddress) {
      throw new AppError('Solana wallet not found', 400);
    }

    const rawAmount = priceToRaw(bundle.price);

    const payment = await prisma.payment.create({
      data: {
        userId,
        paymentType: 'VOTE_PURCHASE',
        chain: 'SOLANA',
        amount: bundle.price,
        amountRaw: rawAmount,
        currency: 'USDC',
        tokenAddress: SOLANA_USDC_MINT,
        fromAddress: user.solanaAddress,
        toAddress: SOLANA_USDC_RECEIVER,
        status: 'PENDING',
        metadata: {
          bundleId: bundle.id,
          votes: bundle.votes,
        },
      },
    });
    const memo = `BANV${payment.id.slice(-8).toUpperCase()}`;
    const paymentWithMemo = await prisma.payment.update({
      where: { id: payment.id },
      data: {
        metadata: {
          ...(payment.metadata as any),
          memo,
        },
      },
    });

    return res.json({
      success: true,
      paymentId: paymentWithMemo.id,
      chain: 'SOLANA',
      fromAddress: paymentWithMemo.fromAddress,
      toAddress: paymentWithMemo.toAddress,
      amount: paymentWithMemo.amount,
      amountRaw: paymentWithMemo.amountRaw,
      tokenMint: SOLANA_USDC_MINT,
      decimals: USDC_DECIMALS,
      memo,
      message: 'Send USDC to the address below, include the memo, then paste the transaction hash to verify.',
    });
  } catch (error) {
    logger.error('Create Solana vote payment error', { error });
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    return res.status(500).json({ success: false, message: 'Failed to create payment' });
  }
});

router.post('/solana/votes/verify', async (req: Request, res: Response): Promise<Response | void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      throw new AppError('User not authenticated', 401);
    }

    const { paymentId, txHash } = req.body || {};
    if (!paymentId || !txHash) {
      throw new AppError('paymentId and txHash are required', 400);
    }

    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) {
      throw new AppError('Payment not found', 404);
    }

    if (payment.userId !== userId) {
      throw new AppError('Not authorized to verify this payment', 403);
    }

    if (payment.status === 'COMPLETED') {
      return res.json({ success: true, payment, message: 'Payment already verified' });
    }

    const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
    const parsed = await connection.getParsedTransaction(txHash, {
      maxSupportedTransactionVersion: 0,
    });

    if (!parsed || parsed.meta?.err) {
      throw new AppError('Transaction not confirmed', 400);
    }

    const receiver = payment.toAddress;
    const mint = payment.tokenAddress;

    const delta = getSolanaBalanceDelta(parsed, receiver, mint);

    const required = BigInt(payment.amountRaw);
    if (delta < required) {
      throw new AppError('Payment amount mismatch', 400);
    }

    const memo = extractSolanaMemo(parsed);
    const expectedMemo = normalizeMemo((payment.metadata as any)?.memo || '');
    if (!memo) {
      throw new AppError('Payment memo is missing', 400);
    }
    if (!expectedMemo || memo !== expectedMemo) {
      throw new AppError('Payment memo mismatch', 400);
    }

    const updated = await prisma.$transaction(async (tx) => {
      const updatedPayment = await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: 'COMPLETED',
          txHash,
          completedAt: new Date(),
        },
      });

      const bundleVotes = Number((payment.metadata as any)?.votes || 0);
      if (bundleVotes > 0) {
        await tx.user.update({
          where: { id: userId },
          data: {
            voteBalance: {
              increment: bundleVotes,
            },
          },
        });
      }

      const wallet = await tx.wallet.findFirst({
        where: {
          userId,
          blockchain: 'SOLANA',
        },
      });

      if (wallet) {
        await tx.walletTransaction.create({
          data: {
            walletId: wallet.id,
            txHash,
            txType: 'PAYMENT',
            amount: payment.amountRaw,
            tokenAddress: payment.tokenAddress,
            tokenSymbol: 'USDC',
            fromAddress: payment.fromAddress,
            toAddress: payment.toAddress,
            status: 'COMPLETED',
            description: 'Vote bundle purchase',
            paymentId: payment.id,
            metadata: {
              bundleId: (payment.metadata as any)?.bundleId,
              votes: (payment.metadata as any)?.votes,
            },
          },
        });
      }

      return updatedPayment;
    });

    await notifyVotePurchaseCompleted(updated as any);

    return res.json({ success: true, payment: updated });
  } catch (error) {
    logger.error('Verify Solana vote payment error', { error });
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    return res.status(500).json({ success: false, message: 'Failed to verify payment' });
  }
});

router.post('/solana/rolley/create', async (req: Request, res: Response): Promise<Response | void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      throw new AppError('User not authenticated', 401);
    }

    const { sport, amount, lockDays } = req.body || {};
    const parsedAmount = Number(amount);
    const parsedLockDays = Number(lockDays);
    const normalizedSport = String(sport || '').toUpperCase();
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      throw new AppError('Amount must be greater than zero', 400);
    }
    if (!Number.isFinite(parsedLockDays) || parsedLockDays <= 0) {
      throw new AppError('Lock days must be greater than zero', 400);
    }
    if (normalizedSport !== 'SOCCER' && normalizedSport !== 'BASKETBALL') {
      throw new AppError('Invalid sport selection', 400);
    }
    if (!SOLANA_USDC_RECEIVER) {
      throw new AppError('Payment receiver not configured', 500);
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.solanaAddress) {
      throw new AppError('Solana wallet not found', 400);
    }

    const rawAmount = priceToRaw(parsedAmount);
    const payment = await prisma.payment.create({
      data: {
        userId,
        paymentType: 'ROLLEY_STAKE',
        chain: 'SOLANA',
        amount: parsedAmount,
        amountRaw: rawAmount,
        currency: 'USDC',
        tokenAddress: SOLANA_USDC_MINT,
        fromAddress: user.solanaAddress,
        toAddress: SOLANA_USDC_RECEIVER,
        status: 'PENDING',
        metadata: {
          sport: normalizedSport,
          lockDays: parsedLockDays,
        },
      },
    });
    const memo = `BAN${payment.id.slice(-8).toUpperCase()}`;
    const paymentWithMemo = await prisma.payment.update({
      where: { id: payment.id },
      data: {
        metadata: {
          ...(payment.metadata as any),
          memo,
        },
      },
    });

    return res.json({
      success: true,
      paymentId: payment.id,
      chain: 'SOLANA',
      fromAddress: paymentWithMemo.fromAddress,
      toAddress: paymentWithMemo.toAddress,
      amount: paymentWithMemo.amount,
      amountRaw: paymentWithMemo.amountRaw,
      tokenMint: SOLANA_USDC_MINT,
      decimals: USDC_DECIMALS,
      memo,
      message: 'Send USDC to the address below, then paste the transaction hash to verify.',
    });
  } catch (error) {
    logger.error('Create Solana rolley payment error', { error });
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    return res.status(500).json({ success: false, message: 'Failed to create payment' });
  }
});

router.post('/solana/rolley/verify', async (req: Request, res: Response): Promise<Response | void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      throw new AppError('User not authenticated', 401);
    }

    const { paymentId, txHash } = req.body || {};
    if (!paymentId || !txHash) {
      throw new AppError('paymentId and txHash are required', 400);
    }

    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) {
      throw new AppError('Payment not found', 404);
    }
    if (payment.userId !== userId) {
      throw new AppError('Not authorized to verify this payment', 403);
    }
    if (payment.status === 'COMPLETED') {
      return res.json({ success: true, payment, message: 'Payment already verified' });
    }

    const connection = new Connection(SOLANA_RPC_URL, 'finalized');
    const parsed = await connection.getParsedTransaction(txHash, {
      maxSupportedTransactionVersion: 0,
    });

    if (!parsed || parsed.meta?.err) {
      throw new AppError('Transaction not confirmed', 400);
    }

    const receiver = payment.toAddress;
    const mint = payment.tokenAddress;
    const delta = getSolanaBalanceDelta(parsed, receiver, mint);

    const required = BigInt(payment.amountRaw);
    if (delta < required) {
      throw new AppError('Payment amount mismatch', 400);
    }

    const memo = extractSolanaMemo(parsed);
    const expectedMemo = normalizeMemo((payment.metadata as any)?.memo || '');
    if (!memo) {
      throw new AppError('Payment memo is missing', 400);
    }
    if (!expectedMemo || memo !== expectedMemo) {
      throw new AppError('Payment memo mismatch', 400);
    }

    const metadata = (payment.metadata as any) || {};
    const sport = String(metadata?.sport || '').toUpperCase();
    const lockDays = Number(metadata?.lockDays || 0);
    if ((sport !== 'SOCCER' && sport !== 'BASKETBALL') || !lockDays) {
      throw new AppError('Rolley payment metadata is invalid', 400);
    }

    const stake = await createRolleyStakePosition({
      userId: payment.userId,
      paymentId: payment.id,
      sport: sport as 'SOCCER' | 'BASKETBALL',
      amount: payment.amount,
      lockDays,
      stakeAsset: 'USDC',
    });

    const updated = await prisma.$transaction(async (tx) => {
      const updatedPayment = await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: 'COMPLETED',
          txHash,
          completedAt: new Date(),
          metadata: {
            ...(payment.metadata as any),
            rolleyStakeId: stake?.id || null,
            rolleyStake: stake || null,
          },
        },
      });

      try {
        await awardFirstRolleyStakePoints(tx, {
          userId: payment.userId,
          stakeId: String(stake?.id || payment.id),
          stakeCreatedAt: stake?.created_at || null,
        });
      } catch (error) {
        logger.warn('Failed to award first Rolley stake points', { error, userId: payment.userId });
      }

      return updatedPayment;
    });

    await notifyRolleyStakeFunded(updated as any);

    return res.json({ success: true, payment: updated });
  } catch (error) {
    logger.error('Verify Solana rolley payment error', { error });
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    return res.status(500).json({ success: false, message: 'Failed to verify payment' });
  }
});

export default router;
