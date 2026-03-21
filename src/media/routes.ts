import { Router, Request, Response } from 'express';
import { HeadObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { jwtAuthMiddleware } from '../auth/jwtMiddleware';
import { prisma } from '../index';
import { logger } from '../utils/logger';
import { AppError } from '../utils/errorHandler';

const router = Router();

const getMediaSecret = () => process.env.MEDIA_PIPELINE_SECRET || '';
const BUCKET_NAME = process.env.S3_BUCKET_NAME || process.env.AWS_S3_BUCKET_NAME || 'banter-uploads';
const VIDEO_SOURCE_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.webm'];

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

const getBackendPublicBase = (req?: Request) => {
  const candidates = [
    process.env.BACKEND_PUBLIC_URL,
    process.env.API_URL,
    req ? `${req.protocol}://${req.get('host') || ''}` : '',
  ];
  const picked = candidates.find((value) => typeof value === 'string' && /^https?:\/\//i.test(value));
  if (!picked) return 'https://sportbanter.online';
  return picked.trim().replace(/\/+$/, '').replace(/\/api$/, '');
};

const encodeKeyForView = (key: string) =>
  key
    .replace(/^\/+/, '')
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');

const toPublicViewUrl = (req: Request, key: string) =>
  `${getBackendPublicBase(req)}/api/public/images/view/${encodeKeyForView(key)}`;

const objectExists = async (key: string) => {
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
    return true;
  } catch (error: any) {
    if (error?.name === 'NotFound' || error?.$metadata?.httpStatusCode === 404) {
      return false;
    }
    throw error;
  }
};

const findOriginalSourceKeyFromHlsKey = async (hlsKey: string) => {
  if (!/\.m3u8$/i.test(hlsKey) || !hlsKey.startsWith('hls/')) {
    return null;
  }

  const baseName = hlsKey
    .replace(/^hls\//, '')
    .replace(/\/[^/]+\.m3u8$/i, '');

  if (!baseName) return null;

  const originalPrefix = `user-uploads/${baseName}`;

  for (const extension of VIDEO_SOURCE_EXTENSIONS) {
    const candidate = `${originalPrefix}${extension}`;
    if (await objectExists(candidate)) {
      return candidate;
    }
  }

  const listed = await s3Client.send(
    new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: originalPrefix,
      MaxKeys: 20,
    })
  );

  const match = (listed.Contents || [])
    .map((item) => item.Key || '')
    .find((key) => VIDEO_SOURCE_EXTENSIONS.some((extension) => key.toLowerCase().endsWith(extension)));

  return match || null;
};

router.post('/download-url', jwtAuthMiddleware, async (req: Request, res: Response) => {
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

    let resolvedKey = key;
    let strategy = 'direct-object';

    if (/\.m3u8$/i.test(key)) {
      const mp4Key = key.replace(/\/[^/]+\.m3u8$/i, '/download.mp4');
      const originalKey = await findOriginalSourceKeyFromHlsKey(key);

      if (originalKey) {
        resolvedKey = originalKey;
        strategy = 'original-source';
      } else if (await objectExists(mp4Key)) {
        resolvedKey = mp4Key;
        strategy = 'processed-mp4-fallback';
      } else {
        return res.status(404).json({
          success: false,
          message: 'No downloadable video found for this media',
          details: { hlsKey: key, attemptedMp4Key: mp4Key },
        });
      }
    } else if (!(await objectExists(resolvedKey))) {
      return res.status(404).json({
        success: false,
        message: 'Media file not found',
        details: { key: resolvedKey },
      });
    }

    const downloadUrl = toPublicViewUrl(req, resolvedKey);

    return res.json({ success: true, key: resolvedKey, downloadUrl, strategy });
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
