import { Request, Response, NextFunction } from 'express';
import { verifyToken, JWTPayload } from './jwt';
import { AppError } from '../utils/errorHandler';
import { logger } from '../utils/logger';

// Extend Express Request to include user
declare global {
  namespace Express {
    interface Request {
      user?: {
        userId: string;
        email: string;
      };
    }
  }
}

/**
 * Middleware to verify JWT token from mobile frontend
 */
export const jwtAuthMiddleware = async (
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AppError('No authentication token provided', 401);
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix

    // Verify JWT token
    const payload: JWTPayload = verifyToken(token);
    
    // Attach user to request
    req.user = {
      userId: payload.userId,
      email: payload.email,
    };

    logger.debug(`Authenticated user: ${payload.userId}`);
    next();
  } catch (error: unknown) {
    logger.error('JWT authentication failed', { error });
    
    if (error instanceof AppError) {
      return next(error);
    }
    
    return next(new AppError('Invalid authentication token', 401));
  }
};
