import { Router, Request, Response } from 'express';
import { prisma } from '../index';
import { AppError } from '../utils/errorHandler';
import { logger } from '../utils/logger';

const router = Router();

const DEFAULT_SETTINGS = {
  postFrequency: 6,
  banterFrequency: 8,
  isEnabled: true,
};

const getAdSettings = async () => {
  const existing = await prisma.adSettings.findFirst();
  if (existing) return existing;
  return prisma.adSettings.create({ data: DEFAULT_SETTINGS });
};

router.get('/settings', async (_req: Request, res: Response): Promise<Response> => {
  try {
    const settings = await getAdSettings();
    return res.json({ success: true, settings });
  } catch (error) {
    logger.error('Public ad settings error', { error });
    return res.status(500).json({ success: false, message: 'Failed to load ad settings' });
  }
});

router.get('/', async (req: Request, res: Response): Promise<Response> => {
  try {
    const placement = String(req.query.placement || '').toUpperCase();
    const settings = await getAdSettings();
    if (!settings.isEnabled) {
      return res.json({ success: true, ads: [], settings });
    }

    const where: any = { isActive: true };
    if (placement === 'POST_FEED' || placement === 'BANTER_FEED') {
      where.placement = placement;
    }

    const now = new Date();
    where.AND = [
      {
        OR: [{ startsAt: null }, { startsAt: { lte: now } }],
      },
      {
        OR: [{ endsAt: null }, { endsAt: { gte: now } }],
      },
    ];

    const ads = await prisma.adCampaign.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return res.json({ success: true, ads, settings });
  } catch (error) {
    logger.error('Public ads fetch error', { error });
    return res.status(500).json({ success: false, message: 'Failed to load ads' });
  }
});

export default router;
