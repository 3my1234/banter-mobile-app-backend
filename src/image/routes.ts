import { Router, Request, Response } from 'express';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { logger } from '../utils/logger';
import { AppError } from '../utils/errorHandler';
import { prisma } from '../index';

const router = Router();

// Initialize S3 client
const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'eu-north-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },
  // Disable auto checksum headers on presigned PUTs so browsers don't need to send x-amz-checksum-*
  requestChecksumCalculation: 'NEVER' as any,
} as any);

// Accept both S3_BUCKET_NAME and AWS_S3_BUCKET_NAME for compatibility
const BUCKET_NAME = process.env.S3_BUCKET_NAME || process.env.AWS_S3_BUCKET_NAME || 'banter-uploads';
const CLOUDFRONT_DOMAIN = process.env.CLOUDFRONT_DOMAIN || process.env.ASSETS_CDN_BASE;
const API_URL = process.env.API_URL || process.env.DOMAIN || 'https://sportbanter.online';
const DEFAULT_GET_TTL = 86400; // 24 hours for view URLs

/**
 * Helper: Get CloudFront or public S3 URL for a key
 */
function getPublicUrl(key: string): string {
  if (CLOUDFRONT_DOMAIN) {
    // Remove leading slash if present
    const normalizedKey = key.startsWith('/') ? key.substring(1) : key;
    return `https://${CLOUDFRONT_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '')}/${normalizedKey}`;
  }
  // Fallback to S3 public URL
  const region = process.env.AWS_REGION || 'eu-north-1';
  return `https://${BUCKET_NAME}.s3.${region}.amazonaws.com/${key}`;
}

/**
 * Helper: Generate presigned GET URL for a key
 */
async function getPresignedGetUrl(key: string, ttlSeconds: number = DEFAULT_GET_TTL): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
  });
  return await getSignedUrl(s3Client, command, { expiresIn: ttlSeconds });
}

/**
 * Helper: Check if file exists in S3
 */
async function fileExists(key: string): Promise<boolean> {
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
    return true;
  } catch (error: any) {
    if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
      return false;
    }
    throw error;
  }
}

/**
 * POST /api/images/presign
 * Generate presigned URL for direct S3 upload (images and videos)
 * Returns backend redirect URL for stable reads (avoids expiring presigned URLs)
 */
router.post('/presign', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      throw new AppError('User not authenticated', 401);
    }

    const { filename, mimeType, type } = req.body;

    if (!filename || !mimeType) {
      throw new AppError('Filename and mimeType are required', 400);
    }

    // Validate mimeType (support images and videos)
    const isImage = mimeType.startsWith('image/');
    const isVideo = mimeType.startsWith('video/');
    if (!isImage && !isVideo) {
      throw new AppError('mimeType must be image/* or video/*', 400);
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new AppError('User not found', 404);
    }

    // Validate type
    const validTypes = ['profile', 'banner', 'post'];
    if (type && !validTypes.includes(type)) {
      throw new AppError(`Type must be one of: ${validTypes.join(', ')}`, 400);
    }

    // Generate S3 key (same structure as legacy)
    const timestamp = Date.now();
    const sanitizedFilename = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
    const key = type
      ? `user-uploads/${user.id}/${type}/${timestamp}_${sanitizedFilename}`
      : `user-uploads/${user.id}/${timestamp}_${sanitizedFilename}`;

    // Generate presigned PUT URL for upload (15 minutes)
    const putCommand = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      ContentType: mimeType,
    });

    const uploadUrl = await getSignedUrl(s3Client, putCommand, {
      expiresIn: 900, // 15 minutes for upload
    });

    // Return stable public URL for reads (CloudFront preferred, otherwise public S3)
    // This avoids redirect latency and works well with mobile image components.
    const viewUrl = getPublicUrl(key);

    logger.info(`Generated presigned URL for user ${user.id}: ${key} (${mimeType})`);

    res.json({
      success: true,
      uploadUrl,
      key,
      viewUrl, // Backend redirect URL (stable, never expires)
    });
  } catch (error) {
    logger.error('Presign upload error', { error });
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Failed to generate upload URL', 500);
  }
});

/**
 * GET /api/images/view/**
 * Fast image/video serving endpoint - redirects to CloudFront or generates presigned URL
 * This endpoint provides stable URLs that never expire (unlike direct S3 presigned URLs)
 * Supports keys with slashes via wildcard route
 */
router.get('/view/*', async (req: Request, res: Response) => {
  try {
    // Extract key from wildcard param (preferred)
    let key = (req.params && (req.params as any)[0]) || '';
    if (!key && typeof req.url === 'string') {
      // Fallback if param is missing
      const fallback = req.url.replace(/^\/view\//, '').replace(/^\/api\/images\/view\//, '');
      key = fallback;
    }

    // Decode URL encoding
    try {
      key = decodeURIComponent(key);
    } catch {
      // If decode fails, use as-is
    }

    // Normalize key (handle legacy comma-separated keys)
    const normalizedKey = String(key)
      .replace(/^\/+/, '')
      .replace(/^user-uploads[,\/]/, 'user-uploads/')
      .replace(/,/g, '/');

    logger.debug(`Image view request: ${key} -> normalized: ${normalizedKey}`);

    // Check if file exists (non-blocking, for logging)
    try {
      const exists = await fileExists(normalizedKey);
      if (exists) {
        logger.debug(`✅ File exists in S3: ${normalizedKey}`);
      } else {
        logger.warn(`⚠️ File not found in S3: ${normalizedKey} - but will still try to serve (may be propagating)`);
      }
    } catch (fileCheckError: any) {
      logger.warn(`Could not verify file existence: ${fileCheckError?.message || fileCheckError} - continuing anyway`);
    }

    // Use CloudFront if available (fastest), otherwise generate presigned URL
    if (CLOUDFRONT_DOMAIN) {
      const cloudfrontUrl = getPublicUrl(normalizedKey);
      logger.debug(`✅ Using CloudFront URL: ${cloudfrontUrl}`);
      // Redirect to CloudFront with cache headers
      return res
        .set({
          'Cache-Control': 'public, max-age=86400', // 24 hours cache
          'Access-Control-Allow-Origin': '*', // CORS for images/videos
        })
        .redirect(302, cloudfrontUrl);
    } else {
      // Fallback: Generate presigned URL (24 hour expiration)
      const presignedUrl = await getPresignedGetUrl(normalizedKey, DEFAULT_GET_TTL);
      logger.debug(`✅ Using presigned S3 URL (expires in ${DEFAULT_GET_TTL}s)`);
      return res
        .set({
          'Cache-Control': 'public, max-age=3600', // 1 hour cache for presigned URLs
          'Access-Control-Allow-Origin': '*',
        })
        .redirect(302, presignedUrl);
    }
  } catch (error: any) {
    logger.error('Image view error', {
      key: req.url,
      error: error?.message || error,
      stack: error?.stack,
    });
    return res.status(404).json({
      success: false,
      message: 'Image/video not found',
      error: error?.message || 'Unknown error',
    });
  }
});

/**
 * POST /api/images/save-profile-picture
 * Save profile picture URL to user profile
 */
router.post('/save-profile-picture', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      throw new AppError('User not authenticated', 401);
    }

    const { imageUrl } = req.body;

    if (!imageUrl) {
      throw new AppError('Image URL is required', 400);
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new AppError('User not found', 404);
    }

    // Update user's avatar URL
    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        avatarUrl: imageUrl,
      },
    });

    logger.info(`Updated profile picture for user ${user.id}`);

    res.json({
      success: true,
      message: 'Profile picture saved successfully',
      avatarUrl: updatedUser.avatarUrl,
    });
  } catch (error) {
    logger.error('Save profile picture error', { error });
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Failed to save profile picture', 500);
  }
});

export default router;
