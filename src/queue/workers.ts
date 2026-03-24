import { lookup } from 'node:dns/promises';
import { Worker, WorkerOptions } from 'bullmq';
import { prisma } from '../index';
import { logger } from '../utils/logger';
import {
  disablePostExpirationQueue,
  getPostExpirationQueue,
} from './postQueue';
import { getRedisConfig } from './redisConfig';
import { getIO } from '../websocket/socket';
import { hardDeletePost } from '../post/service';

const redisConfig = getRedisConfig();

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
          await prisma.post.update({
            where: { id: postId },
            data: {
              status: 'ACTIVE',
              hiddenAt: null,
            },
          });

          logger.info(`Post ${postId} stays active: Stay votes (${post.stayVotes}) > Drop votes (${post.dropVotes})`);

          try {
            getIO().emit('post-stays', {
              postId,
              reason: 'stay_votes_exceeded',
              stayVotes: post.stayVotes,
              dropVotes: post.dropVotes,
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
