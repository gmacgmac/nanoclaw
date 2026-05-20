import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

import { logger } from './logger.js';

export interface EncodedImage {
  base64: string;
  mediaType: string; // e.g. 'image/jpeg', 'image/png', 'image/webp', 'image/gif'
  caption?: string;
}

const MAX_DIMENSION = 1568; // Claude's recommended max for vision
const SUPPORTED_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
]);

/**
 * Check if a file path points to a supported image format.
 */
export function isSupportedImage(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(ext);
}

/**
 * Resize an image to fit within MAX_DIMENSION and return base64-encoded data.
 * Returns null if the file doesn't exist, isn't a supported format, or processing fails.
 */
export async function encodeImageForVision(
  filePath: string,
  caption?: string,
): Promise<EncodedImage | null> {
  try {
    if (!fs.existsSync(filePath)) {
      logger.warn({ filePath }, 'Image file not found');
      return null;
    }

    if (!isSupportedImage(filePath)) {
      logger.debug({ filePath }, 'Unsupported image format for vision');
      return null;
    }

    const buffer = await sharp(filePath)
      .resize(MAX_DIMENSION, MAX_DIMENSION, {
        fit: 'inside', // maintain aspect ratio, fit within bounds
        withoutEnlargement: true, // don't upscale small images
      })
      .jpeg({ quality: 85 }) // normalize to JPEG for consistent size
      .toBuffer();

    return {
      base64: buffer.toString('base64'),
      mediaType: 'image/jpeg', // always JPEG after resize
      caption,
    };
  } catch (err) {
    logger.error({ err, filePath }, 'Image encoding failed');
    return null;
  }
}
