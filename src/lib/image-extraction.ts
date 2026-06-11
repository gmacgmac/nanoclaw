/**
 * Image Extraction Helper
 *
 * Extracts and encodes images from message arrays for vision-capable models.
 * Consolidates the duplicated extraction logic from processGroupMessages
 * and startMessageLoop into a single reusable function.
 */

import path from 'path';

import {
  encodeImageForVision,
  isSupportedImage,
  EncodedImage,
} from '../image.js';
import { GROUPS_DIR } from '../config.js';
import { NewMessage } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Regex to match photo messages: `[Photo]: /path/to/image.jpg optional caption`
 *
 * Path group uses a non-greedy match up to the file extension, so paths
 * containing spaces (e.g. "Dropbox (Personal)/...") are handled correctly.
 * The extension boundary `\b` ensures the match ends at the extension.
 * Caption group uses `[\s\S]+` to capture across newlines — Telegram captions
 * frequently contain line breaks which would cause `.+$` to fail.
 */
export const PHOTO_MESSAGE_REGEX =
  /^\[Photo\]:\s*(.+?\.(?:jpe?g|png|webp|gif))(?:\s([\s\S]+))?$/i;

/** Default max payload size for encoded images (10MB) */
export const DEFAULT_IMAGE_PAYLOAD_LIMIT = 10 * 1024 * 1024;

/** Container path prefix for group folder mounts */
const CONTAINER_GROUP_PREFIX = '/workspace/group/';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImageExtractionResult {
  images: EncodedImage[];
  totalSize: number;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Path Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a file path that may be a container-relative path to the actual
 * host filesystem path. Container paths start with /workspace/group/ and
 * map to GROUPS_DIR/{groupFolder}/{relative} on the host.
 *
 * If the path is already absolute (host path from legacy messages) or no
 * groupFolder is provided, returns the path unchanged.
 */
function resolveImagePath(filePath: string, groupFolder?: string): string {
  if (filePath.startsWith(CONTAINER_GROUP_PREFIX) && groupFolder) {
    const relative = filePath.slice(CONTAINER_GROUP_PREFIX.length);
    return path.join(GROUPS_DIR, groupFolder, relative);
  }
  return filePath;
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
 * @param opts.groupFolder - Group folder name for resolving container paths to host paths
 * @returns Extracted images, total size, and whether the limit was hit
 */
export async function extractImagesFromMessages(
  messages: NewMessage[],
  opts?: { maxPayloadBytes?: number; groupFolder?: string },
): Promise<ImageExtractionResult> {
  const limit = opts?.maxPayloadBytes ?? DEFAULT_IMAGE_PAYLOAD_LIMIT;
  const groupFolder = opts?.groupFolder;
  const images: EncodedImage[] = [];
  let totalSize = 0;
  let truncated = false;

  for (const msg of messages) {
    const photoMatch = msg.content.match(PHOTO_MESSAGE_REGEX);
    if (photoMatch) {
      const rawPath = photoMatch[1].trim();
      const caption = photoMatch[2]?.trim();
      const filePath = resolveImagePath(rawPath, groupFolder);
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
