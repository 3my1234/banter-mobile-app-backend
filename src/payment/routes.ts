import { Router, Request, Response } from 'express';
import { Connection } from '@solana/web3.js';
import { prisma } from '../index';
import { logger } from '../utils/logger';
import { AppError } from '../utils/errorHandler';

const router = Router();

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const SOLANA_USDC_MINT =
  process.env.SOLANA_USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOLANA_USDC_RECEIVER =
  process.env.SOLANA_USDC_RECEIVER || process.env.SOLANA_ADMIN_WALLET || '';

const VOTE_BUNDLES = [
  { id: 'b1', votes: 10, price: 1.99 },
  { id: 'b2', votes: 100, price: 14.99 },
  { id: 'b3', votes: 1000, price: 99.99 },
];

const USDC_DECIMALS = 6;

const priceToRaw = (price: number) =>
  Math.round(price * 10 ** USDC_DECIMALS).toString();

const findBundle = (bundleId: string) =>
  VOTE_BUNDLES.find((bundle) => bundle.id === bundleId);

router.get('/votes/bundles', (_req: Request, res: Response): Response => {
  return res.json({
    success: true,
    bundles: VOTE_BUNDLES.map((bundle) => ({
      id: bundle.id,
      votes: bundle.votes,
      price: bundle.price,
      currency: 'USDC',
    })),
    decimals: USDC_DECIMALS,
    mint: SOLANA_USDC_MINT,
  });
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
