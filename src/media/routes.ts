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
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const { s3Key, hlsUrl } = req.body || {};
    if (!s3Key || !hlsUrl) {
      return res.status(400).json({ success: false, message: 's3Key and hlsUrl are required' });
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

    return res.json({ success: true, updated: updated.count });
  } catch (error) {
    logger.error('HLS complete error', { error });
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    return res.status(500).json({ success: false, message: 'Failed to process HLS completion' });
  }
});

export default router;
