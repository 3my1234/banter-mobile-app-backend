import { Router, Request, Response } from 'express';
import { prisma } from '../index';
import { logger } from '../utils/logger';
import { AppError } from '../utils/errorHandler';

const router = Router();

/**
 * GET /api/tags/search?q=arsenal
 * Search for tags (clubs/hashtags)
 */
router.get('/search', async (req: Request, res: Response) => {
  try {
    const query = (req.query.q as string) || '';
    const limit = parseInt(req.query.limit as string) || 20;

    if (!query || query.trim().length === 0) {
      return res.json({
        success: true,
        tags: [],
      });
    }

    const searchTerm = query.trim().toLowerCase();

    const tags = await prisma.tag.findMany({
      where: {
        OR: [
          { name: { contains: searchTerm, mode: 'insensitive' } },
          { displayName: { contains: searchTerm, mode: 'insensitive' } },
        ],
      },
      orderBy: [
        { type: 'asc' }, // CLUB before HASHTAG
        { displayName: 'asc' },
      ],
      take: limit,
    });

    res.json({
      success: true,
      tags: tags.map((tag) => ({
        id: tag.id,
        name: tag.name,
        displayName: tag.displayName,
        type: tag.type,
        league: tag.league,
        iconUrl: tag.iconUrl,
      })),
    });
  } catch (error) {
    logger.error('Search tags error', { error });
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Failed to search tags', 500);
  }
});

export default router;
