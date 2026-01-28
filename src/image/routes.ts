import { Router, Request, Response } from 'express';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { logger } from '../utils/logger';
import { AppError } from '../utils/errorHandler';
import { prisma } from '../index';

const router = Router();

// Initialize S3 client
const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },
});

// Accept both S3_BUCKET_NAME and AWS_S3_BUCKET_NAME for compatibility
const BUCKET_NAME = process.env.S3_BUCKET_NAME || process.env.AWS_S3_BUCKET_NAME || 'banter-uploads';

/**
 * POST /api/images/presign
 * Generate presigned URL for direct S3 upload
 */
router.post('/presign', async (req: Request, res: Response) => {
  try {
    const privyDid = req.privyDid;
    if (!privyDid) {
      throw new AppError('User not authenticated', 401);
    }

    const { filename, mimeType, type } = req.body;

    if (!filename || !mimeType) {
      throw new AppError('Filename and mimeType are required', 400);
    }

    const user = await prisma.user.findUnique({
      where: { privyDid },
    });

    if (!user) {
      throw new AppError('User not found', 404);
    }

    // Validate type
    const validTypes = ['profile', 'banner', 'post'];
    if (type && !validTypes.includes(type)) {
      throw new AppError(`Type must be one of: ${validTypes.join(', ')}`, 400);
    }

    // Generate S3 key
    const timestamp = Date.now();
    const sanitizedFilename = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
    const key = type
      ? `user-uploads/${user.id}/${type}/${timestamp}_${sanitizedFilename}`
      : `user-uploads/${user.id}/${timestamp}_${sanitizedFilename}`;

    // Generate presigned URL
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      ContentType: mimeType,
      ACL: 'public-read', // Adjust based on your bucket policy
    });

    const uploadUrl = await getSignedUrl(s3Client, command, {
      expiresIn: 3600, // 1 hour
    });

    // Construct view URL (adjust based on your CDN/bucket URL structure)
    const viewUrl = `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${key}`;

    logger.info(`Generated presigned URL for user ${user.id}: ${key}`);

    res.json({
      success: true,
      uploadUrl,
      key,
      viewUrl,
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
 * POST /api/images/save-profile-picture
 * Save profile picture URL to user profile
 */
router.post('/save-profile-picture', async (req: Request, res: Response) => {
  try {
    const privyDid = req.privyDid;
    if (!privyDid) {
      throw new AppError('User not authenticated', 401);
    }

    const { imageUrl } = req.body;

    if (!imageUrl) {
      throw new AppError('Image URL is required', 400);
    }

    const user = await prisma.user.findUnique({
      where: { privyDid },
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
