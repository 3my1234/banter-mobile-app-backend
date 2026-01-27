import { Worker, WorkerOptions } from 'bullmq';
import { prisma } from '../index';
import { logger } from '../utils/logger';
import { postExpirationQueue } from './postQueue';
import { getIO } from '../websocket/socket';

const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD || undefined,
};

/**
 * Worker to process post expiration
 * Checks if Drop votes >= Stay votes at 24h mark
 */
const postExpirationWorker = new Worker(
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

      if (post.status !== 'ACTIVE') {
        logger.info(`Post ${postId} is already ${post.status}, skipping`);
        return;
      }

      // Check if post has expired
      const now = new Date();
      if (post.expiresAt > now) {
        logger.warn(`Post ${postId} has not expired yet, rescheduling...`);
        // Reschedule for the actual expiration time
        const delay = post.expiresAt.getTime() - now.getTime();
        await postExpirationQueue.add(
          'check-expiration',
          { postId },
          { delay }
        );
        return;
      }

      // Check if Drop votes >= Stay votes
      if (post.dropVotes >= post.stayVotes) {
        // Hide the post
        await prisma.post.update({
          where: { id: postId },
          data: {
            status: 'HIDDEN',
            hiddenAt: new Date(),
          },
        });

        logger.info(`Post ${postId} hidden: Drop votes (${post.dropVotes}) >= Stay votes (${post.stayVotes})`);

        // Emit WebSocket event
        try {
          getIO().emit('post-hidden', {
            postId,
            reason: 'drop_votes_exceeded',
            stayVotes: post.stayVotes,
            dropVotes: post.dropVotes,
          });
        } catch (error) {
          logger.warn('WebSocket not available for post-hidden event', { error });
        }
      } else {
        // Post stays active (Stay votes > Drop votes)
        await prisma.post.update({
          where: { id: postId },
          data: {
            status: 'ACTIVE', // Keep active
          },
        });

        logger.info(`Post ${postId} stays active: Stay votes (${post.stayVotes}) > Drop votes (${post.dropVotes})`);

        // Emit WebSocket event
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

postExpirationWorker.on('completed', (job) => {
  logger.info(`Post expiration job ${job.id} completed`);
});

postExpirationWorker.on('failed', (job, err) => {
  logger.error(`Post expiration job ${job?.id} failed`, { error: err });
});

/**
 * Setup all queue workers
 */
export function setupQueueWorkers(): void {
  logger.info('✅ Queue workers initialized');
}
