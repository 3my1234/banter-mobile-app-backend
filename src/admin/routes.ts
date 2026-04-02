import { Router, Request, Response } from 'express';
import { PcaCategoryType, PcaSport, Prisma } from '@prisma/client';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { prisma } from '../index';
import { AppError } from '../utils/errorHandler';
import { logger } from '../utils/logger';
import { adminAuthMiddleware, generateAdminToken } from './auth';
import { hardDeletePost } from '../post/service';

const router = Router();

const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'eu-north-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },
  requestChecksumCalculation: 'NEVER' as any,
} as any);

const BUCKET_NAME = process.env.S3_BUCKET_NAME || process.env.AWS_S3_BUCKET_NAME || 'banter-uploads';
const CDN_BASE = process.env.ASSETS_CDN_BASE || process.env.CLOUDFRONT_DOMAIN;

const normalizeBaseUrl = (value?: string): string | null => {
  if (!value) return null;
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
};

const CDN_BASE_URL = normalizeBaseUrl(CDN_BASE);

const getPublicUrl = (key: string): string => {
  if (CDN_BASE_URL) {
    const normalizedKey = key.startsWith('/') ? key.substring(1) : key;
    return `${CDN_BASE_URL}/${normalizedKey}`;
  }
  const region = process.env.AWS_REGION || 'eu-north-1';
  return `https://${BUCKET_NAME}.s3.${region}.amazonaws.com/${key}`;
};

const getBackendPublicBase = (req?: Request) => {
  const candidates = [
    process.env.BACKEND_PUBLIC_URL,
    process.env.API_URL,
    req ? `${req.protocol}://${req.get('host') || ''}` : '',
  ];
  const picked = candidates.find((value) => typeof value === 'string' && /^https?:\/\//i.test(value));
  if (!picked) return 'https://sportbanter.online';
  return picked.trim().replace(/\/+$/, '').replace(/\/api$/, '');
};

const parseSport = (value?: string): PcaSport => {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'SOCCER') return 'SOCCER';
  if (normalized === 'BASKETBALL') return 'BASKETBALL';
  throw new AppError('Invalid sport. Use SOCCER or BASKETBALL.', 400);
};

const parseCategoryType = (value?: string): PcaCategoryType => {
  const normalized = String(value || '').trim().toUpperCase();
  if ((Object.values(PcaCategoryType) as string[]).includes(normalized)) {
    return normalized as PcaCategoryType;
  }
  throw new AppError('Invalid categoryType', 400);
};

const parseJsonBody = (value: any) => {
  if (value == null || value === '') return null;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      throw new AppError('Invalid JSON payload', 400);
    }
  }
  throw new AppError('Invalid JSON payload', 400);
};

const serializeBigInts = (value: any): any => {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map((item) => serializeBigInts(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, serializeBigInts(item)])
    );
  }
  return value;
};

const getPagination = (req: Request) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 25)));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
};

const isTableMissingError = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2021';

const safePcaCount = async (model: 'pcaCategory' | 'pcaVote') => {
  try {
    return await (prisma as any)[model].count();
  } catch (error) {
    if (isTableMissingError(error)) {
      logger.warn(`PCA table missing during admin query: ${model}`);
      return 0;
    }
    throw error;
  }
};

const DEFAULT_AD_SETTINGS = {
  postFrequency: 6,
  banterFrequency: 8,
  isEnabled: true,
};

const getAdSettings = async () => {
  const existing = await prisma.adSettings.findFirst();
  if (existing) return existing;
  return prisma.adSettings.create({ data: DEFAULT_AD_SETTINGS });
};

const parsePlacement = (value?: string) => {
  const normalized = String(value || '').trim().toUpperCase();
  if (!normalized) return 'POST_FEED';
  if (normalized === 'POST_FEED' || normalized === 'BANTER_FEED') return normalized;
  throw new AppError('Invalid placement. Use POST_FEED or BANTER_FEED.', 400);
};

const parseBool = (value: any, fallback: boolean) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }
  return fallback;
};

const parseIntField = (value: any, fallback: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.floor(parsed));
};

const ACTIVITY_LIMIT_MAX = 200;
const ACTIVITY_SOURCE_LIMIT_MAX = 240;

type ActivityActor = {
  id: string;
  displayName: string | null;
  username: string | null;
  email: string | null;
};

type ActivityItem = {
  id: string;
  activityType: string;
  createdAt: Date;
  user: ActivityActor | null;
  title: string;
  description: string;
  metadata: Record<string, unknown>;
};

const parseDateQuery = (value: unknown) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError('Invalid before date. Use ISO date-time format.', 400);
  }
  return parsed;
};

const truncateText = (value: unknown, max = 140) => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
};

const shortId = (value?: string | null) => {
  if (!value) return '';
  if (value.length <= 8) return value;
  return value.slice(0, 8);
};

const toActivityActor = (user?: {
  id: string;
  displayName: string | null;
  username: string | null;
  email: string | null;
} | null): ActivityActor | null => {
  if (!user) return null;
  return {
    id: user.id,
    displayName: user.displayName,
    username: user.username,
    email: user.email,
  };
};

/**
 * POST /api/admin/auth/login
 */
router.post('/auth/login', async (req: Request, res: Response): Promise<void> => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    const adminPassword = String(process.env.ADMIN_PASSWORD || '');

    if (!adminEmail || !adminPassword) {
      throw new AppError('Admin credentials not configured', 500);
    }

    if (email !== adminEmail || password !== adminPassword) {
      throw new AppError('Invalid admin email or password', 401);
    }

    const token = generateAdminToken(email);
    res.json({
      success: true,
      token,
      admin: { email },
    });
    return;
  } catch (error) {
    logger.error('Admin login error', { error });
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({ success: false, message: 'Admin login failed' });
    return;
  }
});

router.use(adminAuthMiddleware);

/**
 * GET /api/admin/ads/settings
 */
router.get('/ads/settings', async (_req: Request, res: Response): Promise<void> => {
  try {
    const settings = await getAdSettings();
    res.json({ success: true, settings });
  } catch (error) {
    logger.error('Admin ad settings error', { error });
    res.status(500).json({ success: false, message: 'Failed to load ad settings' });
  }
});

/**
 * PUT /api/admin/ads/settings
 */
router.put('/ads/settings', async (req: Request, res: Response): Promise<void> => {
  try {
    const existing = await getAdSettings();
    const postFrequency = parseIntField(req.body?.postFrequency, existing.postFrequency);
    const banterFrequency = parseIntField(req.body?.banterFrequency, existing.banterFrequency);
    const isEnabled = parseBool(req.body?.isEnabled, existing.isEnabled);

    const updated = await prisma.adSettings.update({
      where: { id: existing.id },
      data: { postFrequency, banterFrequency, isEnabled },
    });

    res.json({ success: true, settings: updated });
  } catch (error) {
    logger.error('Admin update ad settings error', { error });
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({ success: false, message: 'Failed to update ad settings' });
  }
});

/**
 * GET /api/admin/ads
 */
router.get('/ads', async (req: Request, res: Response): Promise<void> => {
  try {
    const { page, limit, skip } = getPagination(req);
    const placement = req.query.placement ? parsePlacement(String(req.query.placement)) : undefined;
    const where: any = {};
    if (placement) where.placement = placement;
    const [total, ads] = await Promise.all([
      prisma.adCampaign.count({ where }),
      prisma.adCampaign.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
    ]);
    res.json({ success: true, ads, total, page, limit });
  } catch (error) {
    logger.error('Admin ads list error', { error });
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({ success: false, message: 'Failed to load ads' });
  }
});

/**
 * POST /api/admin/ads
 */
router.post('/ads', async (req: Request, res: Response): Promise<void> => {
  try {
    const title = String(req.body?.title || '').trim();
    if (!title) {
      throw new AppError('title is required', 400);
    }
    const placement = parsePlacement(req.body?.placement);
    const mediaType = req.body?.mediaType ? String(req.body.mediaType) : null;
    const created = await prisma.adCampaign.create({
      data: {
        title,
        body: req.body?.body || null,
        mediaUrl: req.body?.mediaUrl || null,
        mediaType: mediaType || null,
        targetUrl: req.body?.targetUrl || null,
        ctaLabel: req.body?.ctaLabel || null,
        placement: placement as any,
        isActive: parseBool(req.body?.isActive, true),
        startsAt: req.body?.startsAt ? new Date(req.body.startsAt) : null,
        endsAt: req.body?.endsAt ? new Date(req.body.endsAt) : null,
      },
    });
    res.json({ success: true, ad: created });
  } catch (error) {
    logger.error('Admin create ad error', { error });
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({ success: false, message: 'Failed to create ad' });
  }
});

/**
 * PATCH /api/admin/ads/:id
 */
router.patch('/ads/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id;
    if (!id) throw new AppError('id is required', 400);
    const data: any = {};
    if (req.body?.title !== undefined) data.title = String(req.body.title);
    if (req.body?.body !== undefined) data.body = req.body.body || null;
    if (req.body?.mediaUrl !== undefined) data.mediaUrl = req.body.mediaUrl || null;
    if (req.body?.mediaType !== undefined) data.mediaType = req.body.mediaType || null;
    if (req.body?.targetUrl !== undefined) data.targetUrl = req.body.targetUrl || null;
    if (req.body?.ctaLabel !== undefined) data.ctaLabel = req.body.ctaLabel || null;
    if (req.body?.placement !== undefined) data.placement = parsePlacement(req.body.placement);
    if (req.body?.isActive !== undefined) data.isActive = parseBool(req.body.isActive, true);
    if (req.body?.startsAt !== undefined) data.startsAt = req.body.startsAt ? new Date(req.body.startsAt) : null;
    if (req.body?.endsAt !== undefined) data.endsAt = req.body.endsAt ? new Date(req.body.endsAt) : null;

    const updated = await prisma.adCampaign.update({ where: { id }, data });
    res.json({ success: true, ad: updated });
  } catch (error) {
    logger.error('Admin update ad error', { error });
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({ success: false, message: 'Failed to update ad' });
  }
});

/**
 * DELETE /api/admin/ads/:id
 */
router.delete('/ads/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id;
    if (!id) throw new AppError('id is required', 400);
    await prisma.adCampaign.delete({ where: { id } });
    res.json({ success: true });
  } catch (error) {
    logger.error('Admin delete ad error', { error });
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({ success: false, message: 'Failed to delete ad' });
  }
});

  /**
   * POST /api/admin/uploads/presign
   * Generate presigned upload URL for admin assets (PCA, ads).
   */
  router.post('/uploads/presign', async (req: Request, res: Response): Promise<void> => {
    try {
      const { filename, mimeType, kind, scope } = req.body || {};
      if (!filename || !mimeType) {
        throw new AppError('filename and mimeType are required', 400);
      }

    const mime = String(mimeType).trim().toLowerCase();
    const isImage = mime.startsWith('image/');
    const isVideo = mime.startsWith('video/');
    if (!isImage && !isVideo) {
      throw new AppError('mimeType must be image/* or video/*', 400);
    }

      const assetKind = kind === 'video' || kind === 'image' ? kind : isVideo ? 'video' : 'image';
      const scopeRaw = typeof scope === 'string' ? scope.trim().toLowerCase() : '';
      const assetScope = scopeRaw === 'ads' ? 'ads' : 'pca';
      const safeFilename = String(filename).replace(/[^a-zA-Z0-9.-]/g, '_');
      const timestamp = Date.now();
      // Reuse user-uploads prefix so existing public bucket/CDN policy also serves admin media.
      const key = `user-uploads/admin/${assetScope}/${assetKind}/${timestamp}_${safeFilename}`;

    const putCommand = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      ContentType: mime,
    });
    const uploadUrl = await getSignedUrl(s3Client, putCommand, {
      expiresIn: 900,
    });

    res.json({
      success: true,
      uploadUrl,
      key,
      viewUrl: `${getBackendPublicBase(req)}/api/public/images/view/${key}`,
      publicUrl: getPublicUrl(key),
    });
    return;
  } catch (error) {
    logger.error('Admin upload presign error', { error });
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({ success: false, message: 'Failed to generate upload URL' });
    return;
  }
});

/**
 * GET /api/admin/overview
 */
router.get('/overview', async (_req: Request, res: Response): Promise<void> => {
  try {
    const [users, posts, comments, payments, totalRevenue, pcaCategories, pcaVotes] = await Promise.all([
      prisma.user.count(),
      prisma.post.count(),
      prisma.comment.count(),
      prisma.payment.count(),
      prisma.payment.aggregate({
        where: { status: 'COMPLETED' },
        _sum: { amount: true },
      }),
      safePcaCount('pcaCategory'),
      safePcaCount('pcaVote'),
    ]);

    res.json({
      success: true,
      overview: {
        users,
        posts,
        comments,
        payments,
        completedRevenueUsd: totalRevenue._sum.amount ?? 0,
        pcaCategories,
        pcaVotes,
      },
    });
    return;
  } catch (error) {
    logger.error('Admin overview error', { error });
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({ success: false, message: 'Failed to load admin overview' });
    return;
  }
});

/**
 * GET /api/admin/activity
 * Aggregated cross-user activity feed for admin monitoring.
 */
router.get('/activity', async (req: Request, res: Response): Promise<void> => {
  try {
    const rawLimit = Number(req.query.limit || 80);
    const limit = Math.min(ACTIVITY_LIMIT_MAX, Math.max(1, Math.floor(rawLimit || 80)));
    const before = parseDateQuery(req.query.before);
    const whereCreatedAt: Prisma.DateTimeFilter | undefined = before ? { lt: before } : undefined;
    const where = whereCreatedAt ? { createdAt: whereCreatedAt } : {};
    const perSourceLimit = Math.min(ACTIVITY_SOURCE_LIMIT_MAX, Math.max(20, limit));

    const [
      postsRes,
      commentsRes,
      votesRes,
      reactionsRes,
      paymentsRes,
      walletTransactionsRes,
      notificationsRes,
      directMessagesRes,
      followsRes,
    ] = await Promise.allSettled([
      prisma.post.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: perSourceLimit,
        select: {
          id: true,
          content: true,
          mediaType: true,
          status: true,
          isRoast: true,
          createdAt: true,
          user: { select: { id: true, displayName: true, username: true, email: true } },
        },
      }),
      prisma.comment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: perSourceLimit,
        select: {
          id: true,
          postId: true,
          parentId: true,
          content: true,
          createdAt: true,
          user: { select: { id: true, displayName: true, username: true, email: true } },
        },
      }),
      prisma.vote.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: perSourceLimit,
        select: {
          id: true,
          postId: true,
          voteType: true,
          createdAt: true,
          user: { select: { id: true, displayName: true, username: true, email: true } },
        },
      }),
      prisma.reaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: perSourceLimit,
        select: {
          id: true,
          postId: true,
          type: true,
          createdAt: true,
          user: { select: { id: true, displayName: true, username: true, email: true } },
        },
      }),
      prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: perSourceLimit,
        select: {
          id: true,
          paymentType: true,
          chain: true,
          amount: true,
          currency: true,
          status: true,
          txHash: true,
          createdAt: true,
          user: { select: { id: true, displayName: true, username: true, email: true } },
        },
      }),
      prisma.walletTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: perSourceLimit,
        select: {
          id: true,
          txHash: true,
          txType: true,
          tokenSymbol: true,
          amount: true,
          status: true,
          createdAt: true,
          wallet: {
            select: {
              user: { select: { id: true, displayName: true, username: true, email: true } },
            },
          },
        },
      }),
      prisma.notification.findMany({
        where: {
          ...(whereCreatedAt ? { createdAt: whereCreatedAt } : {}),
          type: { not: 'DAILY_ROL' },
        },
        orderBy: { createdAt: 'desc' },
        take: perSourceLimit,
        select: {
          id: true,
          type: true,
          title: true,
          body: true,
          readAt: true,
          createdAt: true,
          user: { select: { id: true, displayName: true, username: true, email: true } },
        },
      }),
      prisma.directMessage.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: perSourceLimit,
        select: {
          id: true,
          body: true,
          conversationId: true,
          createdAt: true,
          sender: { select: { id: true, displayName: true, username: true, email: true } },
        },
      }),
      prisma.follow.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: perSourceLimit,
        select: {
          id: true,
          createdAt: true,
          follower: { select: { id: true, displayName: true, username: true, email: true } },
          following: { select: { id: true, displayName: true, username: true, email: true } },
        },
      }),
    ]);

    const sourceFailures: string[] = [];
    const unwrapSource = <T>(source: string, result: PromiseSettledResult<T>, fallback: T): T => {
      if (result.status === 'fulfilled') return result.value;
      const reason =
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason || 'unknown error');
      logger.warn('Admin activity source failed', { source, reason });
      sourceFailures.push(source);
      return fallback;
    };

    const posts = unwrapSource('posts', postsRes, [] as any[]);
    const comments = unwrapSource('comments', commentsRes, [] as any[]);
    const votes = unwrapSource('votes', votesRes, [] as any[]);
    const reactions = unwrapSource('reactions', reactionsRes, [] as any[]);
    const payments = unwrapSource('payments', paymentsRes, [] as any[]);
    const walletTransactions = unwrapSource('walletTransactions', walletTransactionsRes, [] as any[]);
    const notifications = unwrapSource('notifications', notificationsRes, [] as any[]);
    const directMessages = unwrapSource('directMessages', directMessagesRes, [] as any[]);
    const follows = unwrapSource('follows', followsRes, [] as any[]);

    const activities: ActivityItem[] = [
      ...posts.map((post) => ({
        id: `post:${post.id}`,
        activityType: post.isRoast ? 'BANTER_POST_CREATED' : 'POST_CREATED',
        createdAt: post.createdAt,
        user: toActivityActor(post.user),
        title: post.isRoast ? 'Banter video posted' : 'Post created',
        description:
          truncateText(post.content) ||
          `${post.mediaType ? String(post.mediaType).toUpperCase() : 'TEXT'} post`,
        metadata: {
          postId: post.id,
          isRoast: post.isRoast,
          status: post.status,
          mediaType: post.mediaType || null,
        },
      })),
      ...comments.map((comment) => ({
        id: `comment:${comment.id}`,
        activityType: comment.parentId ? 'COMMENT_REPLY_CREATED' : 'COMMENT_CREATED',
        createdAt: comment.createdAt,
        user: toActivityActor(comment.user),
        title: comment.parentId ? 'Comment reply created' : 'Comment created',
        description: truncateText(comment.content) || `Comment on post ${shortId(comment.postId)}`,
        metadata: {
          commentId: comment.id,
          postId: comment.postId,
          parentId: comment.parentId,
        },
      })),
      ...votes.map((vote) => ({
        id: `vote:${vote.id}`,
        activityType: 'POST_VOTE_CAST',
        createdAt: vote.createdAt,
        user: toActivityActor(vote.user),
        title: 'Post vote cast',
        description: `${vote.voteType} vote on post ${shortId(vote.postId)}`,
        metadata: {
          voteId: vote.id,
          postId: vote.postId,
          voteType: vote.voteType,
        },
      })),
      ...reactions.map((reaction) => ({
        id: `reaction:${reaction.id}`,
        activityType: 'POST_REACTION_SET',
        createdAt: reaction.createdAt,
        user: toActivityActor(reaction.user),
        title: 'Post reaction updated',
        description: `${reaction.type} reaction on post ${shortId(reaction.postId)}`,
        metadata: {
          reactionId: reaction.id,
          postId: reaction.postId,
          reactionType: reaction.type,
        },
      })),
      ...payments.map((payment) => ({
        id: `payment:${payment.id}`,
        activityType: 'PAYMENT_EVENT',
        createdAt: payment.createdAt,
        user: toActivityActor(payment.user),
        title: `Payment ${String(payment.status).toLowerCase()}`,
        description: `${payment.amount} ${payment.currency} via ${payment.chain}`,
        metadata: {
          paymentId: payment.id,
          paymentType: payment.paymentType,
          chain: payment.chain,
          status: payment.status,
          txHash: payment.txHash,
        },
      })),
      ...walletTransactions.map((tx) => ({
        id: `wallet_tx:${tx.id}`,
        activityType: 'WALLET_TRANSACTION_SYNCED',
        createdAt: tx.createdAt,
        user: toActivityActor(tx.wallet?.user || null),
        title: 'Wallet transaction indexed',
        description: `${tx.txType} ${tx.amount} ${tx.tokenSymbol}`,
        metadata: {
          walletTransactionId: tx.id,
          txHash: tx.txHash,
          txType: tx.txType,
          status: tx.status,
          tokenSymbol: tx.tokenSymbol,
          amount: tx.amount,
        },
      })),
      ...notifications.map((notification) => ({
        id: `notification:${notification.id}`,
        activityType: 'NOTIFICATION_CREATED',
        createdAt: notification.createdAt,
        user: toActivityActor(notification.user),
        title: notification.title || 'Notification created',
        description: truncateText(notification.body) || `${notification.type} notification`,
        metadata: {
          notificationId: notification.id,
          notificationType: notification.type,
          readAt: notification.readAt,
        },
      })),
      ...directMessages.map((message) => ({
        id: `direct_message:${message.id}`,
        activityType: 'DIRECT_MESSAGE_SENT',
        createdAt: message.createdAt,
        user: toActivityActor(message.sender),
        title: 'Direct message sent',
        description: truncateText(message.body) || `Conversation ${shortId(message.conversationId)}`,
        metadata: {
          messageId: message.id,
          conversationId: message.conversationId,
        },
      })),
      ...follows.map((follow) => ({
        id: `follow:${follow.id}`,
        activityType: 'USER_FOLLOWED',
        createdAt: follow.createdAt,
        user: toActivityActor(follow.follower),
        title: 'User followed another user',
        description: `${follow.follower.displayName || follow.follower.username || follow.follower.email || shortId(follow.follower.id)} followed ${follow.following.displayName || follow.following.username || follow.following.email || shortId(follow.following.id)}`,
        metadata: {
          followId: follow.id,
          followerId: follow.follower.id,
          followingId: follow.following.id,
        },
      })),
    ];

    const sorted = activities
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
    const nextCursor = sorted.length >= limit ? sorted[sorted.length - 1]?.createdAt.toISOString() : null;

    res.json({
      success: true,
      activities: serializeBigInts(sorted),
      nextCursor,
      returned: sorted.length,
      warning:
        sourceFailures.length > 0
          ? `Partial activity data (${sourceFailures.join(', ')})`
          : undefined,
    });
    return;
  } catch (error) {
    logger.error('Admin activity feed error', { error });
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({ success: false, message: 'Failed to load admin activity feed' });
    return;
  }
});

/**
 * GET /api/admin/users
 */
router.get('/users', async (req: Request, res: Response): Promise<void> => {
  try {
    const { page, limit, skip } = getPagination(req);
    const search = String(req.query.search || '').trim();

    const where: Prisma.UserWhereInput = search
      ? {
          OR: [
            { email: { contains: search, mode: 'insensitive' } },
            { username: { contains: search, mode: 'insensitive' } },
            { displayName: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {};

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          email: true,
          displayName: true,
          username: true,
          solanaAddress: true,
          movementAddress: true,
          voteBalance: true,
          rolBalanceRaw: true,
          createdAt: true,
          updatedAt: true,
          wallets: {
            select: {
              id: true,
              blockchain: true,
              address: true,
            },
          },
          _count: {
            select: {
              posts: true,
              comments: true,
              payments: true,
              notifications: true,
            },
          },
        },
      }),
      prisma.user.count({ where }),
    ]);

    const safeUsers = users.map((user) => ({
      ...user,
      rolBalanceRaw: user.rolBalanceRaw.toString(),
    }));

    res.json({
      success: true,
      users: safeUsers,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    });
    return;
  } catch (error) {
    logger.error('Admin users list error', { error });
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({ success: false, message: 'Failed to load users' });
    return;
  }
});

/**
 * GET /api/admin/users/:id
 */
router.get('/users/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.params.id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        wallets: {
          include: {
            walletBalances: {
              orderBy: { updatedAt: 'desc' },
            },
          },
        },
        posts: {
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
        payments: {
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
        comments: {
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
        notifications: {
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
      },
    });

    if (!user) {
      throw new AppError('User not found', 404);
    }

    const safeUser = serializeBigInts(user);

    res.json({
      success: true,
      user: safeUser,
    });
    return;
  } catch (error) {
    logger.error('Admin user detail error', { error });
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({ success: false, message: 'Failed to load user detail' });
    return;
  }
});

/**
 * DELETE /api/admin/posts/:id
 * Admin delete for normal posts
 */
router.delete('/posts/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const postId = String(req.params.id || '').trim();
    if (!postId) {
      throw new AppError('Post id is required', 400);
    }

    const post = await prisma.post.findUnique({
      where: { id: postId },
      select: {
        id: true,
        isRoast: true,
        repostOfId: true,
        status: true,
      },
    });

    if (!post) {
      throw new AppError('Post not found', 404);
    }

    if (post.isRoast) {
      throw new AppError('This endpoint only deletes normal posts', 400);
    }

    const deleted = await hardDeletePost(postId);
    if (!deleted.deleted) {
      throw new AppError('Post not found', 404);
    }

    try {
      const { getIO } = await import('../websocket/socket');
      getIO().emit('post-hidden', { postId });
      if (post.repostOfId && typeof deleted.repostCount === 'number') {
        getIO().emit('repost-update', {
          postId: post.repostOfId,
          repostCount: deleted.repostCount,
        });
      }
    } catch (error) {
      logger.warn('WebSocket not available for admin post-hidden event', { error, postId });
    }

    res.json({ success: true });
    return;
  } catch (error) {
    logger.error('Admin delete post error', { error, postId: req.params.id });
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({ success: false, message: 'Failed to delete post' });
    return;
  }
});

/**
 * GET /api/admin/pca/categories
 */
router.get('/pca/categories', async (req: Request, res: Response): Promise<void> => {
  try {
    const sport = req.query.sport ? parseSport(String(req.query.sport)) : undefined;
    const season = String(req.query.season || '').trim() || undefined;
    const categories = await prisma.pcaCategory.findMany({
      where: {
        ...(sport ? { sport } : {}),
        ...(season ? { season } : {}),
      },
      include: {
        nominees: {
          orderBy: [{ voteCount: 'desc' }, { sortOrder: 'asc' }],
        },
        _count: {
          select: { votes: true },
        },
      },
      orderBy: [{ createdAt: 'desc' }],
    });

    res.json({ success: true, categories });
    return;
  } catch (error) {
    if (isTableMissingError(error)) {
      res.json({ success: true, categories: [], warning: 'PCA tables not migrated yet' });
      return;
    }
    logger.error('Admin PCA categories list error', { error });
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({ success: false, message: 'Failed to load PCA categories' });
    return;
  }
});

/**
 * POST /api/admin/pca/categories
 */
router.post('/pca/categories', async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      sport,
      season,
      categoryType,
      title,
      subtitle,
      roundLabel,
      description,
      criteria,
      isActive,
      startsAt,
      endsAt,
    } = req.body || {};

    if (!title || typeof title !== 'string') {
      throw new AppError('title is required', 400);
    }
    if (!season || typeof season !== 'string') {
      throw new AppError('season is required', 400);
    }

    const created = await prisma.pcaCategory.create({
      data: {
        sport: parseSport(sport),
        season: season.trim(),
        categoryType: parseCategoryType(categoryType),
        title: title.trim(),
        subtitle: subtitle || null,
        roundLabel: roundLabel || null,
        description: description || null,
        criteria: parseJsonBody(criteria),
        isActive: typeof isActive === 'boolean' ? isActive : true,
        startsAt: startsAt ? new Date(startsAt) : null,
        endsAt: endsAt ? new Date(endsAt) : null,
      },
    });

    res.json({ success: true, category: created });
    return;
  } catch (error) {
    logger.error('Admin PCA category create error', { error });
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({ success: false, message: 'Failed to create PCA category' });
    return;
  }
});

/**
 * PATCH /api/admin/pca/categories/:id
 */
router.patch('/pca/categories/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id;
    const body = req.body || {};
    const updated = await prisma.pcaCategory.update({
      where: { id },
      data: {
        ...(body.sport ? { sport: parseSport(body.sport) } : {}),
        ...(body.categoryType ? { categoryType: parseCategoryType(body.categoryType) } : {}),
        ...(typeof body.season === 'string' ? { season: body.season.trim() } : {}),
        ...(typeof body.title === 'string' ? { title: body.title.trim() } : {}),
        ...(body.subtitle !== undefined ? { subtitle: body.subtitle || null } : {}),
        ...(body.roundLabel !== undefined ? { roundLabel: body.roundLabel || null } : {}),
        ...(body.description !== undefined ? { description: body.description || null } : {}),
        ...(body.criteria !== undefined ? { criteria: parseJsonBody(body.criteria) } : {}),
        ...(typeof body.isActive === 'boolean' ? { isActive: body.isActive } : {}),
        ...(body.startsAt !== undefined ? { startsAt: body.startsAt ? new Date(body.startsAt) : null } : {}),
        ...(body.endsAt !== undefined ? { endsAt: body.endsAt ? new Date(body.endsAt) : null } : {}),
      },
    });

    res.json({ success: true, category: updated });
    return;
  } catch (error) {
    logger.error('Admin PCA category update error', { error });
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({ success: false, message: 'Failed to update PCA category' });
    return;
  }
});

/**
 * DELETE /api/admin/pca/categories/:id
 */
router.delete('/pca/categories/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id;
    await prisma.pcaCategory.delete({ where: { id } });
    res.json({ success: true });
    return;
  } catch (error) {
    logger.error('Admin PCA category delete error', { error });
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({ success: false, message: 'Failed to delete PCA category' });
    return;
  }
});

/**
 * POST /api/admin/pca/categories/:categoryId/nominees
 */
router.post('/pca/categories/:categoryId/nominees', async (req: Request, res: Response): Promise<void> => {
  try {
    const categoryId = req.params.categoryId;
    const {
      name,
      team,
      country,
      position,
      imageUrl,
      videoUrl,
      stats,
      sortOrder,
    } = req.body || {};

    if (!name || typeof name !== 'string') {
      throw new AppError('name is required', 400);
    }

    const category = await prisma.pcaCategory.findUnique({ where: { id: categoryId } });
    if (!category) {
      throw new AppError('PCA category not found', 404);
    }

    const nominee = await prisma.pcaNominee.create({
      data: {
        categoryId,
        name: name.trim(),
        team: team || null,
        country: country || null,
        position: position || null,
        imageUrl: imageUrl || null,
        videoUrl: videoUrl || null,
        stats: parseJsonBody(stats),
        sortOrder: Number.isInteger(Number(sortOrder)) ? Number(sortOrder) : 0,
      },
    });

    res.json({ success: true, nominee });
    return;
  } catch (error) {
    logger.error('Admin PCA nominee create error', { error });
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({ success: false, message: 'Failed to create PCA nominee' });
    return;
  }
});

/**
 * PATCH /api/admin/pca/nominees/:nomineeId
 */
router.patch('/pca/nominees/:nomineeId', async (req: Request, res: Response): Promise<void> => {
  try {
    const nomineeId = req.params.nomineeId;
    const body = req.body || {};
    const nominee = await prisma.pcaNominee.update({
      where: { id: nomineeId },
      data: {
        ...(typeof body.name === 'string' ? { name: body.name.trim() } : {}),
        ...(body.team !== undefined ? { team: body.team || null } : {}),
        ...(body.country !== undefined ? { country: body.country || null } : {}),
        ...(body.position !== undefined ? { position: body.position || null } : {}),
        ...(body.imageUrl !== undefined ? { imageUrl: body.imageUrl || null } : {}),
        ...(body.videoUrl !== undefined ? { videoUrl: body.videoUrl || null } : {}),
        ...(body.stats !== undefined ? { stats: parseJsonBody(body.stats) } : {}),
        ...(body.sortOrder !== undefined ? { sortOrder: Number(body.sortOrder) || 0 } : {}),
      },
    });

    res.json({ success: true, nominee });
    return;
  } catch (error) {
    logger.error('Admin PCA nominee update error', { error });
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({ success: false, message: 'Failed to update PCA nominee' });
    return;
  }
});

/**
 * DELETE /api/admin/pca/nominees/:nomineeId
 */
router.delete('/pca/nominees/:nomineeId', async (req: Request, res: Response): Promise<void> => {
  try {
    const nomineeId = req.params.nomineeId;
    await prisma.pcaNominee.delete({ where: { id: nomineeId } });
    res.json({ success: true });
    return;
  } catch (error) {
    logger.error('Admin PCA nominee delete error', { error });
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({ success: false, message: 'Failed to delete PCA nominee' });
    return;
  }
});

export default router;
