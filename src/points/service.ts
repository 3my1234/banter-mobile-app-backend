import { Prisma, PrismaClient, PointLedgerType } from '@prisma/client';

type TxClient = Prisma.TransactionClient | PrismaClient;

type AwardResult = {
  awarded: boolean;
  reference: string;
  pointsRaw: bigint;
  reason?: 'DISABLED' | 'NOT_ELIGIBLE' | 'ALREADY_AWARDED';
};

const parseBigIntEnv = (value: string | undefined, fallback: bigint) => {
  if (!value) return fallback;
  try {
    return BigInt(value);
  } catch {
    return fallback;
  }
};

export const DAILY_BANTER_POINTS_RAW = parseBigIntEnv(process.env.BANTER_POINTS_DAILY_LOGIN_RAW, BigInt(10));
export const EARLY_USER_POINTS_RAW = parseBigIntEnv(process.env.BANTER_POINTS_EARLY_USER_RAW, BigInt(500));
export const FIRST_ROLLEY_STAKE_POINTS_RAW = parseBigIntEnv(
  process.env.BANTER_POINTS_FIRST_ROLLEY_STAKE_RAW,
  BigInt(75)
);
export const PCA_VOTE_POINTS_RAW = parseBigIntEnv(process.env.BANTER_POINTS_PCA_VOTE_RAW, BigInt(5));

export const getLocalDayStart = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate());

export const getLocalDayKey = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const awardPointsOnce = async (
  tx: TxClient,
  input: {
    userId: string;
    type: PointLedgerType;
    pointsRaw: bigint;
    reference: string;
    metadata?: Prisma.InputJsonValue;
  }
): Promise<AwardResult> => {
  try {
    await tx.pointLedger.create({
      data: {
        userId: input.userId,
        type: input.type,
        pointsRaw: input.pointsRaw,
        reference: input.reference,
        metadata: input.metadata,
      },
    });
  } catch (error: any) {
    if (error?.code === 'P2002') {
      return {
        awarded: false,
        reference: input.reference,
        pointsRaw: input.pointsRaw,
        reason: 'ALREADY_AWARDED',
      };
    }
    throw error;
  }

  await tx.user.update({
    where: { id: input.userId },
    data: {
      banterPointsRaw: {
        increment: input.pointsRaw,
      },
    },
  });

  return {
    awarded: true,
    reference: input.reference,
    pointsRaw: input.pointsRaw,
  };
};

export const awardDailyLoginPoints = async (
  tx: TxClient,
  userId: string,
  now: Date
) => {
  const localDayStart = getLocalDayStart(now);
  const dayKey = getLocalDayKey(now);
  const reference = `daily_points:${userId}:${dayKey}`;

  const rewardUpdate = await tx.user.updateMany({
    where: {
      id: userId,
      OR: [{ lastDailyPointsAt: null }, { lastDailyPointsAt: { lt: localDayStart } }],
    },
    data: {
      lastDailyPointsAt: now,
      banterPointsRaw: {
        increment: DAILY_BANTER_POINTS_RAW,
      },
    },
  });

  if (rewardUpdate.count > 0) {
    try {
      await tx.pointLedger.create({
        data: {
          userId,
          type: 'LOGIN',
          pointsRaw: DAILY_BANTER_POINTS_RAW,
          reference,
          metadata: {
            source: 'auth',
            dayKey,
          },
        },
      });
    } catch (error: any) {
      if (error?.code !== 'P2002') {
        throw error;
      }
    }
  }

  return {
    awarded: rewardUpdate.count > 0,
    localDayStart,
    dayKey,
    reference,
    pointsRaw: DAILY_BANTER_POINTS_RAW,
  };
};

const getEarlyUserCutoff = () => {
  const raw = (process.env.BANTER_POINTS_EARLY_USER_CUTOFF_AT || '').trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
};

export const awardEarlyUserPoints = async (
  tx: TxClient,
  user: { id: string; createdAt: Date }
): Promise<AwardResult> => {
  const cutoff = getEarlyUserCutoff();
  const reference = `early_user:${user.id}`;
  if (!cutoff) {
    return { awarded: false, reference, pointsRaw: EARLY_USER_POINTS_RAW, reason: 'DISABLED' };
  }
  if (user.createdAt.getTime() > cutoff.getTime()) {
    return { awarded: false, reference, pointsRaw: EARLY_USER_POINTS_RAW, reason: 'NOT_ELIGIBLE' };
  }

  return awardPointsOnce(tx, {
    userId: user.id,
    type: 'EARLY_USER',
    pointsRaw: EARLY_USER_POINTS_RAW,
    reference,
    metadata: {
      cutoffAt: cutoff.toISOString(),
      userCreatedAt: user.createdAt.toISOString(),
    },
  });
};

export const awardFirstRolleyStakePoints = async (
  tx: TxClient,
  input: { userId: string; stakeId: string; stakeCreatedAt?: string | null }
): Promise<AwardResult> =>
  awardPointsOnce(tx, {
    userId: input.userId,
    type: 'FIRST_ROLLEY_STAKE',
    pointsRaw: FIRST_ROLLEY_STAKE_POINTS_RAW,
    reference: `first_rolley_stake:${input.userId}`,
    metadata: {
      rewardType: 'FIRST_ROLLEY_STAKE',
      stakeId: input.stakeId,
      stakeCreatedAt: input.stakeCreatedAt || null,
    },
  });

export const awardPcaVotePoints = async (
  tx: TxClient,
  input: {
    userId: string;
    voteRecordId: string;
    categoryId: string;
    nomineeId: string;
    votes: number;
    now: Date;
  }
): Promise<AwardResult> => {
  const dayKey = getLocalDayKey(input.now);
  return awardPointsOnce(tx, {
    userId: input.userId,
    type: 'PCA',
    pointsRaw: PCA_VOTE_POINTS_RAW,
    reference: `pca_vote:${input.userId}:${dayKey}`,
    metadata: {
      rewardType: 'PCA_VOTE',
      voteRecordId: input.voteRecordId,
      categoryId: input.categoryId,
      nomineeId: input.nomineeId,
      votes: input.votes,
      dayKey,
    },
  });
};

export const getRolleyServiceBaseUrl = () =>
  (process.env.ROLLEY_SERVICE_URL || 'https://sportbanter.online/rolley').replace(/\/+$/, '');
