import { Queue } from 'bullmq';
import { logger } from '../utils/logger';
import { getRedisConfig } from './redisConfig';

const redisConfig = getRedisConfig();
const QUEUE_JOB_ATTEMPTS = Math.max(1, Number.parseInt(process.env.QUEUE_JOB_ATTEMPTS || '3', 10));
const QUEUE_JOB_BACKOFF_MS = Math.max(0, Number.parseInt(process.env.QUEUE_JOB_BACKOFF_MS || '5000', 10));
const QUEUE_JOB_REMOVE_ON_COMPLETE = Math.max(
  100,
  Number.parseInt(process.env.QUEUE_JOB_REMOVE_ON_COMPLETE || '1000', 10)
);
const QUEUE_JOB_REMOVE_ON_FAIL = Math.max(
  100,
  Number.parseInt(process.env.QUEUE_JOB_REMOVE_ON_FAIL || '5000', 10)
);

let postExpirationQueue: Queue | null = null;
let queueDisabledReason: string | null = null;

function queueIsDisabled() {
  return process.env.DISABLE_BACKGROUND_QUEUE === '1';
}

export function disablePostExpirationQueue(reason: string) {
  if (!queueDisabledReason) {
    queueDisabledReason = reason;
    logger.warn(`Background queue disabled: ${reason}`);
  }
  if (postExpirationQueue) {
    void postExpirationQueue.close().catch(() => undefined);
    postExpirationQueue = null;
  }
}

export function getPostExpirationQueue(): Queue | null {
  if (queueIsDisabled()) {
    return null;
  }

  if (queueDisabledReason) {
    return null;
  }

  if (!postExpirationQueue) {
    postExpirationQueue = new Queue('post-expiration', {
      connection: redisConfig,
      defaultJobOptions: {
        attempts: QUEUE_JOB_ATTEMPTS,
        backoff:
          QUEUE_JOB_BACKOFF_MS > 0
            ? {
                type: 'exponential',
                delay: QUEUE_JOB_BACKOFF_MS,
              }
            : undefined,
        removeOnComplete: { count: QUEUE_JOB_REMOVE_ON_COMPLETE },
        removeOnFail: { count: QUEUE_JOB_REMOVE_ON_FAIL },
      },
    });

    postExpirationQueue.on('error', (error) => {
      disablePostExpirationQueue(
        `post-expiration queue connection failed for host ${redisConfig.host}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
  }

  return postExpirationQueue;
}

/**
 * Add a job to check post expiration after 24 hours.
 * If Redis is unavailable, the API still succeeds and the job is skipped.
 */
export async function addPostExpirationJob(postId: string, expiresAt: Date): Promise<void> {
  try {
    const queue = getPostExpirationQueue();
    if (!queue) {
      logger.warn(`Skipping expiration job for post ${postId} because background queue is unavailable`);
      return;
    }

    const delay = expiresAt.getTime() - Date.now();

    if (delay <= 0) {
      logger.warn(`Post ${postId} expiration time is in the past, processing immediately`);
      await queue.add('check-expiration', { postId }, { delay: 0 });
      return;
    }

    await queue.add(
      'check-expiration',
      { postId },
      {
        delay,
        attempts: QUEUE_JOB_ATTEMPTS,
        backoff:
          QUEUE_JOB_BACKOFF_MS > 0
            ? {
                type: 'exponential',
                delay: QUEUE_JOB_BACKOFF_MS,
              }
            : undefined,
      }
    );

    logger.info(`Scheduled expiration check for post ${postId} at ${expiresAt.toISOString()}`);
  } catch (error) {
    disablePostExpirationQueue(
      `failed scheduling expiration job on host ${redisConfig.host}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
