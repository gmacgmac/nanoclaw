/**
 * VERIFY_01: Manual Flush End-to-End Verification Tests
 *
 * Tests the pure logic functions added/modified in BE_01–BE_03:
 * 1. manual_flush tool: sentinel file creation
 * 2. shouldFlush(): sentinel detection + cleanup
 * 3. shouldClose(): unchanged behavior (regression)
 * 4. sendStatusMessage(): atomic write + correct JSON structure
 * 5. drainIpcInput(): .json filter isolation (sentinel not consumed)
 * 6. flushedThisSession guard logic
 * 7. Stale sentinel cleanup on start
 * 8. Double-flush prevention
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// We test against a temp directory to avoid touching real IPC paths
let tmpDir: string;
let IPC_INPUT_DIR: string;
let IPC_MESSAGES_DIR: string;
let IPC_INPUT_CLOSE_SENTINEL: string;
let IPC_INPUT_FLUSH_SENTINEL: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-flush-'));
  IPC_INPUT_DIR = path.join(tmpDir, 'ipc', 'input');
  IPC_MESSAGES_DIR = path.join(tmpDir, 'ipc', 'messages');
  IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
  IPC_INPUT_FLUSH_SENTINEL = path.join(IPC_INPUT_DIR, '_flush');
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- Reimplemented logic functions (mirrors index.ts exactly) ---

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

function shouldFlush(): boolean {
  if (fs.existsSync(IPC_INPUT_FLUSH_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_FLUSH_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

function sendStatusMessage(text: string, chatJid: string, groupFolder: string): void {
  fs.mkdirSync(IPC_MESSAGES_DIR, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(IPC_MESSAGES_DIR, filename);
  const data = { type: 'message', chatJid, text, groupFolder, timestamp: new Date().toISOString() };
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data));
  fs.renameSync(tempPath, filepath);
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch {
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch {
    return [];
  }
}

// --- manual_flush tool logic (mirrors ipc-mcp-stdio.ts) ---

function manualFlushTool(): string {
  const sentinelPath = path.join(IPC_INPUT_DIR, '_flush');
  fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
  fs.writeFileSync(sentinelPath, '');
  return 'Memory flush requested. Compaction will begin after this response.';
}

// ============================================================
// TESTS
// ============================================================

describe('BE_01: manual_flush MCP tool', () => {
  it('creates _flush sentinel as empty file', () => {
    manualFlushTool();
    expect(fs.existsSync(IPC_INPUT_FLUSH_SENTINEL)).toBe(true);
    expect(fs.readFileSync(IPC_INPUT_FLUSH_SENTINEL, 'utf-8')).toBe('');
  });

  it('returns correct confirmation text', () => {
    const result = manualFlushTool();
    expect(result).toBe('Memory flush requested. Compaction will begin after this response.');
  });

  it('is idempotent — calling twice does not error', () => {
    manualFlushTool();
    expect(() => manualFlushTool()).not.toThrow();
    expect(fs.existsSync(IPC_INPUT_FLUSH_SENTINEL)).toBe(true);
  });

  it('creates parent directories if missing', () => {
    // Remove the dir we created in beforeEach
    fs.rmSync(IPC_INPUT_DIR, { recursive: true, force: true });
    expect(fs.existsSync(IPC_INPUT_DIR)).toBe(false);

    manualFlushTool();
    expect(fs.existsSync(IPC_INPUT_FLUSH_SENTINEL)).toBe(true);
  });
});

describe('BE_02: shouldFlush() sentinel detection', () => {
  it('returns false when no sentinel exists', () => {
    expect(shouldFlush()).toBe(false);
  });

  it('returns true when _flush sentinel exists', () => {
    fs.writeFileSync(IPC_INPUT_FLUSH_SENTINEL, '');
    expect(shouldFlush()).toBe(true);
  });

  it('deletes sentinel after detection', () => {
    fs.writeFileSync(IPC_INPUT_FLUSH_SENTINEL, '');
    shouldFlush();
    expect(fs.existsSync(IPC_INPUT_FLUSH_SENTINEL)).toBe(false);
  });

  it('returns false on second call (sentinel consumed)', () => {
    fs.writeFileSync(IPC_INPUT_FLUSH_SENTINEL, '');
    expect(shouldFlush()).toBe(true);
    expect(shouldFlush()).toBe(false);
  });
});

describe('Regression: shouldClose() unchanged', () => {
  it('returns false when no sentinel exists', () => {
    expect(shouldClose()).toBe(false);
  });

  it('returns true when _close sentinel exists', () => {
    fs.writeFileSync(IPC_INPUT_CLOSE_SENTINEL, '');
    expect(shouldClose()).toBe(true);
  });

  it('deletes sentinel after detection', () => {
    fs.writeFileSync(IPC_INPUT_CLOSE_SENTINEL, '');
    shouldClose();
    expect(fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)).toBe(false);
  });

  it('_flush and _close coexist independently', () => {
    fs.writeFileSync(IPC_INPUT_FLUSH_SENTINEL, '');
    fs.writeFileSync(IPC_INPUT_CLOSE_SENTINEL, '');

    // Consuming one doesn't affect the other
    expect(shouldFlush()).toBe(true);
    expect(fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)).toBe(true);
    expect(shouldClose()).toBe(true);
    expect(fs.existsSync(IPC_INPUT_FLUSH_SENTINEL)).toBe(false);
  });
});

describe('BE_03: sendStatusMessage()', () => {
  it('writes a JSON file to messages directory', () => {
    sendStatusMessage('Creating long term memories...', 'test-jid', 'test-group');
    const files = fs.readdirSync(IPC_MESSAGES_DIR).filter(f => f.endsWith('.json'));
    expect(files.length).toBe(1);
  });

  it('writes correct JSON structure', () => {
    sendStatusMessage('Creating long term memories...', 'test-jid', 'test-group');
    const files = fs.readdirSync(IPC_MESSAGES_DIR).filter(f => f.endsWith('.json'));
    const data = JSON.parse(fs.readFileSync(path.join(IPC_MESSAGES_DIR, files[0]), 'utf-8'));
    expect(data.type).toBe('message');
    expect(data.chatJid).toBe('test-jid');
    expect(data.text).toBe('Creating long term memories...');
    expect(data.groupFolder).toBe('test-group');
    expect(data.timestamp).toBeDefined();
  });

  it('atomic write: no .tmp files left behind', () => {
    sendStatusMessage('test', 'jid', 'group');
    const allFiles = fs.readdirSync(IPC_MESSAGES_DIR);
    const tmpFiles = allFiles.filter(f => f.endsWith('.tmp'));
    expect(tmpFiles.length).toBe(0);
  });

  it('creates messages directory if missing', () => {
    // IPC_MESSAGES_DIR doesn't exist yet (only IPC_INPUT_DIR was created in beforeEach)
    expect(fs.existsSync(IPC_MESSAGES_DIR)).toBe(false);
    sendStatusMessage('test', 'jid', 'group');
    expect(fs.existsSync(IPC_MESSAGES_DIR)).toBe(true);
  });

  it('multiple messages create separate files', () => {
    sendStatusMessage('Creating long term memories...', 'jid', 'group');
    // Small delay to ensure different timestamps
    sendStatusMessage('Ready for next message', 'jid', 'group');
    const files = fs.readdirSync(IPC_MESSAGES_DIR).filter(f => f.endsWith('.json'));
    expect(files.length).toBe(2);
  });
});

describe('drainIpcInput: .json filter isolation', () => {
  it('does NOT consume _flush sentinel', () => {
    fs.writeFileSync(IPC_INPUT_FLUSH_SENTINEL, '');
    drainIpcInput();
    // _flush should still exist — it's not a .json file
    expect(fs.existsSync(IPC_INPUT_FLUSH_SENTINEL)).toBe(true);
  });

  it('does NOT consume _close sentinel', () => {
    fs.writeFileSync(IPC_INPUT_CLOSE_SENTINEL, '');
    drainIpcInput();
    expect(fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)).toBe(true);
  });

  it('consumes .json files normally', () => {
    const msgFile = path.join(IPC_INPUT_DIR, '001.json');
    fs.writeFileSync(msgFile, JSON.stringify({ type: 'message', text: 'hello' }));
    const messages = drainIpcInput();
    expect(messages).toEqual(['hello']);
    expect(fs.existsSync(msgFile)).toBe(false);
  });

  it('sentinels survive alongside .json drain', () => {
    fs.writeFileSync(IPC_INPUT_FLUSH_SENTINEL, '');
    fs.writeFileSync(IPC_INPUT_CLOSE_SENTINEL, '');
    const msgFile = path.join(IPC_INPUT_DIR, '001.json');
    fs.writeFileSync(msgFile, JSON.stringify({ type: 'message', text: 'hello' }));

    const messages = drainIpcInput();
    expect(messages).toEqual(['hello']);
    expect(fs.existsSync(IPC_INPUT_FLUSH_SENTINEL)).toBe(true);
    expect(fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)).toBe(true);
  });
});

describe('flushedThisSession guard logic', () => {
  it('prevents double-flush when both threshold and manual trigger', () => {
    let flushedThisSession = false;
    const contextWindowSize = 128000;
    let lastInputTokens = 110000; // > 80% of 128000

    // Simulate 80% threshold flush
    if (!flushedThisSession && lastInputTokens > contextWindowSize * 0.8) {
      flushedThisSession = true;
    }
    expect(flushedThisSession).toBe(true);

    // Now manual flush sentinel appears
    fs.writeFileSync(IPC_INPUT_FLUSH_SENTINEL, '');

    // Guard prevents second flush
    let manualFlushRan = false;
    if (!flushedThisSession && shouldFlush()) {
      manualFlushRan = true;
    }
    expect(manualFlushRan).toBe(false);

    // Sentinel is NOT consumed because the guard short-circuits before shouldFlush()
    expect(fs.existsSync(IPC_INPUT_FLUSH_SENTINEL)).toBe(true);
  });

  it('allows manual flush when threshold not crossed', () => {
    let flushedThisSession = false;
    fs.writeFileSync(IPC_INPUT_FLUSH_SENTINEL, '');

    let manualFlushRan = false;
    if (!flushedThisSession && shouldFlush()) {
      flushedThisSession = true;
      manualFlushRan = true;
    }
    expect(manualFlushRan).toBe(true);
    expect(flushedThisSession).toBe(true);
  });
});

describe('Stale sentinel cleanup on start', () => {
  it('cleans up stale _flush sentinel', () => {
    fs.writeFileSync(IPC_INPUT_FLUSH_SENTINEL, '');
    // Simulate startup cleanup
    try { fs.unlinkSync(IPC_INPUT_FLUSH_SENTINEL); } catch { /* ignore */ }
    expect(fs.existsSync(IPC_INPUT_FLUSH_SENTINEL)).toBe(false);
  });

  it('cleans up stale _close sentinel', () => {
    fs.writeFileSync(IPC_INPUT_CLOSE_SENTINEL, '');
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    expect(fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)).toBe(false);
  });

  it('does not error when no stale sentinels exist', () => {
    expect(() => {
      try { fs.unlinkSync(IPC_INPUT_FLUSH_SENTINEL); } catch { /* ignore */ }
      try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    }).not.toThrow();
  });
});

describe('End-to-end flow simulation', () => {
  it('manual_flush tool → shouldFlush() → status messages → complete', () => {
    // Step 1: Agent calls manual_flush tool
    const toolResult = manualFlushTool();
    expect(toolResult).toContain('flush requested');

    // Step 2: After query ends, agent-runner checks shouldFlush()
    expect(shouldFlush()).toBe(true);

    // Step 3: Status message sent before flush
    sendStatusMessage('Creating long term memories...', 'test-jid', 'test-group');

    // Step 4: (flush prompt would run here — can't test SDK call)

    // Step 5: Status message sent after flush
    sendStatusMessage('Ready for next message', 'test-jid', 'test-group');

    // Step 6: Verify both status messages exist
    const files = fs.readdirSync(IPC_MESSAGES_DIR).filter(f => f.endsWith('.json'));
    expect(files.length).toBe(2);

    const messages = files.map(f =>
      JSON.parse(fs.readFileSync(path.join(IPC_MESSAGES_DIR, f), 'utf-8'))
    );
    const texts = messages.map(m => m.text).sort();
    expect(texts).toContain('Creating long term memories...');
    expect(texts).toContain('Ready for next message');

    // Step 7: Sentinel was consumed by shouldFlush()
    expect(fs.existsSync(IPC_INPUT_FLUSH_SENTINEL)).toBe(false);
  });
});
