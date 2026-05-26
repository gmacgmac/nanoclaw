/**
 * Image Extraction Helper
 *
 * Extracts and encodes images from message arrays for vision-capable models.
 * Consolidates the duplicated extraction logic from processGroupMessages
 * and startMessageLoop into a single reusable function.
 */

import {
  encodeImageForVision,
  isSupportedImage,
  EncodedImage,
} from '../image.js';
import { NewMessage } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Regex to match photo messages: `[Photo]: /path/to/image.jpg optional caption` */
export const PHOTO_MESSAGE_REGEX =
  /^\[Photo\]:\s*(.+\.(?:jpe?g|png|webp|gif))(?:\s(.+))?$/i;

/** Default max payload size for encoded images (10MB) */
export const DEFAULT_IMAGE_PAYLOAD_LIMIT = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImageExtractionResult {
  images: EncodedImage[];
  totalSize: number;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Extract and encode images from an array of messages.
 *
 * Iterates messages looking for `[Photo]:` content, validates the file path,
 * encodes the image for vision, and accumulates results up to the payload limit.
 *
 * @param messages - Messages to scan for photo content
 * @param opts.maxPayloadBytes - Max total base64 payload size (default: 10MB)
 * @returns Extracted images, total size, and whether the limit was hit
 */
export async function extractImagesFromMessages(
  messages: NewMessage[],
  opts?: { maxPayloadBytes?: number },
): Promise<ImageExtractionResult> {
  const limit = opts?.maxPayloadBytes ?? DEFAULT_IMAGE_PAYLOAD_LIMIT;
  const images: EncodedImage[] = [];
  let totalSize = 0;
  let truncated = false;

  for (const msg of messages) {
    const photoMatch = msg.content.match(PHOTO_MESSAGE_REGEX);
    if (photoMatch) {
      const filePath = photoMatch[1].trim();
      const caption = photoMatch[2]?.trim();
      if (isSupportedImage(filePath)) {
        const encoded = await encodeImageForVision(filePath, caption);
        if (encoded) {
          const entrySize = encoded.base64.length;
          if (totalSize + entrySize > limit) {
            truncated = true;
            break;
          }
          totalSize += entrySize;
          images.push(encoded);
        }
      }
    }
  }

  return { images, totalSize, truncated };
}
