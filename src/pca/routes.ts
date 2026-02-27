import { Router, Request, Response } from 'express';
import { PcaCategoryType, PcaSport, Prisma } from '@prisma/client';
import { prisma } from '../index';
import { AppError } from '../utils/errorHandler';
import { logger } from '../utils/logger';
import { createNotification } from '../notification/service';
import { getIO } from '../websocket/socket';

const router = Router();

const parseSport = (value?: string): PcaSport | undefined => {
  if (!value) return undefined;
  const normalized = value.trim().toUpperCase();
  if (normalized === 'SOCCER') return 'SOCCER';
  if (normalized === 'BASKETBALL') return 'BASKETBALL';
  return undefined;
};

const isCategoryOpen = (category: { isActive: boolean; startsAt: Date | null; endsAt: Date | null }) => {
  if (!category.isActive) return false;
  const now = Date.now();
  if (category.startsAt && category.startsAt.getTime() > now) return false;
  if (category.endsAt && category.endsAt.getTime() < now) return false;
  return true;
};

/**
 * GET /api/pca/categories
 */
router.get('/categories', async (req: Request, res: Response): Promise<void> => {
  try {
    const sport = parseSport(req.query.sport as string | undefined);
    const season = (req.query.season as string | undefined)?.trim();
    const activeOnly = (req.query.activeOnly as string | undefined) !== '0';
    const userId = req.user?.userId;

    const where: Prisma.PcaCategoryWhereInput = {
      ...(sport ? { sport } : {}),
      ...(season ? { season } : {}),
      ...(activeOnly ? { isActive: true } : {}),
    };

    const categories = await prisma.pcaCategory.findMany({
      where,
      include: {
        nominees: {
          orderBy: [{ voteCount: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
        },
      },
      orderBy: [{ createdAt: 'desc' }],
    });

    let spentByCategory: Record<string, number> = {};
    if (userId && categories.length > 0) {
      const categoryIds = categories.map((c) => c.id);
      const votes = await prisma.pcaVote.groupBy({
        by: ['categoryId'],
        where: {
          userId,
          categoryId: { in: categoryIds },
        },
        _sum: { votes: true },
      });
      spentByCategory = votes.reduce<Record<string, number>>((acc, row) => {
        acc[row.categoryId] = row._sum.votes ?? 0;
        return acc;
      }, {});
    }

    res.json({
      success: true,
      categories: categories.map((category) => ({
        ...category,
        isOpen: isCategoryOpen(category),
        userVotesSpent: spentByCategory[category.id] ?? 0,
      })),
    });
    return;
  } catch (error) {
    logger.error('PCA list categories error', { error });
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({ success: false, message: 'Failed to load PCA categories' });
    return;
  }
});

/**
 * POST /api/pca/vote
 * Body: { categoryId: string, nomineeId: string, votes?: number }
 */
router.post('/vote', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      throw new AppError('User not authenticated', 401);
    }

    const { categoryId, nomineeId } = req.body || {};
    const votes = Number(req.body?.votes ?? 1);

    if (!categoryId || typeof categoryId !== 'string') {
      throw new AppError('categoryId is required', 400);
    }
    if (!nomineeId || typeof nomineeId !== 'string') {
      throw new AppError('nomineeId is required', 400);
    }
    if (!Number.isInteger(votes) || votes <= 0 || votes > 1000) {
      throw new AppError('votes must be an integer between 1 and 1000', 400);
    }

    const result = await prisma.$transaction(async (tx) => {
      const category = await tx.pcaCategory.findUnique({ where: { id: categoryId } });
      if (!category) {
        throw new AppError('PCA category not found', 404);
      }
      if (!isCategoryOpen(category)) {
        throw new AppError('This PCA category is closed', 400);
      }

      const nominee = await tx.pcaNominee.findUnique({ where: { id: nomineeId } });
      if (!nominee || nominee.categoryId !== categoryId) {
        throw new AppError('Nominee not found for this category', 404);
      }

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, voteBalance: true },
      });
      if (!user) {
        throw new AppError('User not found', 404);
      }
      if (user.voteBalance < votes) {
        throw new AppError('Insufficient vote credits. Please buy more votes.', 402);
      }

      const updatedUser = await tx.user.update({
        where: { id: user.id },
        data: {
          voteBalance: { decrement: votes },
        },
        select: { voteBalance: true },
      });

      const updatedNominee = await tx.pcaNominee.update({
        where: { id: nominee.id },
        data: { voteCount: { increment: votes } },
        select: {
          id: true,
          voteCount: true,
          name: true,
        },
      });

      const voteRecord = await tx.pcaVote.create({
        data: {
          userId,
          categoryId,
          nomineeId,
          votes,
        },
      });

      return {
        category,
        nominee: updatedNominee,
        voteRecord,
        remainingVotes: updatedUser.voteBalance,
      };
    });

    await createNotification({
      userId,
      type: 'SYSTEM',
      title: 'PCA vote submitted',
      body: `You cast ${votes} vote${votes === 1 ? '' : 's'} for ${result.nominee.name}.`,
      data: {
        categoryId,
        nomineeId,
        votes,
      },
    });

    getIO().emit('pca.vote_update', {
      categoryId,
      nomineeId,
      nomineeVoteCount: result.nominee.voteCount,
      votesAdded: votes,
      at: new Date().toISOString(),
    });

    res.json({
      success: true,
      vote: result.voteRecord,
      remainingVoteBalance: result.remainingVotes,
      nominee: result.nominee,
    });
    return;
  } catch (error) {
    logger.error('PCA vote error', { error });
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({ success: false, message: 'Failed to submit PCA vote' });
    return;
  }
});

/**
 * GET /api/pca/criteria/templates
 * Helps admin/frontend present criteria structure by category type.
 */
router.get('/criteria/templates', (_req: Request, res: Response) => {
  const templates = {
    GOAL_OF_WEEK: ['goal_quality', 'difficulty', 'match_impact', 'technique'],
    PLAYER_OF_MONTH_STRIKER: ['goals', 'assists', 'shots_on_target', 'chance_conversion'],
    PLAYER_OF_MONTH_MIDFIELDER: ['assists', 'key_passes', 'progressive_passes', 'duels_won'],
    PLAYER_OF_MONTH_DEFENDER: ['tackles_won', 'interceptions', 'clearances', 'duels_won'],
    PLAYER_OF_MONTH_KEEPER: ['saves', 'save_percentage', 'clean_sheets', 'goals_prevented'],
    BALLON_DOR_PEOPLES_CHOICE: [
      'individual_performance',
      'team_impact',
      'fair_play',
      'consistency',
      'major_competition_performance',
    ],
  };

  res.json({
    success: true,
    enums: {
      sport: Object.values(PcaSport),
      categoryType: Object.values(PcaCategoryType),
    },
    templates,
  });
});

export default router;
