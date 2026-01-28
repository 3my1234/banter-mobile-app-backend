import { Queue } from 'bullmq';
import { logger } from '../utils/logger';

const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD || undefined,
};

// Create queue for post expiration
export const postExpirationQueue = new Queue('post-expiration', {
  connection: redisConfig,
});

/**
 * Add a job to check post expiration after 24 hours
 */
export async function addPostExpirationJob(postId: string, expiresAt: Date): Promise<void> {
  try {
    const delay = expiresAt.getTime() - Date.now();
    
    if (delay <= 0) {
      logger.warn(`Post ${postId} expiration time is in the past, processing immediately`);
      await postExpirationQueue.add('check-expiration', { postId }, { delay: 0 });
      return;
    }

    await postExpirationQueue.add(
      'check-expiration',
      { postId },
      {
        delay, // Delay until expiration time
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
      }
    );

    logger.info(`Scheduled expiration check for post ${postId} at ${expiresAt.toISOString()}`);
  } catch (error) {
    logger.error(`Failed to schedule expiration job for post ${postId}`, { error });
    throw error;
  }
}
