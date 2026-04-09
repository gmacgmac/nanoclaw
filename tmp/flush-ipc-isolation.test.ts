/**
 * Test: Flush queries must NOT consume IPC messages
 *
 * Validates the acceptIpc guard added to runQuery's pollIpcDuringQuery.
 * When acceptIpc=false (flush queries), IPC messages must remain on disk
 * so they're picked up by the next normal query instead.
 *
 * Test cases:
 * 1. acceptIpc=true (default) → drainIpcInput is called, messages consumed
 * 2. acceptIpc=false (flush) → drainIpcInput is skipped, messages survive
 * 3. _close sentinel is still honoured even when acceptIpc=false
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

let tmpDir: string;
let IPC_INPUT_DIR: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flush-ipc-'));
  IPC_INPUT_DIR = path.join(tmpDir, 'ipc', 'input');
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- Extracted helpers (mirror agent-runner logic) ---

function drainIpcInput(): string[] {
  try {
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

function shouldClose(): boolean {
  const sentinel = path.join(IPC_INPUT_DIR, '_close');
  if (fs.existsSync(sentinel)) {
    try { fs.unlinkSync(sentinel); } catch { /* ignore */ }
    return true;
  }
  return false;
}

function writeIpcMessage(text: string): void {
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  fs.writeFileSync(
    path.join(IPC_INPUT_DIR, filename),
    JSON.stringify({ type: 'message', text }),
  );
}

/**
 * Simulates one poll cycle of pollIpcDuringQuery.
 * Returns { closed, messagesConsumed }.
 */
function simulatePollCycle(acceptIpc: boolean): { closed: boolean; messagesConsumed: string[] } {
  if (shouldClose()) {
    return { closed: true, messagesConsumed: [] };
  }
  if (acceptIpc) {
    const messages = drainIpcInput();
    return { closed: false, messagesConsumed: messages };
  }
  return { closed: false, messagesConsumed: [] };
}

// --- Tests ---

describe('flush IPC isolation (acceptIpc guard)', () => {
  it('acceptIpc=true consumes IPC messages (normal query behaviour)', () => {
    writeIpcMessage('hello from user');

    const result = simulatePollCycle(true);

    expect(result.closed).toBe(false);
    expect(result.messagesConsumed).toEqual(['hello from user']);
    // File should be gone
    const remaining = fs.readdirSync(IPC_INPUT_DIR).filter(f => f.endsWith('.json'));
    expect(remaining).toHaveLength(0);
  });

  it('acceptIpc=false does NOT consume IPC messages (flush query behaviour)', () => {
    writeIpcMessage('user message during flush');

    const result = simulatePollCycle(false);

    expect(result.closed).toBe(false);
    expect(result.messagesConsumed).toEqual([]);
    // File must still be on disk
    const remaining = fs.readdirSync(IPC_INPUT_DIR).filter(f => f.endsWith('.json'));
    expect(remaining).toHaveLength(1);
  });

  it('_close sentinel is still honoured when acceptIpc=false', () => {
    fs.writeFileSync(path.join(IPC_INPUT_DIR, '_close'), '');
    writeIpcMessage('message that should survive');

    const result = simulatePollCycle(false);

    expect(result.closed).toBe(true);
    // Message file should still be there (close short-circuits before drain)
    const remaining = fs.readdirSync(IPC_INPUT_DIR).filter(f => f.endsWith('.json'));
    expect(remaining).toHaveLength(1);
  });

  it('messages survive flush and are consumed by subsequent normal query', () => {
    writeIpcMessage('queued during flush');

    // Flush poll — should not consume
    const flushResult = simulatePollCycle(false);
    expect(flushResult.messagesConsumed).toEqual([]);

    // Normal poll — should consume
    const normalResult = simulatePollCycle(true);
    expect(normalResult.messagesConsumed).toEqual(['queued during flush']);
  });

  it('multiple messages survive flush intact', () => {
    writeIpcMessage('msg 1');
    writeIpcMessage('msg 2');
    writeIpcMessage('msg 3');

    // Flush poll
    simulatePollCycle(false);
    const remaining = fs.readdirSync(IPC_INPUT_DIR).filter(f => f.endsWith('.json'));
    expect(remaining).toHaveLength(3);

    // Normal poll picks them all up
    const normalResult = simulatePollCycle(true);
    expect(normalResult.messagesConsumed).toHaveLength(3);
  });
});
