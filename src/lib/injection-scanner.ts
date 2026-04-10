/**
 * BE_03: Prompt Injection Scanner — Detection Engine
 *
 * Scans text content for prompt injection patterns. Designed to run on
 * NanoClaw context files (CLAUDE.md, MEMORY.md, COMPACT.md, daily notes)
 * before they're loaded into agent sessions.
 *
 * Used by: BE_04 (integration into container startup)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Finding {
  /** Which pattern matched */
  pattern: string;
  /** Severity level */
  severity: 'warning' | 'critical';
  /** 1-based line number where the match was found */
  line: number;
  /** The matched text (truncated to 120 chars) */
  snippet: string;
  /** Human-readable explanation */
  description: string;
}

export interface ScanResult {
  /** True if no findings were detected */
  clean: boolean;
  /** All findings, ordered by line number */
  findings: Finding[];
}

export interface ScannerOptions {
  /** Additional patterns to check beyond the built-in set */
  additionalPatterns?: {
    regex: RegExp;
    severity: 'warning' | 'critical';
    description: string;
  }[];
  /** Built-in pattern names to skip */
  ignorePatterns?: string[];
}

// ---------------------------------------------------------------------------
// Built-in patterns
// ---------------------------------------------------------------------------

interface PatternDef {
  name: string;
  regex: RegExp;
  severity: 'warning' | 'critical';
  description: string;
}

const BUILTIN_PATTERNS: PatternDef[] = [
  // -----------------------------------------------------------------------
  // Critical: instruction override attempts
  // -----------------------------------------------------------------------
  {
    name: 'instruction-override',
    regex:
      /\b(?:ignore|disregard|forget|override|bypass|skip|drop)\b.{0,40}\b(?:prior|previous|above|earlier|system|original|all)\b.{0,40}\b(?:instructions?|prompts?|rules?|guidelines?|context)\b/i,
    severity: 'critical',
    description: 'Attempts to override prior instructions',
  },
  {
    name: 'instruction-override-reverse',
    regex:
      /\b(?:prior|previous|above|earlier|system|original|all)\b.{0,40}\b(?:instructions?|prompts?|rules?|guidelines?|context)\b.{0,40}\b(?:ignore[d]?|disregard(?:ed)?|forgotten?|overrid(?:den|e)|bypass(?:ed)?)\b/i,
    severity: 'critical',
    description: 'Attempts to override prior instructions (reversed phrasing)',
  },
  {
    name: 'new-instructions',
    regex:
      /\b(?:you\s+are\s+now|from\s+now\s+on|new\s+instructions?|real\s+instructions?|actual\s+instructions?|true\s+instructions?)\b/i,
    severity: 'critical',
    description: 'Attempts to inject new identity or instructions',
  },

  // -----------------------------------------------------------------------
  // Critical: credential exfiltration via curl/wget
  // -----------------------------------------------------------------------
  {
    name: 'curl-exfil',
    regex:
      /\bcurl\b.{0,200}(?:\$[\w{]|\/etc\/|\.env\b|secrets?\b|credentials?\b|\.netrc|\.ssh|api[_-]?key|token\b)/i,
    severity: 'critical',
    description: 'curl command with potential credential exfiltration',
  },
  {
    name: 'wget-exfil',
    regex:
      /\bwget\b.{0,200}(?:\$[\w{]|\/etc\/|\.env\b|secrets?\b|credentials?\b|\.netrc|\.ssh|api[_-]?key|token\b)/i,
    severity: 'critical',
    description: 'wget command with potential credential exfiltration',
  },

  // -----------------------------------------------------------------------
  // Critical: direct secret file access
  // -----------------------------------------------------------------------
  {
    name: 'secret-file-read',
    regex:
      /\b(?:cat|less|more|head|tail|bat|type|read|open|source)\b.{0,60}(?:\.env\b|secrets?\.env|credentials?\b|\.netrc|~\/\.ssh\/|\/home\/\w+\/\.ssh\/)/i,
    severity: 'critical',
    description: 'Attempts to read secret/credential files',
  },

  // -----------------------------------------------------------------------
  // Critical: base64-encoded command execution
  // -----------------------------------------------------------------------
  {
    name: 'base64-exec',
    regex:
      /\bbase64\s+(?:-d|--decode)\b.{0,40}\b(?:sh|bash|zsh|eval|exec|python|node)\b/i,
    severity: 'critical',
    description: 'Base64-decoded content piped to shell execution',
  },
  {
    name: 'base64-exec-reverse',
    regex: /\becho\b.{0,200}\|\s*\bbase64\s+(?:-d|--decode)\b/i,
    severity: 'critical',
    description: 'Echo + base64 decode pipeline (potential obfuscated command)',
  },

  // -----------------------------------------------------------------------
  // Critical: settings.json override (Claude Code specific)
  // -----------------------------------------------------------------------
  {
    name: 'settings-override',
    regex: /\/home\/node\/\.claude\/settings\.json/i,
    severity: 'critical',
    description:
      'Attempts to write to Claude settings.json (permission/model override)',
  },

  // -----------------------------------------------------------------------
  // Warning: suspicious HTML comments
  // -----------------------------------------------------------------------
  {
    name: 'suspicious-html-comment',
    regex:
      /<!--[\s\S]{0,500}?\b(?:system|prompt|instruction|ignore|override|secret|password|credential)\b[\s\S]{0,500}?-->/i,
    severity: 'warning',
    description: 'HTML comment containing suspicious keywords',
  },

  // -----------------------------------------------------------------------
  // Warning: invisible Unicode characters
  // -----------------------------------------------------------------------
  {
    name: 'invisible-unicode',
    regex: /[\u200B\u200C\u200D\u2060\uFEFF]/,
    severity: 'warning',
    description: 'Invisible Unicode characters (zero-width spaces/joiners)',
  },
  {
    name: 'bidi-override',
    regex: /[\u202A-\u202E\u2066-\u2069]/,
    severity: 'warning',
    description:
      'Bidirectional text override characters (can hide content direction)',
  },

  // -----------------------------------------------------------------------
  // Warning: hidden content via markdown/HTML
  // -----------------------------------------------------------------------
  {
    name: 'hidden-html-content',
    regex:
      /<(?:div|span|p)\s[^>]*(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|opacity\s*:\s*0)[^>]*>/i,
    severity: 'warning',
    description:
      'HTML element with hidden styling (content invisible to human review)',
  },

  // -----------------------------------------------------------------------
  // Warning: unusually long lines
  // -----------------------------------------------------------------------
  {
    name: 'long-line',
    // Handled specially in scan logic — not a regex match on full content
    regex: /(?:)/, // placeholder, actual check is in scanForInjection
    severity: 'warning',
    description: 'Unusually long line (>5000 chars) that could hide content',
  },
];

// ---------------------------------------------------------------------------
// Scanner implementation
// ---------------------------------------------------------------------------

const SNIPPET_MAX_LEN = 120;

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * Scan content for prompt injection patterns.
 *
 * @param content  - The full text content to scan
 * @param filename - The filename (for context in findings, not used for logic)
 * @param options  - Optional overrides: additional patterns, patterns to skip
 * @returns ScanResult with clean flag and ordered findings
 */
export function scanForInjection(
  content: string,
  filename: string,
  options: ScannerOptions = {},
): ScanResult {
  const findings: Finding[] = [];
  const ignored = new Set(options.ignorePatterns ?? []);

  const lines = content.split('\n');

  // --- Built-in patterns (line-by-line for line numbers) ---
  for (const pattern of BUILTIN_PATTERNS) {
    if (ignored.has(pattern.name)) continue;

    // Special handling for long-line check
    if (pattern.name === 'long-line') {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].length > 5000) {
          findings.push({
            pattern: pattern.name,
            severity: pattern.severity,
            line: i + 1,
            snippet: truncate(lines[i], SNIPPET_MAX_LEN),
            description: `${pattern.description} (${lines[i].length} chars)`,
          });
        }
      }
      continue;
    }

    // For multi-line patterns (like HTML comments), scan full content first
    // then map match position back to line number
    if (
      pattern.name === 'suspicious-html-comment' ||
      pattern.name === 'hidden-html-content'
    ) {
      const globalRegex = new RegExp(
        pattern.regex.source,
        pattern.regex.flags + (pattern.regex.flags.includes('g') ? '' : 'g'),
      );
      let match: RegExpExecArray | null;
      while ((match = globalRegex.exec(content)) !== null) {
        const lineNum = content.slice(0, match.index).split('\n').length;
        findings.push({
          pattern: pattern.name,
          severity: pattern.severity,
          line: lineNum,
          snippet: truncate(match[0], SNIPPET_MAX_LEN),
          description: pattern.description,
        });
      }
      continue;
    }

    // Standard line-by-line scan
    for (let i = 0; i < lines.length; i++) {
      const match = pattern.regex.exec(lines[i]);
      if (match) {
        findings.push({
          pattern: pattern.name,
          severity: pattern.severity,
          line: i + 1,
          snippet: truncate(match[0], SNIPPET_MAX_LEN),
          description: pattern.description,
        });
      }
    }
  }

  // --- Additional user-supplied patterns ---
  if (options.additionalPatterns) {
    for (const custom of options.additionalPatterns) {
      if (ignored.has(custom.description)) continue;
      for (let i = 0; i < lines.length; i++) {
        const match = custom.regex.exec(lines[i]);
        if (match) {
          findings.push({
            pattern: 'custom',
            severity: custom.severity,
            line: i + 1,
            snippet: truncate(match[0], SNIPPET_MAX_LEN),
            description: custom.description,
          });
        }
      }
    }
  }

  // Sort by line number
  findings.sort((a, b) => a.line - b.line);

  return {
    clean: findings.length === 0,
    findings,
  };
}
