/**
 * BE_04: Prompt Injection Scanner — Context File Integration
 *
 * Scans group context files (CLAUDE.md, MEMORY.md, daily notes)
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

/** Max recursion depth for @import following (mirrors SDK limit) */
const MAX_IMPORT_DEPTH = 4;

// ---------------------------------------------------------------------------
// Import Resolution
// ---------------------------------------------------------------------------

/**
 * Parse @import references from file content.
 * Matches line-based `@<path>` tokens — over-inclusive by design (security scanner).
 * Returns raw path strings as they appear in the file.
 */
export function parseImportRefs(content: string): string[] {
  const refs: string[] = [];
  for (const line of content.split('\n')) {
    // Match @path tokens: @ followed by a relative or absolute path
    // Skip @-mentions that look like usernames (no path separators, no extensions)
    const matches = line.matchAll(
      /@(\.{0,2}\/[^\s]+|\/[^\s]+|[^\s]+\.[a-zA-Z]+)/g,
    );
    for (const m of matches) {
      refs.push(m[1]);
    }
  }
  return refs;
}

/**
 * Recursively resolve @import targets starting from a file.
 * Bounded by depth, cycle-safe, and confined to the group folder.
 *
 * @param startFile - Absolute path to the file to parse imports from
 * @param groupFolderPath - Absolute path to the group folder (traversal boundary)
 * @param depth - Current recursion depth (0-based)
 * @param visited - Set of already-visited absolute paths (cycle protection)
 * @param skipped - Array to collect skipped paths (missing / out-of-bounds)
 * @returns Array of absolute paths to import targets within the group folder
 */
export function resolveImports(
  startFile: string,
  groupFolderPath: string,
  depth: number = 0,
  visited: Set<string> = new Set(),
  skipped: string[] = [],
): string[] {
  if (depth >= MAX_IMPORT_DEPTH) return [];

  const resolved: string[] = [];

  // Read the file to find its imports
  let content: string;
  try {
    content = fs.readFileSync(startFile, 'utf8');
  } catch {
    return [];
  }

  const refs = parseImportRefs(content);
  const startDir = path.dirname(startFile);

  for (const ref of refs) {
    // Resolve relative to the importing file's directory
    const absTarget = path.isAbsolute(ref)
      ? path.resolve(ref)
      : path.resolve(startDir, ref);

    // Normalize to real path for cycle detection and traversal guard
    let realTarget: string;
    try {
      // If file exists, use realpath; otherwise use resolved path for the guard check
      realTarget = fs.existsSync(absTarget)
        ? fs.realpathSync(absTarget)
        : absTarget;
    } catch {
      realTarget = absTarget;
    }

    // Traversal guard: reject paths outside the group folder
    const normalizedGroup = fs.existsSync(groupFolderPath)
      ? fs.realpathSync(groupFolderPath)
      : path.resolve(groupFolderPath);
    if (
      !realTarget.startsWith(normalizedGroup + path.sep) &&
      realTarget !== normalizedGroup
    ) {
      skipped.push(ref);
      continue;
    }

    // Cycle protection
    if (visited.has(realTarget)) continue;

    // Check file exists
    if (!fs.existsSync(realTarget) || !fs.statSync(realTarget).isFile()) {
      skipped.push(ref);
      continue;
    }

    visited.add(realTarget);
    resolved.push(realTarget);

    // Recurse into this import's own imports
    const nested = resolveImports(
      realTarget,
      groupFolderPath,
      depth + 1,
      visited,
      skipped,
    );
    resolved.push(...nested);
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Discover context files in a group folder that the SDK will load.
 * Returns relative paths (relative to groupFolderPath), plus
 * `extra/<basename>/CLAUDE.md` labels for any extra-mount CLAUDE.md files,
 * plus `imported:<relPath>` labels for @import targets from the group CLAUDE.md.
 *
 * @param groupFolderPath - Absolute path to the group folder
 * @param extraMountPaths - Resolved host paths for additional mounts (from validateAdditionalMounts)
 */
export function discoverContextFiles(
  groupFolderPath: string,
  extraMountPaths?: string[],
): string[] {
  const files: string[] = [];

  // CLAUDE.md — SDK auto-loads from cwd
  const claudeMdPath = path.join(groupFolderPath, 'CLAUDE.md');
  if (fs.existsSync(claudeMdPath)) {
    files.push('CLAUDE.md');
  }

  // memory/MEMORY.md and daily notes — loaded via @import
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

  // Follow @import directives from the group CLAUDE.md (recursive, depth ≤ 4, group-bounded)
  if (fs.existsSync(claudeMdPath)) {
    const visited = new Set<string>();
    // Mark CLAUDE.md itself as visited so it won't be re-added as an import
    try {
      visited.add(fs.realpathSync(claudeMdPath));
    } catch {
      visited.add(path.resolve(claudeMdPath));
    }

    // Also mark memory files as visited to avoid double-scanning
    if (fs.existsSync(memoryDir) && fs.statSync(memoryDir).isDirectory()) {
      try {
        for (const entry of fs.readdirSync(memoryDir)) {
          if (entry.endsWith('.md')) {
            const memFile = path.join(memoryDir, entry);
            try {
              visited.add(fs.realpathSync(memFile));
            } catch {
              visited.add(path.resolve(memFile));
            }
          }
        }
      } catch {
        // ignore
      }
    }

    const skipped: string[] = [];
    const importTargets = resolveImports(
      claudeMdPath,
      groupFolderPath,
      0,
      visited,
      skipped,
    );

    // Normalize group folder for relative path computation (handles symlinks like /var → /private/var on macOS)
    const normalizedGroupFolder = fs.existsSync(groupFolderPath)
      ? fs.realpathSync(groupFolderPath)
      : path.resolve(groupFolderPath);

    for (const absImport of importTargets) {
      const relPath = path.relative(normalizedGroupFolder, absImport);
      // Skip if already discovered as a direct file (memory/*.md)
      if (!files.includes(relPath)) {
        files.push(`imported:${relPath}`);
      }
    }

    // Record skipped imports as special labels (will be added to skippedFiles)
    for (const s of skipped) {
      files.push(`imported-skipped:${s}`);
    }
  }

  // Extra-mount CLAUDE.md files — SDK auto-loads via additionalDirectories
  if (extraMountPaths) {
    for (const mountPath of extraMountPaths) {
      const claudeMd = path.join(mountPath, 'CLAUDE.md');
      if (fs.existsSync(claudeMd)) {
        const label = `extra/${path.basename(mountPath)}/CLAUDE.md`;
        files.push(label);
      }
    }
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
 * @param extraMountPaths - Resolved host paths for additional mounts (from validateAdditionalMounts)
 */
export function scanContextFiles(
  groupFolderPath: string,
  extraMountPaths?: string[],
): ContextScanResult {
  const relativePaths = discoverContextFiles(groupFolderPath, extraMountPaths);
  const findings: ContextScanFinding[] = [];
  const scannedFiles: string[] = [];
  const skippedFiles: string[] = [];

  // Build a lookup map for extra-mount labels → absolute host paths
  const extraMountMap = new Map<string, string>();
  if (extraMountPaths) {
    for (const mountPath of extraMountPaths) {
      const label = `extra/${path.basename(mountPath)}/CLAUDE.md`;
      extraMountMap.set(label, path.join(mountPath, 'CLAUDE.md'));
    }
  }

  for (const relPath of relativePaths) {
    // Handle skipped imports — just record them
    if (relPath.startsWith('imported-skipped:')) {
      skippedFiles.push(relPath);
      continue;
    }

    // Resolve the absolute path: extra-mount labels use the map,
    // imported: labels strip the prefix, others are group-relative
    let absPath: string;
    let displayLabel: string;
    if (extraMountMap.has(relPath)) {
      absPath = extraMountMap.get(relPath)!;
      displayLabel = relPath;
    } else if (relPath.startsWith('imported:')) {
      const importedRel = relPath.slice('imported:'.length);
      absPath = path.join(groupFolderPath, importedRel);
      displayLabel = relPath; // Keep "imported:..." label for findings
    } else {
      absPath = path.join(groupFolderPath, relPath);
      displayLabel = relPath;
    }

    const readResult = safeReadFile(absPath);
    if (!readResult) {
      skippedFiles.push(displayLabel);
      continue;
    }

    const [content, wasTruncated] = readResult;
    scannedFiles.push(displayLabel);

    const scanResult = scanForInjection(content, displayLabel);

    if (wasTruncated) {
      findings.push({
        file: displayLabel,
        pattern: 'file-truncated',
        severity: 'warning',
        line: 0,
        snippet: `File exceeds ${MAX_SCAN_BYTES / 1024}KB — only first ${MAX_SCAN_BYTES / 1024}KB scanned`,
        description: 'Large file was truncated for scanning',
      });
    }

    for (const f of scanResult.findings) {
      findings.push({ ...f, file: displayLabel });
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
