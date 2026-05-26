/**
 * Prompt-injection scan orchestration helper.
 *
 * Encapsulates the full scan flow previously inline in runAgent():
 * path resolution → scan call → per-finding logging → alert routing →
 * block-mode evaluation → user notification → early return decision.
 *
 * Extracted from index.ts lines 431–510 (BE_04 scan block).
 */

import path from 'path';

import { scanContextFiles, InjectionScanMode } from './context-scanner.js';
import { findChannel, routeOutbound } from '../router.js';
import { getChannelList } from '../group-registry.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { GROUPS_DIR } from '../config.js';
import { logger, log } from '../logger.js';
import { RegisteredGroup } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InjectionScanArgs {
  group: RegisteredGroup;
  chatJid: string;
  scanMode: InjectionScanMode;
  isMain: boolean;
}

export interface InjectionScanOutcome {
  proceed: boolean;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export async function runInjectionScan(
  args: InjectionScanArgs,
): Promise<InjectionScanOutcome> {
  const { group, chatJid, scanMode, isMain } = args;

  if (scanMode === 'off') {
    return { proceed: true };
  }

  const groupFolderPath = resolveGroupFolderPath(group.folder);
  const globalFolderPath = isMain ? undefined : path.join(GROUPS_DIR, 'global');

  const scanResult = scanContextFiles(groupFolderPath, globalFolderPath);

  if (scanResult.clean) {
    return { proceed: true };
  }

  // Log all findings
  for (const f of scanResult.findings) {
    logger.warn(
      {
        group: group.name,
        file: f.file,
        severity: f.severity,
        pattern: f.pattern,
        line: f.line,
      },
      `[INJECTION SCAN] ${f.severity}: ${f.file} — ${f.description} (line ${f.line})`,
    );
  }

  // Send alert to NANOCLAW_ALERT_JID if configured
  const alertJid = process.env.NANOCLAW_ALERT_JID;
  if (alertJid) {
    const channels = getChannelList();
    const alertChannel = findChannel(channels, alertJid);
    if (alertChannel?.isConnected()) {
      for (const f of scanResult.findings) {
        const alertMsg = `🛡️ [INJECTION SCAN] ${f.severity} in ${group.name}/${f.file}: ${f.description} (line ${f.line})`;
        try {
          await routeOutbound(channels, alertJid, alertMsg);
        } catch (alertErr) {
          logger.warn(
            { err: alertErr, jid: alertJid },
            'Failed to send injection scan alert',
          );
        }
      }
    } else {
      logger.warn(
        { jid: alertJid },
        'NANOCLAW_ALERT_JID configured but no channel owns this JID — alert not sent',
      );
    }
  }

  // Block mode: abort on critical findings
  if (scanMode === 'block' && scanResult.hasCritical) {
    const criticals = scanResult.findings.filter(
      (f) => f.severity === 'critical',
    );
    const summary = criticals
      .map((f) => `${f.file}: ${f.description} (line ${f.line})`)
      .join('; ');

    log.error(
      { group: group.name, findings: criticals.length },
      `Injection scan blocked container launch: ${summary}`,
    );

    // Notify the group's chat channel
    const channels = getChannelList();
    const groupChannel = findChannel(channels, chatJid);
    if (groupChannel?.isConnected()) {
      const blockMsg = `⚠️ Blocked: context files contain potential prompt injection. ${criticals.map((f) => `${f.file} — ${f.description}`).join('; ')}. Review the files manually.`;
      try {
        await groupChannel.sendMessage(chatJid, blockMsg);
      } catch {
        // Best-effort notification
      }
    }

    return { proceed: false };
  }

  return { proceed: true };
}
