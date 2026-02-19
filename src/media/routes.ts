import { Router, Request, Response } from 'express';
import { prisma } from '../index';
import { logger } from '../utils/logger';
import { AppError } from '../utils/errorHandler';

const router = Router();

const getMediaSecret = () => process.env.MEDIA_PIPELINE_SECRET || '';

const normalizeKey = (raw: string) => {
  let key = raw.trim();
  key = key.replace(/^https?:\/\/[^/]+\/+/, '');
  key = key.replace(/^\/+/, '');
  return key;
};

/**
 * POST /api/media/hls-complete
 * Webhook for MediaConvert job completion.
 * Body: { s3Key: string, hlsUrl: string, posterUrl?: string }
 * Header: x-media-secret
 */
router.post('/hls-complete', async (req: Request, res: Response) => {
  try {
    const secret = getMediaSecret();
    const provided = req.headers['x-media-secret'];
    if (!secret || provided !== secret) {
      throw new AppError('Unauthorized', 401);
    }

    const { s3Key, hlsUrl } = req.body || {};
    if (!s3Key || !hlsUrl) {
      throw new AppError('s3Key and hlsUrl are required', 400);
    }

    const key = normalizeKey(s3Key);

    const updated = await prisma.post.updateMany({
      where: {
        mediaUrl: {
          contains: key,
        },
      },
      data: {
        mediaUrl: hlsUrl,
        mediaType: 'video',
      },
    });

    if (!updated.count) {
      logger.warn('HLS complete: no posts matched key', { key, hlsUrl });
    }

    res.json({ success: true, updated: updated.count });
  } catch (error) {
    logger.error('HLS complete error', { error });
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Failed to process HLS completion', 500);
  }
});

export default router;
