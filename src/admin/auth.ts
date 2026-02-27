import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AppError } from '../utils/errorHandler';

const JWT_SECRET = process.env.JWT_SECRET || 'banter-dev-secret-123';
const ADMIN_JWT_EXPIRES_IN = '12h';

type AdminPayload = {
  type: 'admin';
  email: string;
};

declare global {
  namespace Express {
    interface Request {
      admin?: {
        email: string;
      };
    }
  }
}

export const generateAdminToken = (email: string) => {
  const payload: AdminPayload = { type: 'admin', email };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: ADMIN_JWT_EXPIRES_IN });
};

export const adminAuthMiddleware = (req: Request, _res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AppError('No admin authentication token provided', 401);
    }

    const token = authHeader.slice(7);
    const decoded = jwt.verify(token, JWT_SECRET) as AdminPayload;
    if (decoded.type !== 'admin' || !decoded.email) {
      throw new AppError('Invalid admin token', 401);
    }

    req.admin = { email: decoded.email };
    next();
  } catch (error) {
    if (error instanceof AppError) {
      return next(error);
    }
    return next(new AppError('Invalid admin token', 401));
  }
};

