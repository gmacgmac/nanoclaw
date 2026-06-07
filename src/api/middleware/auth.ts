import type { Request, Response, NextFunction } from 'express';
import { API_TOKEN } from '../../config.js';

/**
 * Auth middleware. If API_TOKEN is set, requires Bearer token in Authorization header.
 * If API_TOKEN is empty (default), all requests are allowed (localhost dev mode).
 */
export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!API_TOKEN) {
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res
      .status(401)
      .json({
        error: 'Missing or invalid Authorization header. Use: Bearer <token>',
      });
    return;
  }

  const token = authHeader.slice(7);
  if (token !== API_TOKEN) {
    res.status(403).json({ error: 'Invalid token' });
    return;
  }

  next();
}
