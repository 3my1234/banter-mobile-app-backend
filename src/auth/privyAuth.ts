import { Request, Response, NextFunction } from 'express';
import { PrivyClient } from '@privy-io/server-auth';
import { logger } from '../utils/logger';
import { AppError } from '../utils/errorHandler';

// Initialize Privy client
const privyClient = new PrivyClient(
  process.env.PRIVY_APP_ID || '',
  process.env.PRIVY_APP_SECRET || ''
);

export interface PrivyUser {
  userId: string;
  id: string; // Privy DID
  email?: string;
  [key: string]: unknown;
}

// Extend Express Request to include user
declare global {
  namespace Express {
    interface Request {
      user?: PrivyUser;
      privyDid?: string;
    }
  }
}

/**
 * Middleware to verify Privy JWT token from mobile frontend
 */
export const privyAuthMiddleware = async (
  req: Request,
  _res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AppError('No authentication token provided', 401);
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix

    // Verify Privy token
    const claims = await privyClient.verifyAuthToken(token) as any;
    
    // Extract user information
    const privyUser: PrivyUser = {
      userId: claims.userId,
      id: claims.id || claims.userId, // Privy DID
      email: claims.email,
      ...claims,
    };

    // Attach user to request
    req.user = privyUser;
    req.privyDid = privyUser.id;

    logger.debug(`Authenticated user: ${privyUser.id}`);
    next();
  } catch (error: unknown) {
    logger.error('Privy authentication failed', { error });
    
    if (error instanceof AppError) {
      return next(error);
    }
    
    return next(new AppError('Invalid authentication token', 401));
  }
};

/**
 * Get Privy user details by user ID
 */
export const getPrivyUser = async (userId: string) => {
  try {
    const user = await privyClient.getUser(userId);
    return user;
  } catch (error) {
    logger.error(`Failed to get Privy user ${userId}`, { error });
    throw error;
  }
};
