import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { sanitizeSessionJsonl } from './session-sanitizer.js';

vi.mock('fs');

const mockGetSession = vi.fn();
vi.mock('./db.js', () => ({
  getSession: (folder: string) => mockGetSession(folder),
}));

vi.mock('./config.js', () => ({
  DATA_DIR: '/mock/data',
}));

vi.mock('./logger.js', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

describe('sanitizeSessionJsonl', () => {
  const sessionPath =
    '/mock/data/sessions/test-group/.claude/projects/-workspace-group/sess-123.jsonl';

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockFile(content: string) {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(content);
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    vi.mocked(fs.renameSync).mockImplementation(() => {});
  }

  it('returns silently when no session exists', () => {
    mockGetSession.mockReturnValue(undefined);
    expect(() => sanitizeSessionJsonl('test-group')).not.toThrow();
    expect(fs.existsSync).not.toHaveBeenCalled();
  });

  it('returns silently when JSONL file does not exist', () => {
    mockGetSession.mockReturnValue('sess-123');
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(() => sanitizeSessionJsonl('test-group')).not.toThrow();
    expect(fs.existsSync).toHaveBeenCalledWith(sessionPath);
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  it('sanitizes non-compliant tool_use ids', () => {
    mockGetSession.mockReturnValue('sess-123');
    mockFile(
      JSON.stringify({
        message: {
          content: [{ type: 'tool_use', id: 'functions.Bash:1', name: 'Bash' }],
        },
      }) + '\n',
    );

    sanitizeSessionJsonl('test-group');

    const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    const lines = written.trim().split('\n');
    const entry = JSON.parse(lines[0]);
    expect(entry.message.content[0].id).toBe('functions-Bash-1');
  });

  it('aligns tool_result.tool_use_id with sanitized tool_use.id', () => {
    mockGetSession.mockReturnValue('sess-123');
    mockFile(
      [
        JSON.stringify({
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'functions.mcp__nanoclaw__send_message:0',
                name: 'mcp__nanoclaw__send_message',
              },
            ],
          },
        }),
        JSON.stringify({
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'functions.mcp__nanoclaw__send_message:0',
                content: [{ type: 'text', text: 'ok' }],
              },
            ],
          },
        }),
      ].join('\n') + '\n',
    );

    sanitizeSessionJsonl('test-group');

    const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    const lines = written.trim().split('\n');
    const toolUse = JSON.parse(lines[0]);
    const toolResult = JSON.parse(lines[1]);

    const sanitizedId = toolUse.message.content[0].id;
    expect(sanitizedId).toBe('functions-mcp--nanoclaw--send-message-0');
    expect(toolResult.message.content[0].tool_use_id).toBe(sanitizedId);
  });

  it('handles id collisions by appending counter', () => {
    mockGetSession.mockReturnValue('sess-123');
    mockFile(
      [
        JSON.stringify({
          message: {
            content: [
              { type: 'tool_use', id: 'a.b', name: 'x' },
              { type: 'tool_use', id: 'a:b', name: 'y' },
            ],
          },
        }),
      ].join('\n') + '\n',
    );

    sanitizeSessionJsonl('test-group');

    const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    const entry = JSON.parse(written.trim().split('\n')[0]);
    const ids = entry.message.content.map((b: { id: string }) => b.id);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[0]).toMatch(/^a-b(-\d+)?$/);
    expect(ids[1]).toMatch(/^a-b(-\d+)?$/);
  });

  it('leaves compliant ids untouched', () => {
    mockGetSession.mockReturnValue('sess-123');
    mockFile(
      JSON.stringify({
        message: {
          content: [{ type: 'tool_use', id: 'abc-123-XYZ', name: 'Bash' }],
        },
      }) + '\n',
    );

    sanitizeSessionJsonl('test-group');

    const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    const entry = JSON.parse(written.trim().split('\n')[0]);
    expect(entry.message.content[0].id).toBe('abc-123-XYZ');
  });

  it('sanitizes orphan tool_result ids in place', () => {
    mockGetSession.mockReturnValue('sess-123');
    mockFile(
      JSON.stringify({
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'orphan.id:here',
              content: [{ type: 'text', text: 'ok' }],
            },
          ],
        },
      }) + '\n',
    );

    sanitizeSessionJsonl('test-group');

    const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    const entry = JSON.parse(written.trim().split('\n')[0]);
    expect(entry.message.content[0].tool_use_id).toBe('orphan-id-here');
  });

  it('skips lines that are not parseable JSON', () => {
    mockGetSession.mockReturnValue('sess-123');
    mockFile(
      [
        JSON.stringify({
          message: {
            content: [{ type: 'tool_use', id: 'a.b', name: 'x' }],
          },
        }),
        'not-json-at-all',
      ].join('\n') + '\n',
    );

    sanitizeSessionJsonl('test-group');

    const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    const lines = written.trim().split('\n');
    // First line sanitized, second line preserved as-is
    expect(lines.length).toBe(2);
    const entry = JSON.parse(lines[0]);
    expect(entry.message.content[0].id).toBe('a-b');
    expect(lines[1]).toBe('not-json-at-all');
  });

  it('writes atomically (temp file then rename)', () => {
    mockGetSession.mockReturnValue('sess-123');
    mockFile(
      JSON.stringify({
        message: {
          content: [{ type: 'tool_use', id: 'a.b', name: 'x' }],
        },
      }) + '\n',
    );

    sanitizeSessionJsonl('test-group');

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      `${sessionPath}.sanitize`,
      expect.any(String),
    );
    expect(fs.renameSync).toHaveBeenCalledWith(
      `${sessionPath}.sanitize`,
      sessionPath,
    );
  });

  it('does nothing when no tool_use blocks exist', () => {
    mockGetSession.mockReturnValue('sess-123');
    mockFile(
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
      }) + '\n',
    );

    sanitizeSessionJsonl('test-group');

    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(fs.renameSync).not.toHaveBeenCalled();
  });

  it('strips thinking and redacted_thinking blocks', () => {
    mockGetSession.mockReturnValue('sess-123');
    mockFile(
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'thinking', thinking: 'reasoning', signature: 'abc123' },
            { type: 'redacted_thinking', data: 'secret' },
          ],
        },
      }) + '\n',
    );

    sanitizeSessionJsonl('test-group');

    const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    const entry = JSON.parse(written.trim().split('\n')[0]);
    expect(entry.message.content).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('writes file when only thinking blocks exist (no tool blocks)', () => {
    mockGetSession.mockReturnValue('sess-123');
    mockFile(
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'x' }],
        },
      }) + '\n',
    );

    sanitizeSessionJsonl('test-group');

    expect(fs.writeFileSync).toHaveBeenCalled();
    expect(fs.renameSync).toHaveBeenCalled();
  });
});
