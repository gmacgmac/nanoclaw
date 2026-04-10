/**
 * BE_04: Prompt Injection Scanner — Context File Integration
 *
 * Scans group context files (CLAUDE.md, MEMORY.md, COMPACT.md, daily notes)
 * on the host before container launch. Runs in runAgent() in src/index.ts.
 */

import fs from 'fs';
import path from 'path';

import { scanForInjection, Finding } from './injection-scanner.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InjectionScanMode = 'off' | 'warn' | 'block';

export interface ContextScanFinding extends Finding {
  /** Relative path of the scanned file (e.g. "memory/MEMORY.md") */
  file: string;
}

export interface ContextScanResult {
  /** True if no findings at all */
  clean: boolean;
  /** True if any critical-severity finding exists */
  hasCritical: boolean;
  /** All findings across all files */
  findings: ContextScanFinding[];
  /** Files that were scanned */
  scannedFiles: string[];
  /** Files that were skipped (missing / read error) */
  skippedFiles: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max bytes to scan per file — truncate beyond this */
const MAX_SCAN_BYTES = 100 * 1024; // 100KB

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Discover context files in a group folder that the SDK will load.
 * Returns relative paths (relative to groupFolderPath).
 */
export function discoverContextFiles(
  groupFolderPath: string,
  globalFolderPath?: string,
): string[] {
  const files: string[] = [];

  // CLAUDE.md — SDK auto-loads from cwd
  if (fs.existsSync(path.join(groupFolderPath, 'CLAUDE.md'))) {
    files.push('CLAUDE.md');
  }

  // memory/MEMORY.md and memory/COMPACT.md — loaded via @import
  const memoryDir = path.join(groupFolderPath, 'memory');
  if (fs.existsSync(memoryDir) && fs.statSync(memoryDir).isDirectory()) {
    try {
      for (const entry of fs.readdirSync(memoryDir)) {
        if (entry.endsWith('.md')) {
          files.push(path.join('memory', entry));
        }
      }
    } catch {
      // Read error on memory dir — will be logged as skipped
    }
  }

  // global/CLAUDE.md — for non-main groups, the global folder is also mounted
  if (
    globalFolderPath &&
    fs.existsSync(path.join(globalFolderPath, 'CLAUDE.md'))
  ) {
    files.push('global/CLAUDE.md');
  }

  return files;
}

/**
 * Read a file safely, truncating to MAX_SCAN_BYTES.
 * Returns [content, wasTruncated] or null on error.
 */
function safeReadFile(filePath: string): [string, boolean] | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(Math.min(stat.size, MAX_SCAN_BYTES));
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
      return [buf.toString('utf8', 0, bytesRead), stat.size > MAX_SCAN_BYTES];
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Scan all context files for a group.
 *
 * @param groupFolderPath - Absolute path to the group folder (from resolveGroupFolderPath)
 * @param globalFolderPath - Absolute path to the global folder (undefined for main group)
 */
export function scanContextFiles(
  groupFolderPath: string,
  globalFolderPath?: string,
): ContextScanResult {
  const relativePaths = discoverContextFiles(groupFolderPath, globalFolderPath);
  const findings: ContextScanFinding[] = [];
  const scannedFiles: string[] = [];
  const skippedFiles: string[] = [];

  for (const relPath of relativePaths) {
    // Resolve the actual filesystem path
    const absPath = relPath.startsWith('global/')
      ? path.join(globalFolderPath!, relPath.slice('global/'.length))
      : path.join(groupFolderPath, relPath);

    const readResult = safeReadFile(absPath);
    if (!readResult) {
      skippedFiles.push(relPath);
      continue;
    }

    const [content, wasTruncated] = readResult;
    scannedFiles.push(relPath);

    const scanResult = scanForInjection(content, relPath);

    if (wasTruncated) {
      findings.push({
        file: relPath,
        pattern: 'file-truncated',
        severity: 'warning',
        line: 0,
        snippet: `File exceeds ${MAX_SCAN_BYTES / 1024}KB — only first ${MAX_SCAN_BYTES / 1024}KB scanned`,
        description: 'Large file was truncated for scanning',
      });
    }

    for (const f of scanResult.findings) {
      findings.push({ ...f, file: relPath });
    }
  }

  return {
    clean: findings.length === 0,
    hasCritical: findings.some((f) => f.severity === 'critical'),
    findings,
    scannedFiles,
    skippedFiles,
  };
}
