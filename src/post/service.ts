import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { prisma } from '../index';
import { logger } from '../utils/logger';

const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'eu-north-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },
  requestChecksumCalculation: 'NEVER' as any,
} as any);

const BUCKET_NAME = process.env.S3_BUCKET_NAME || process.env.AWS_S3_BUCKET_NAME || '';

type MediaCollectionInput = {
  mediaUrl?: string | null;
  mediaItems?: unknown;
};

function extractKeyFromUrl(url?: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.pathname.replace(/^\/+/, '');
  } catch {
    return null;
  }
}

function getBaseNameFromHlsPath(path: string): string | null {
  if (!path.startsWith('hls/')) return null;
  const trimmed = path.slice('hls/'.length);
  const lastSlash = trimmed.lastIndexOf('/');
  if (lastSlash <= 0) return null;
  return trimmed.slice(0, lastSlash);
}

async function deletePrefix(prefix: string) {
  if (!BUCKET_NAME) {
    logger.warn('Skipping S3 delete because bucket is not configured', { prefix });
    return;
  }

  let continuationToken: string | undefined;
  do {
    const list = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: BUCKET_NAME,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );
    const objects = (list.Contents || [])
      .map((obj) => obj.Key)
      .filter((key): key is string => !!key)
      .map((Key) => ({ Key }));

    if (objects.length) {
      await s3Client.send(
        new DeleteObjectsCommand({
          Bucket: BUCKET_NAME,
          Delete: { Objects: objects },
        })
      );
    }

    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (continuationToken);
}

async function deletePostMedia(mediaUrl?: string | null) {
  if (!mediaUrl) return;
  const keyPath = extractKeyFromUrl(mediaUrl);
  if (!keyPath) return;

  if (keyPath.startsWith('user-uploads/')) {
    const baseName = keyPath.replace(/^user-uploads\//, '').replace(/\.[^.]+$/, '');
    await deletePrefix(`user-uploads/${baseName}`);
    await deletePrefix(`hls/${baseName}/`);
    return;
  }

  if (keyPath.startsWith('hls/')) {
    const baseName = getBaseNameFromHlsPath(keyPath);
    if (!baseName) return;
    await deletePrefix(`hls/${baseName}/`);
    await deletePrefix(`user-uploads/${baseName}`);
  }
}

function collectMediaUrls(input: MediaCollectionInput): string[] {
  const urls = new Set<string>();

  if (typeof input.mediaUrl === 'string' && input.mediaUrl.trim()) {
    urls.add(input.mediaUrl.trim());
  }

  if (Array.isArray(input.mediaItems)) {
    for (const item of input.mediaItems) {
      if (!item || typeof item !== 'object') continue;
      const url = typeof (item as any).url === 'string' ? (item as any).url.trim() : '';
      if (url) {
        urls.add(url);
      }
    }
  }

  return Array.from(urls);
}

export async function deletePostMediaCollection(input: MediaCollectionInput) {
  const urls = collectMediaUrls(input);
  if (!urls.length) return;

  await Promise.allSettled(
    urls.map(async (url) => {
      try {
        await deletePostMedia(url);
      } catch (error) {
        logger.warn('Failed deleting post media from S3', { url, error });
      }
    })
  );
}

export async function hardDeletePost(postId: string) {
  const post = await prisma.post.findUnique({
    where: { id: postId },
    select: {
      id: true,
      repostOfId: true,
      mediaUrl: true,
      mediaItems: true,
    },
  });

  if (!post) {
    return { deleted: false, repostOfId: null as string | null, repostCount: null as number | null };
  }

  const result = await prisma.$transaction(async (tx) => {
    await tx.comment.deleteMany({ where: { postId } });
    await tx.reaction.deleteMany({ where: { postId } });
    await tx.vote.deleteMany({ where: { postId } });
    await tx.postTag.deleteMany({ where: { postId } });

    const deleted = await tx.post.delete({ where: { id: postId } });

    let repostCount: number | null = null;
    if (deleted.repostOfId) {
      const original = await tx.post.update({
        where: { id: deleted.repostOfId },
        data: {
          repostCount: { decrement: 1 },
        },
      });
      repostCount = original.repostCount;
    }

    return {
      deleted: true,
      repostOfId: deleted.repostOfId,
      repostCount,
      mediaUrl: deleted.mediaUrl,
      mediaItems: deleted.mediaItems,
    };
  });

  await deletePostMediaCollection({
    mediaUrl: result.mediaUrl,
    mediaItems: result.mediaItems,
  });

  return result;
}
