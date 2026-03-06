import { Router, Request, Response } from 'express';
import axios from 'axios';
import { prisma } from '../index';
import { AppError } from '../utils/errorHandler';
import { createNotification } from '../notification/service';
import {
  FIRST_ROLLEY_STAKE_POINTS_RAW,
  awardFirstRolleyStakePoints,
  getRolleyServiceBaseUrl,
} from './service';

const router = Router();

type RolleyStake = {
  id: string;
  created_at?: string | null;
};

router.post('/rolley/first-stake', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      throw new AppError('User not authenticated', 401);
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, banterPointsRaw: true },
    });
    if (!user) {
      throw new AppError('User not found', 404);
    }

    const response = await axios.get(`${getRolleyServiceBaseUrl()}/api/v1/stakes`, {
      params: { user_id: userId },
      timeout: 10000,
    });

    const stakes: RolleyStake[] = Array.isArray(response.data?.stakes) ? response.data.stakes : [];
    if (stakes.length === 0) {
      res.json({ success: true, awarded: false, reason: 'NO_STAKE' });
      return;
    }

    const firstStake = [...stakes].sort((left, right) => {
      const leftTime = new Date(left.created_at || 0).getTime();
      const rightTime = new Date(right.created_at || 0).getTime();
      return leftTime - rightTime;
    })[0];

    const rewardResult = await prisma.$transaction((tx) =>
      awardFirstRolleyStakePoints(tx, {
        userId,
        stakeId: firstStake.id,
        stakeCreatedAt: firstStake.created_at || null,
      })
    );

    if (rewardResult.awarded) {
      await createNotification({
        userId,
        type: 'SYSTEM',
        title: 'First Rolley stake bonus received',
        body: 'You received Banter Points for completing your first Rolley stake. See Profile > Banter Points for how points count toward the future airdrop.',
        data: {
          pointsRaw: FIRST_ROLLEY_STAKE_POINTS_RAW.toString(),
          rewardType: 'FIRST_ROLLEY_STAKE',
          stakeId: firstStake.id,
        },
        reference: rewardResult.reference,
      });
    }

    const refreshedUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { banterPointsRaw: true },
    });

    res.json({
      success: true,
      awarded: rewardResult.awarded,
      reason: rewardResult.reason || null,
      pointsRaw: FIRST_ROLLEY_STAKE_POINTS_RAW.toString(),
      banterPointsRaw: refreshedUser?.banterPointsRaw?.toString() || user.banterPointsRaw.toString(),
      stakeId: firstStake.id,
    });
  } catch (error: any) {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    if (axios.isAxiosError(error)) {
      res.status(502).json({ error: 'Failed to verify Rolley stake with rewards service' });
      return;
    }
    res.status(500).json({ error: 'Failed to award first Rolley stake points' });
  }
});

export default router;
