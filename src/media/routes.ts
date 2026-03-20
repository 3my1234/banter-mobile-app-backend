import { Router, Request, Response } from 'express';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { prisma } from '../index';
import { logger } from '../utils/logger';
import { AppError } from '../utils/errorHandler';

const router = Router();

const getMediaSecret = () => process.env.MEDIA_PIPELINE_SECRET || '';
const BUCKET_NAME = process.env.S3_BUCKET_NAME || process.env.AWS_S3_BUCKET_NAME || 'banter-uploads';

const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'eu-north-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },
});

const normalizeKey = (raw: string) => {
  let key = raw.trim();
  const publicViewPrefix = '/api/public/images/view/';
  const authedViewPrefix = '/api/images/view/';
  if (key.includes(publicViewPrefix) || key.includes(authedViewPrefix)) {
    const targetPrefix = key.includes(publicViewPrefix) ? publicViewPrefix : authedViewPrefix;
    const idx = key.indexOf(targetPrefix);
    key = key.slice(idx + targetPrefix.length);
  } else {
    key = key.replace(/^https?:\/\/[^/]+\/+/, '');
  }
  key = key.replace(/^\/+/, '');
  try {
    key = decodeURIComponent(key);
  } catch {
    // use as-is
  }
  key = key.replace(/^user-uploads[,\/]/, 'user-uploads/');
  key = key.replace(/,/g, '/');
  return key;
};

router.post('/download-url', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const { mediaUrl } = req.body || {};
    if (!mediaUrl || typeof mediaUrl !== 'string') {
      return res.status(400).json({ success: false, message: 'mediaUrl is required' });
    }

    const key = normalizeKey(mediaUrl);
    if (!key) {
      return res.status(400).json({ success: false, message: 'Invalid media URL' });
    }

    const downloadUrl = await getSignedUrl(
      s3Client,
      new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
      }),
      { expiresIn: 900 }
    );

    return res.json({ success: true, key, downloadUrl });
  } catch (error) {
    logger.error('Legacy media download URL error', { error });
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    return res.status(500).json({ success: false, message: 'Failed to create download URL' });
  }
});

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
