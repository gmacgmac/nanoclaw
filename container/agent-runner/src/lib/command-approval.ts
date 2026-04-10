/**
 * Command Approval — Dangerous Command Detector (MCP Server Copy)
 *
 * Detects dangerous shell commands and determines whether user approval
 * is required based on write-mounted paths. Used by the `execute_command`
 * MCP tool when `approvalMode` is enabled.
 *
 * IMPORTANT: This is a copy of src/lib/command-approval.ts from the host codebase.
 * The MCP server runs inside the container as a self-contained package and cannot
 * import from the host's src/lib/ at runtime.
 *
 * Source of truth: src/lib/command-approval.ts (BE_05)
 */

export interface MatchedPattern {
  name: string;
  description: string;
  matched: string;
}

export interface CommandAssessment {
  dangerous: boolean;
  patterns: MatchedPattern[];
}

export interface ApprovalDecision {
  needed: boolean;
  patterns: MatchedPattern[];
  targetPaths: string[];
}

interface PatternDef {
  name: string;
  description: string;
  regex: RegExp;
}

// ---------------------------------------------------------------------------
// Dangerous command patterns
// ---------------------------------------------------------------------------

const DANGEROUS_PATTERNS: PatternDef[] = [
  // --- File destruction ---
  {
    name: 'rm-recursive',
    description: 'Recursive file deletion',
    regex: /\brm\b[^|;]*(?:-[a-zA-Z]*[rR][a-zA-Z]*\b|--recursive\b)/,
  },
  {
    name: 'find-delete',
    description: 'Find with delete action',
    regex: /\bfind\b[^|;]*(?:-exec\s+rm\b|-delete\b)/,
  },
  {
    name: 'xargs-rm',
    description: 'Piped deletion via xargs',
    regex: /\bxargs\b[^|;]*\brm\b/,
  },

  // --- File permission / ownership ---
  {
    name: 'chmod-world-writable',
    description: 'Setting world-writable permissions',
    regex: /\bchmod\b[^|;]*(?:\b(?:777|666)\b|[oa]\+w\b|a\+w\b)/,
  },
  {
    name: 'chown-recursive-root',
    description: 'Recursive ownership change to root',
    regex: /\bchown\b[^|;]*-[a-zA-Z]*R[a-zA-Z]*\b[^|;]*\broot\b/,
  },

  // --- Data modification (path-sensitive) ---
  {
    name: 'sed-in-place',
    description: 'In-place file modification via sed',
    regex: /\bsed\b[^|;]*(?:-i\b|--in-place\b)/,
  },
  {
    name: 'mv-overwrite',
    description: 'File move (potential overwrite)',
    regex: /\bmv\b\s+/,
  },
  {
    name: 'cp-overwrite',
    description: 'File copy (potential overwrite)',
    regex: /\bcp\b\s+/,
  },
  {
    name: 'redirect-write',
    description: 'Output redirect to file',
    regex: />{1,2}\s*\S/,
  },

  // --- SQL destructive ---
  {
    name: 'sql-drop',
    description: 'SQL DROP statement',
    regex: /\bDROP\s+(?:TABLE|DATABASE)\b/i,
  },
  {
    name: 'sql-delete-no-where',
    description: 'SQL DELETE without WHERE clause',
    regex: /\bDELETE\s+FROM\b(?![\s\S]*\bWHERE\b)/i,
  },
  {
    name: 'sql-truncate',
    description: 'SQL TRUNCATE statement',
    regex: /\bTRUNCATE\s+TABLE\b/i,
  },

  // --- Remote code execution ---
  {
    name: 'curl-pipe-shell',
    description: 'Piping remote content to shell',
    regex: /\bcurl\b[^|]*\|\s*(?:sh|bash|zsh)\b/,
  },
  {
    name: 'wget-pipe-shell',
    description: 'Piping remote content to shell',
    regex: /\bwget\b[^|]*\|\s*(?:sh|bash|zsh)\b/,
  },
  {
    name: 'process-substitution-shell',
    description: 'Process substitution with remote fetch',
    regex: /\b(?:bash|sh)\b\s+<\(\s*(?:curl|wget)\b/,
  },
  {
    name: 'shell-eval',
    description: 'Shell string evaluation',
    regex: /\b(?:bash|sh)\s+-c\b/,
  },
  {
    name: 'python-eval',
    description: 'Python command-line execution',
    regex: /\bpython[23]?\s+-[ce]\b/,
  },
  {
    name: 'node-eval',
    description: 'Node.js command-line evaluation',
    regex: /\bnode\s+-[ep]\b/,
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function isDangerousCommand(command: string): CommandAssessment {
  const patterns: MatchedPattern[] = [];

  for (const def of DANGEROUS_PATTERNS) {
    const match = command.match(def.regex);
    if (match) {
      patterns.push({
        name: def.name,
        description: def.description,
        matched: match[0],
      });
    }
  }

  return { dangerous: patterns.length > 0, patterns };
}

export function requiresApproval(
  command: string,
  writeMountPaths: string[],
): ApprovalDecision {
  const assessment = isDangerousCommand(command);

  if (!assessment.dangerous) {
    return { needed: false, patterns: [], targetPaths: [] };
  }

  const targetPaths = writeMountPaths.filter((mountPath) =>
    command.includes(mountPath),
  );

  if (targetPaths.length === 0) {
    return { needed: false, patterns: assessment.patterns, targetPaths: [] };
  }

  return {
    needed: true,
    patterns: assessment.patterns,
    targetPaths,
  };
}
