import { Router, Request, Response } from 'express';
import { prisma } from '../index';
import { logger } from '../utils/logger';
import { AppError } from '../utils/errorHandler';

const router = Router();

/**
 * GET /api/leagues
 * Get all leagues and their clubs
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const leagues = await prisma.league.findMany({
      include: {
        _count: {
          select: {
            // Count tags (clubs) in this league
            // Note: This requires a relation from League to Tag, which we'll add if needed
          },
        },
      },
      orderBy: {
        name: 'asc',
      },
    });

    // Get clubs (tags) for each league
    const leaguesWithClubs = await Promise.all(
      leagues.map(async (league) => {
        const clubs = await prisma.tag.findMany({
          where: {
            league: league.name,
            type: 'CLUB',
          },
          orderBy: {
            displayName: 'asc',
          },
        });

        return {
          id: league.id,
          name: league.name,
          displayName: league.displayName,
          country: league.country,
          logoUrl: league.logoUrl,
          clubs: clubs.map((club) => ({
            id: club.id,
            name: club.name,
            displayName: club.displayName,
            iconUrl: club.iconUrl,
          })),
        };
      })
    );

    res.json({
      success: true,
      leagues: leaguesWithClubs,
    });
  } catch (error) {
    logger.error('Get leagues error', { error });
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Failed to get leagues', 500);
  }
});

export default router;
