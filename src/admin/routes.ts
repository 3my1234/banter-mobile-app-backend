import { Router, Request, Response } from 'express';
import { PcaCategoryType, PcaSport, Prisma } from '@prisma/client';
import { prisma } from '../index';
import { AppError } from '../utils/errorHandler';
import { logger } from '../utils/logger';
import { adminAuthMiddleware, generateAdminToken } from './auth';

const router = Router();

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

const getPagination = (req: Request) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 25)));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
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
      prisma.pcaCategory.count(),
      prisma.pcaVote.count(),
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

    res.json({
      success: true,
      users,
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

    res.json({
      success: true,
      user,
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
