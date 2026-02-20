import { Router, Request, Response } from 'express';
import { prisma } from '../index';
import { logger } from '../utils/logger';
import { AppError } from '../utils/errorHandler';
import { getIO } from '../websocket/socket';

const router = Router();

type VoteRecord = {
  id: string;
  postId: string;
  userId: string;
  voteType: string;
  createdAt: Date;
};

type VoteWithUser = VoteRecord & {
  user: {
    id: string;
    displayName: string | null;
    username: string | null;
    avatarUrl: string | null;
  };
};

/**
 * POST /api/votes
 * Cast a Stay or Drop vote on a post
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      throw new AppError('User not authenticated', 401);
    }

    const { postId, voteType } = req.body;

    if (!postId) {
      throw new AppError('Post ID is required', 400);
    }

    if (!voteType || !['STAY', 'DROP'].includes(voteType)) {
      throw new AppError('Vote type must be STAY or DROP', 400);
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new AppError('User not found', 404);
    }

    // Check if post exists and is active
    const post = await prisma.post.findUnique({
      where: { id: postId },
    });

    if (!post) {
      throw new AppError('Post not found', 404);
    }

    if (post.status !== 'ACTIVE') {
      throw new AppError('Post is no longer active', 400);
    }

    if (post.userId === user.id) {
      throw new AppError("You can't vote on your own post.", 400);
    }

    // Check if user already voted
    const existingVote = await prisma.vote.findUnique({
      where: {
        postId_userId: {
          postId,
          userId: user.id,
        },
      },
    });

    let vote: VoteRecord;
    let voteCountChange = { stay: 0, drop: 0 };

    const isPaidVote = !post.isRoast;

    if (existingVote) {
      // Update existing vote
      if (existingVote.voteType === voteType) {
        // Same vote, no change
        return res.json({
          success: true,
          message: 'Vote already cast',
          vote: existingVote,
        });
      }

      // Change vote
      const oldVoteType = existingVote.voteType;
      vote = await prisma.vote.update({
        where: { id: existingVote.id },
        data: { voteType },
      });

      // Update vote counts
      if (oldVoteType === 'STAY' && voteType === 'DROP') {
        voteCountChange = { stay: -1, drop: 1 };
      } else if (oldVoteType === 'DROP' && voteType === 'STAY') {
        voteCountChange = { stay: 1, drop: -1 };
      }
    } else {
      if (isPaidVote && user.voteBalance <= 0) {
        throw new AppError('You need vote credits to vote. Buy more in the Votes tab.', 402);
      }

      // Create new vote (decrement balance only for paid votes)
      if (isPaidVote) {
        vote = await prisma.$transaction(async (tx) => {
          const created = await tx.vote.create({
            data: {
              postId,
              userId: user.id,
              voteType,
            },
          });

          await tx.user.update({
            where: { id: user.id },
            data: {
              voteBalance: {
                decrement: 1,
              },
            },
          });

          return created;
        });
      } else {
        vote = await prisma.vote.create({
          data: {
            postId,
            userId: user.id,
            voteType,
          },
        });
      }

      // Update vote counts
      if (voteType === 'STAY') {
        voteCountChange = { stay: 1, drop: 0 };
      } else {
        voteCountChange = { stay: 0, drop: 1 };
      }
    }

    // Update post vote counts
    const updatedPost = await prisma.post.update({
      where: { id: postId },
      data: {
        stayVotes: {
          increment: voteCountChange.stay,
        },
        dropVotes: {
          increment: voteCountChange.drop,
        },
      },
    });

    // Emit real-time update via WebSocket
    getIO().emit('vote-update', {
      postId,
      stayVotes: updatedPost.stayVotes,
      dropVotes: updatedPost.dropVotes,
      voteType,
      userId: user.id,
    });

    logger.info(`Vote cast: ${voteType} on post ${postId} by user ${user.id}`);

    return res.json({
      success: true,
      vote: {
        id: vote.id,
        postId: vote.postId,
        userId: vote.userId,
        voteType: vote.voteType,
        createdAt: vote.createdAt,
      },
      post: {
        id: updatedPost.id,
        stayVotes: updatedPost.stayVotes,
        dropVotes: updatedPost.dropVotes,
      },
    });
  } catch (error) {
    logger.error('Vote error', { error });
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message,
      });
    }
    return res.status(500).json({
      success: false,
      message: 'Failed to cast vote',
    });
  }
});

/**
 * GET /api/votes/post/:postId
 * Get all votes for a post
 */
router.get('/post/:postId', async (req: Request, res: Response) => {
  try {
    const postId = req.params.postId;

    const votes = await prisma.vote.findMany({
      where: { postId },
      include: {
        user: {
          select: {
            id: true,
            displayName: true,
            username: true,
            avatarUrl: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    }) as VoteWithUser[];

    return res.json({
      success: true,
      votes: votes.map((vote: VoteWithUser) => ({
        id: vote.id,
        voteType: vote.voteType,
        createdAt: vote.createdAt,
        user: vote.user,
      })),
    });
  } catch (error) {
    logger.error('Get votes error', { error });
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message,
      });
    }
    return res.status(500).json({
      success: false,
      message: 'Failed to get votes',
    });
  }
});

export default router;
