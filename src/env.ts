import fs from 'fs';
import path from 'path';

/**
 * Read config values from multiple sources in priority order:
 *   1. ~/.config/nanoclaw/secrets.env  (platform-agnostic, outside repo)
 *   2. .env in the project root        (non-sensitive config)
 *   3. process.env                      (shell exports, launchd plist, systemd env)
 *
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  // Determine secrets file path (XDG-style, works on macOS + Linux)
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const secretsFile = path.join(homeDir, '.config', 'nanoclaw', 'secrets.env');
  const envFile = path.join(process.cwd(), '.env');

  // Parse files in priority order: secrets first, then .env
  for (const filePath of [secretsFile, envFile]) {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      if (!wanted.has(key) || result[key]) continue;
      let value = trimmed.slice(eqIdx + 1).trim();
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }
      if (value) result[key] = value;
    }
  }

  // Final fallback: process.env
  for (const key of keys) {
    if (!result[key] && process.env[key]) {
      result[key] = process.env[key];
    }
  }

  return result;
}

/**
 * Named endpoint entry discovered from secrets.env.
 * Vendor name is lowercased (e.g. "anthropic", "ollama", "zai").
 */
export interface EndpointEntry {
  baseUrl: string;
  apiKey: string;
}

/**
 * Scan secrets.env (and .env fallback) for all named endpoint pairs.
 * Convention: {VENDOR}_BASE_URL + {VENDOR}_API_KEY.
 * Returns a map keyed by lowercase vendor name.
 *
 * Does NOT load values into process.env.
 */
export function scanEndpoints(): Record<string, EndpointEntry> {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const secretsFile = path.join(homeDir, '.config', 'nanoclaw', 'secrets.env');
  const envFile = path.join(process.cwd(), '.env');

  // Collect all key=value pairs (secrets.env takes priority)
  const allVars: Record<string, string> = {};

  for (const filePath of [envFile, secretsFile]) {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }
      if (value) allVars[key] = value;
    }
  }

  // Also check process.env for _BASE_URL/_API_KEY pairs
  for (const key of Object.keys(process.env)) {
    if (
      (key.endsWith('_BASE_URL') || key.endsWith('_API_KEY')) &&
      !allVars[key]
    ) {
      if (process.env[key]) allVars[key] = process.env[key]!;
    }
  }

  // Build endpoint map from matched pairs
  const endpoints: Record<string, EndpointEntry> = {};
  for (const key of Object.keys(allVars)) {
    if (!key.endsWith('_BASE_URL')) continue;
    const vendor = key.slice(0, -'_BASE_URL'.length);
    if (!vendor) continue;
    const apiKeyKey = `${vendor}_API_KEY`;
    const baseUrl = allVars[key];
    const apiKey = allVars[apiKeyKey];
    if (baseUrl && apiKey) {
      endpoints[vendor.toLowerCase()] = { baseUrl, apiKey };
    }
  }

  return endpoints;
}
