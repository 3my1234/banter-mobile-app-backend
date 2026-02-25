import { Router, Request, Response } from 'express';
import { Connection } from '@solana/web3.js';
import axios from 'axios';
import { prisma } from '../index';
import { logger } from '../utils/logger';
import { AppError } from '../utils/errorHandler';
import {
  initializeFlutterwavePayment,
  verifyFlutterwavePayment,
  findFlutterwaveTransactionByRef,
} from './flutterwave';

const router = Router();

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const SOLANA_USDC_MINT =
  process.env.SOLANA_USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOLANA_USDC_RECEIVER =
  process.env.SOLANA_USDC_RECEIVER || process.env.SOLANA_ADMIN_WALLET || '';
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
  const raw = (value || '').trim();
  if (raw.includes('@') && raw.includes('.')) {
    return raw;
  }
  return `user-${userId}@banter.app`;
};

const getMovementRpcUrls = () => {
  const urls = [MOVEMENT_RPC_URL, MOVEMENT_RPC_FALLBACK]
    .map((u) => (u || '').trim())
    .filter((u) => u.length > 0);
  return Array.from(new Set(urls));
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

const isHttpsUrl = (value?: string | null) =>
  typeof value === 'string' && value.trim().toLowerCase().startsWith('https://');

const resolveFlutterwaveRedirect = (input?: string) => {
  if (isHttpsUrl(input)) return input!.trim();
  if (isHttpsUrl(process.env.FLUTTERWAVE_REDIRECT_URL)) {
    return process.env.FLUTTERWAVE_REDIRECT_URL!.trim();
  }
  if (isHttpsUrl(process.env.FRONTEND_URL)) {
    return process.env.FRONTEND_URL!.trim();
  }
  return 'https://sportbanter.online';
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
    decimals: USDC_DECIMALS,
    mint: SOLANA_USDC_MINT,
  });
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
    const currency = 'USD';
    const customerEmail = normalizeEmail(user.email, userId);

    const payment = await prisma.payment.create({
      data: {
        userId,
        paymentType: 'VOTE_PURCHASE',
        chain: 'FLUTTERWAVE',
        amount: bundle.price,
        amountRaw: bundle.price.toFixed(2),
        currency,
        tokenAddress: 'FLUTTERWAVE',
        fromAddress: user.email,
        toAddress: 'FLUTTERWAVE',
        status: 'PENDING',
        metadata: {
          bundleId: bundle.id,
          votes: bundle.votes,
          txRef,
        },
      },
    });

    const redirect = resolveFlutterwaveRedirect(redirectUrl);

    const phone = normalizePhone(user.phone || '');
    const logo = process.env.FLUTTERWAVE_LOGO_URL || process.env.MEDIA_CDN_BASE || '';

    const initPayload = {
      email: customerEmail,
      amount: bundle.price,
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
      redirect_url: redirect,
      // Ensure card checkout is allowed
      payment_options: 'card',
    };
    logger.error('Flutterwave init payload', { initPayload });
    const initResult = await initializeFlutterwavePayment(initPayload);

    return res.json({
      success: true,
      paymentId: payment.id,
      reference: txRef,
      paymentUrl: initResult.data.link,
      amount: bundle.price,
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
    if (payment.status === 'COMPLETED') {
      return res.json({ success: true, payment, message: 'Payment already verified' });
    }

    let resolvedTransactionId = transactionId;
    if (!resolvedTransactionId && txRef) {
      resolvedTransactionId = await findFlutterwaveTransactionByRef(txRef);
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

    if (verification.data.amount < payment.amount) {
      throw new AppError('Payment amount mismatch', 400);
    }

    const updated = await prisma.$transaction(async (tx) => {
      const updatedPayment = await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: 'COMPLETED',
          txHash: String(resolvedTransactionId),
          completedAt: new Date(),
          metadata: {
            ...(payment.metadata as any),
            flutterwave: verification.data,
          },
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

      return updatedPayment;
    });

    return res.json({ success: true, payment: updated });
  } catch (error) {
    logger.error('Verify Flutterwave vote payment error', { error });
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    return res.status(500).json({ success: false, message: 'Failed to verify payment' });
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

    return res.json({
      success: true,
      paymentId: payment.id,
      chain: 'MOVEMENT',
      fromAddress: payment.fromAddress,
      toAddress: payment.toAddress,
      amount: payment.amount,
      amountRaw: payment.amountRaw,
      tokenAddress: payment.tokenAddress,
      decimals: MOVEMENT_USDC_DECIMALS,
      message: 'Send Movement USDC.e to complete this purchase.',
    });
  } catch (error) {
    logger.error('Create Movement vote payment error', { error });
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    return res.status(500).json({ success: false, message: 'Failed to create payment' });
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
    const args = (payload.arguments || payload.functionArguments || []) as string[];

    let receiverArg = '';
    let amountArg = '';
    let tokenArg = '';

    if (func.includes('primary_fungible_store::transfer')) {
      // args: [metadata_address, recipient, amount]
      tokenArg = args[0] || '';
      receiverArg = args[1] || '';
      amountArg = args[2] || '';
    } else {
      // coin::transfer args: [recipient, amount]
      receiverArg = args[0] || '';
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

    const paid = BigInt(amountArg || '0');
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
        await txDb.walletTransaction.create({
          data: {
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
        });
      }

      return updatedPayment;
    });

    return res.json({ success: true, payment: updated });
  } catch (error) {
    logger.error('Verify Movement vote payment error', { error });
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    return res.status(500).json({ success: false, message: 'Failed to verify payment' });
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

    return res.json({
      success: true,
      paymentId: payment.id,
      chain: 'SOLANA',
      fromAddress: payment.fromAddress,
      toAddress: payment.toAddress,
      amount: payment.amount,
      amountRaw: payment.amountRaw,
      tokenMint: SOLANA_USDC_MINT,
      decimals: USDC_DECIMALS,
      message: 'Transaction ready. Sign and submit with your Solana wallet.',
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

    const preBalances = parsed.meta?.preTokenBalances || [];
    const postBalances = parsed.meta?.postTokenBalances || [];

    const findBalance = (balances: typeof preBalances) =>
      balances.find(
        (b) =>
          b.owner === receiver &&
          b.mint === mint
      );

    const pre = findBalance(preBalances);
    const post = findBalance(postBalances);

    const preAmount = BigInt(pre?.uiTokenAmount?.amount || '0');
    const postAmount = BigInt(post?.uiTokenAmount?.amount || '0');
    const delta = postAmount - preAmount;

    const required = BigInt(payment.amountRaw);
    if (delta < required) {
      throw new AppError('Payment amount mismatch', 400);
    }

    const signers = parsed.transaction.message.accountKeys
      .filter((key) => key.signer)
      .map((key) => key.pubkey.toBase58());

    if (!signers.includes(payment.fromAddress)) {
      throw new AppError('Transaction signer mismatch', 400);
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

    return res.json({ success: true, payment: updated });
  } catch (error) {
    logger.error('Verify Solana vote payment error', { error });
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    return res.status(500).json({ success: false, message: 'Failed to verify payment' });
  }
});

export default router;
