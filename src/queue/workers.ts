import { lookup } from 'node:dns/promises';
import { Worker, WorkerOptions } from 'bullmq';
import { prisma } from '../index';
import { logger } from '../utils/logger';
import {
  disablePostExpirationQueue,
  getPostExpirationQueue,
} from './postQueue';
import { addPostExpirationJob } from './postQueue';
import { getRedisConfig } from './redisConfig';
import { getIO } from '../websocket/socket';
import { createNotification } from '../notification/service';
import { hardDeletePost } from '../post/service';

const redisConfig = getRedisConfig();
const ROAST_SURVIVAL_REWARD_RAW = (() => {
  try {
    return BigInt(process.env.BANTER_ROAST_SURVIVAL_ROL_RAW || '100000');
  } catch {
    return BigInt(100000);
  }
})();
const ROAST_SURVIVAL_CYCLE_HOURS = 24;
const ROAST_REWARD_EVERY_CYCLES = 7;

let postExpirationWorker: Worker | null = null;

async function canReachRedisHost() {
  try {
    await lookup(redisConfig.host);
    return true;
  } catch (error) {
    disablePostExpirationQueue(
      `Redis host ${redisConfig.host} cannot be resolved: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return false;
  }
}

function registerWorkerEvents(worker: Worker) {
  worker.on('completed', (job) => {
    logger.info(`Post expiration job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`Post expiration job ${job?.id} failed`, { error: err });
  });

  worker.on('error', (error) => {
    disablePostExpirationQueue(
      `post-expiration worker connection failed for host ${redisConfig.host}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    if (postExpirationWorker) {
      void postExpirationWorker.close().catch(() => undefined);
      postExpirationWorker = null;
    }
  });
}

/**
 * Setup all queue workers.
 * Redis is optional for the API; if it is unavailable we log once and continue.
 */
export async function setupQueueWorkers(): Promise<void> {
  if (process.env.DISABLE_BACKGROUND_QUEUE === '1') {
    logger.warn('Background queue disabled via DISABLE_BACKGROUND_QUEUE=1');
    return;
  }

  if (postExpirationWorker) {
    return;
  }

  const queue = getPostExpirationQueue();
  if (!queue) {
    logger.warn('Background queue unavailable during worker setup');
    return;
  }

  const reachable = await canReachRedisHost();
  if (!reachable) {
    return;
  }

  postExpirationWorker = new Worker(
    'post-expiration',
    async (job) => {
      const { postId } = job.data;

      try {
        logger.info(`Processing expiration check for post ${postId}`);

        const post = await prisma.post.findUnique({
          where: { id: postId },
        });

        if (!post) {
          logger.warn(`Post ${postId} not found, skipping expiration check`);
          return;
        }

        if (!post.isRoast) {
          logger.info(`Post ${postId} is not a roast, skipping expiration`);
          return;
        }

        if (post.status !== 'ACTIVE') {
          logger.info(`Post ${postId} is already ${post.status}, skipping`);
          return;
        }

        const now = new Date();
        if (post.expiresAt > now) {
          logger.warn(`Post ${postId} has not expired yet, rescheduling...`);
          const delay = post.expiresAt.getTime() - now.getTime();
          const activeQueue = getPostExpirationQueue();
          if (!activeQueue) {
            logger.warn(`Skipping reschedule for post ${postId} because background queue is unavailable`);
            return;
          }
          await activeQueue.add('check-expiration', { postId }, { delay });
          return;
        }

        if (post.dropVotes >= post.stayVotes) {
          const deleted = await hardDeletePost(postId);

          logger.info(`Post ${postId} deleted: Drop votes (${post.dropVotes}) >= Stay votes (${post.stayVotes})`);

          try {
            getIO().emit('post-hidden', {
              postId,
              reason: 'drop_votes_deleted',
              stayVotes: post.stayVotes,
              dropVotes: post.dropVotes,
            });
            if (deleted.repostOfId && typeof deleted.repostCount === 'number') {
              getIO().emit('repost-update', {
                postId: deleted.repostOfId,
                repostCount: deleted.repostCount,
              });
            }
          } catch (error) {
            logger.warn('WebSocket not available for post-hidden event', { error });
          }
        } else {
          const nextSurvivalCycles = post.survivalCycles + 1;
          const nextRewardCyclesPaid = Math.floor(nextSurvivalCycles / ROAST_REWARD_EVERY_CYCLES);
          const rewardMilestonesEarned = Math.max(nextRewardCyclesPaid - post.rewardCyclesPaid, 0);
          const nextExpiresAt = new Date(post.expiresAt.getTime() + ROAST_SURVIVAL_CYCLE_HOURS * 60 * 60 * 1000);

          const updateResult = await prisma.post.updateMany({
            where: {
              id: postId,
              expiresAt: post.expiresAt,
              survivalCycles: post.survivalCycles,
              rewardCyclesPaid: post.rewardCyclesPaid,
            },
            data: {
              status: 'ACTIVE',
              hiddenAt: null,
              expiresAt: nextExpiresAt,
              survivalCycles: { increment: 1 },
              rewardCyclesPaid: nextRewardCyclesPaid,
            },
          });

          if (updateResult.count === 0) {
            logger.warn(`Post ${postId} survival update was skipped because the post changed concurrently`);
            return;
          }

          if (rewardMilestonesEarned > 0) {
            const rewardRaw = ROAST_SURVIVAL_REWARD_RAW * BigInt(rewardMilestonesEarned);
            await prisma.user.update({
              where: { id: post.userId },
              data: {
                rolBalanceRaw: { increment: rewardRaw },
              },
            });

            const rewardDisplay = Number(rewardRaw) / 10 ** 8;
            await createNotification({
              userId: post.userId,
              type: 'SYSTEM',
              title: 'Banter survival reward',
              body: `Your banter post survived ${nextRewardCyclesPaid * ROAST_REWARD_EVERY_CYCLES} days and earned ${rewardDisplay.toFixed(3)} ROL.`,
              data: {
                postId,
                rewardRaw: rewardRaw.toString(),
                rewardCyclesPaid: nextRewardCyclesPaid,
                survivalCycles: nextSurvivalCycles,
              },
              reference: `banter_survival_reward:${postId}:${nextRewardCyclesPaid}`,
            });
          }

          await addPostExpirationJob(postId, nextExpiresAt);

          logger.info(`Post ${postId} stays active: Stay votes (${post.stayVotes}) > Drop votes (${post.dropVotes})`);

          try {
            getIO().emit('post-stays', {
              postId,
              reason: 'stay_votes_exceeded',
              stayVotes: post.stayVotes,
              dropVotes: post.dropVotes,
              survivalCycles: nextSurvivalCycles,
              rewardCyclesPaid: nextRewardCyclesPaid,
              nextExpiresAt: nextExpiresAt.toISOString(),
            });
          } catch (error) {
            logger.warn('WebSocket not available for post-stays event', { error });
          }
        }
      } catch (error) {
        logger.error(`Failed to process expiration for post ${postId}`, { error });
        throw error;
      }
    },
    {
      connection: redisConfig,
      concurrency: 5,
    } as WorkerOptions
  );

  registerWorkerEvents(postExpirationWorker);
  logger.info('Queue workers initialized');
}
