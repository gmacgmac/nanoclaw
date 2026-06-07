import type { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';

/**
 * Returns middleware that validates req.body against the given Zod schema.
 * On failure, returns 400 with structured error details.
 */
export function validateBody(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const formatted = formatZodError(result.error);
      res.status(400).json({ error: 'Validation failed', details: formatted });
      return;
    }
    req.body = result.data;
    next();
  };
}

function formatZodError(
  error: ZodError,
): Array<{ path: string; message: string }> {
  return error.issues.map((e) => ({
    path: e.path.join('.'),
    message: e.message,
  }));
}
