/**
 * BE_09 — containerConfig Validation
 *
 * Runtime validation for containerConfig fields. Invalid values log a warning
 * and fall back to secure defaults. All fields are optional — absent fields
 * preserve backward-compatible behavior.
 */

import type { ContainerConfig } from '../types.js';

export interface ValidationWarning {
  field: string;
  message: string;
  fallback: unknown;
}

export interface ValidationResult {
  config: ContainerConfig;
  warnings: ValidationWarning[];
}

const VALID_INJECTION_MODES = ['off', 'warn', 'block'] as const;

/**
 * Validate and normalise a containerConfig object.
 * Returns a cleaned config with invalid values replaced by defaults,
 * plus a list of warnings for anything that was corrected.
 */
export function validateContainerConfig(
  raw: ContainerConfig | undefined,
): ValidationResult {
  if (!raw) return { config: {}, warnings: [] };

  const warnings: ValidationWarning[] = [];
  const config = { ...raw };

  // --- injectionScanMode ---
  if (
    config.injectionScanMode !== undefined &&
    !VALID_INJECTION_MODES.includes(
      config.injectionScanMode as (typeof VALID_INJECTION_MODES)[number],
    )
  ) {
    warnings.push({
      field: 'injectionScanMode',
      message: `Invalid value "${config.injectionScanMode}", must be one of: ${VALID_INJECTION_MODES.join(', ')}`,
      fallback: 'warn',
    });
    config.injectionScanMode = 'warn';
  }

  // --- approvalMode ---
  if (
    config.approvalMode !== undefined &&
    typeof config.approvalMode !== 'boolean'
  ) {
    warnings.push({
      field: 'approvalMode',
      message: `Invalid value "${config.approvalMode}", must be boolean`,
      fallback: false,
    });
    config.approvalMode = false;
  }

  // --- approvalTimeout ---
  if (config.approvalTimeout !== undefined) {
    if (
      typeof config.approvalTimeout !== 'number' ||
      !Number.isFinite(config.approvalTimeout) ||
      config.approvalTimeout < 10 ||
      config.approvalTimeout > 600
    ) {
      warnings.push({
        field: 'approvalTimeout',
        message: `Invalid value "${config.approvalTimeout}", must be a number between 10 and 600`,
        fallback: 120,
      });
      config.approvalTimeout = 120;
    }
  }

  // --- commandAllowlist ---
  if (config.commandAllowlist !== undefined) {
    if (!Array.isArray(config.commandAllowlist)) {
      warnings.push({
        field: 'commandAllowlist',
        message: 'Must be an array of regex strings',
        fallback: [],
      });
      config.commandAllowlist = [];
    } else {
      // Validate each pattern is a valid regex
      const validPatterns: string[] = [];
      for (const pattern of config.commandAllowlist) {
        if (typeof pattern !== 'string') {
          warnings.push({
            field: 'commandAllowlist',
            message: `Non-string entry skipped: ${JSON.stringify(pattern)}`,
            fallback: '(skipped)',
          });
          continue;
        }
        try {
          new RegExp(pattern);
          validPatterns.push(pattern);
        } catch {
          warnings.push({
            field: 'commandAllowlist',
            message: `Invalid regex "${pattern}" skipped`,
            fallback: '(skipped)',
          });
        }
      }
      config.commandAllowlist = validPatterns;
    }
  }

  // --- learningLoop ---
  if (
    config.learningLoop !== undefined &&
    config.learningLoop !== true &&
    config.learningLoop !== false &&
    config.learningLoop !== 'extract-only'
  ) {
    warnings.push({
      field: 'learningLoop',
      message: `Invalid value "${config.learningLoop}", must be boolean or 'extract-only'`,
      fallback: false,
    });
    config.learningLoop = false;
  }

  // --- ssrfProtection ---
  if (config.ssrfProtection !== undefined) {
    if (typeof config.ssrfProtection === 'boolean') {
      // Valid
    } else if (
      typeof config.ssrfProtection === 'object' &&
      config.ssrfProtection !== null
    ) {
      // Validate SsrfConfig shape — allowPrivateNetworks must be boolean if present
      if (
        'allowPrivateNetworks' in config.ssrfProtection &&
        typeof config.ssrfProtection.allowPrivateNetworks !== 'boolean'
      ) {
        warnings.push({
          field: 'ssrfProtection.allowPrivateNetworks',
          message: 'Must be boolean, falling back to enabled with defaults',
          fallback: true,
        });
        config.ssrfProtection = true;
      }
    } else {
      warnings.push({
        field: 'ssrfProtection',
        message: `Invalid value "${config.ssrfProtection}", must be boolean or SsrfConfig object`,
        fallback: true,
      });
      config.ssrfProtection = true;
    }
  }

  return { config, warnings };
}
