import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { handleHostCommand } from './host-commands.js';

vi.mock('fs');

const mockSetRegisteredGroup = vi.fn();
vi.mock('./db.js', () => ({
  setRegisteredGroup: (...args: unknown[]) => mockSetRegisteredGroup(...args),
}));

const mockIsSenderAllowed = vi.fn();
const mockLoadSenderAllowlist = vi.fn();
vi.mock('./sender-allowlist.js', () => ({
  isSenderAllowed: (...args: unknown[]) => mockIsSenderAllowed(...args),
  loadSenderAllowlist: () => mockLoadSenderAllowlist(),
}));

vi.mock('./config.js', () => ({
  HOME_DIR: '/mock/home',
  DATA_DIR: '/mock/data',
}));

describe('handleHostCommand', () => {
  const presetsPath = '/mock/home/.config/nanoclaw/model-presets.json';
  let replies: string[] = [];
  let closeStdinCalls: string[] = [];

  beforeEach(() => {
    vi.resetAllMocks();
    replies = [];
    closeStdinCalls = [];
    mockLoadSenderAllowlist.mockReturnValue({
      default: { allow: '*', mode: 'trigger' },
      chats: {},
      logDenied: true,
    });
    mockIsSenderAllowed.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockFiles(files: Record<string, string>) {
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      const filePath = String(p);
      if (files[filePath] !== undefined) return files[filePath];
      throw Object.assign(new Error(`ENOENT: ${filePath}`), { code: 'ENOENT' });
    });
  }

  function makeCtx(
    overrides: {
      allowedHostCommands?: string[];
      containerConfig?: Record<string, unknown>;
      sender?: string;
    } = {},
  ) {
    const base = overrides.containerConfig ?? {};
    return {
      jid: 'tg:123',
      group: {
        name: 'Test',
        folder: 'test',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
        containerConfig: {
          allowedHostCommands: overrides.allowedHostCommands,
          ...base,
        },
      },
      sender: overrides.sender ?? '6013943815',
      reply: async (text: string) => {
        replies.push(text);
      },
    };
  }

  function makeMsg(content: string) {
    return {
      id: '1',
      chat_jid: 'tg:123',
      sender: '6013943815',
      sender_name: 'Test',
      content,
      timestamp: '2024-01-01T00:00:00.000Z',
    };
  }

  const closeStdin = (jid: string) => {
    closeStdinCalls.push(jid);
  };

  it('returns false for messages not starting with /', async () => {
    const result = await handleHostCommand(
      makeMsg('hello'),
      makeCtx({ allowedHostCommands: ['model'] }),
      closeStdin,
    );
    expect(result).toBe(false);
    expect(replies).toEqual([]);
  });

  it('returns false when command is not in allowedHostCommands', async () => {
    const result = await handleHostCommand(
      makeMsg('/hi'),
      makeCtx({ allowedHostCommands: ['model'] }),
      closeStdin,
    );
    expect(result).toBe(false);
    expect(replies).toEqual([]);
  });

  it('returns false when allowedHostCommands is undefined', async () => {
    const result = await handleHostCommand(
      makeMsg('/model'),
      makeCtx({ allowedHostCommands: undefined }),
      closeStdin,
    );
    expect(result).toBe(false);
    expect(replies).toEqual([]);
  });

  it('returns false when allowedHostCommands is empty', async () => {
    const result = await handleHostCommand(
      makeMsg('/model'),
      makeCtx({ allowedHostCommands: [] }),
      closeStdin,
    );
    expect(result).toBe(false);
    expect(replies).toEqual([]);
  });

  it('replies "Not authorised." for denied sender and consumes message', async () => {
    mockIsSenderAllowed.mockReturnValue(false);
    mockFiles({
      [presetsPath]: JSON.stringify({
        'ollama_k2.6': { endpoint: 'ollama', model: 'kimi-k2.6:cloud' },
      }),
    });
    const result = await handleHostCommand(
      makeMsg('/model'),
      makeCtx({ allowedHostCommands: ['model'] }),
      closeStdin,
    );
    expect(result).toBe(true);
    expect(replies).toEqual(['Not authorised.']);
  });

  it('/model with no presets replies "No profiles configured."', async () => {
    mockFiles({});
    const result = await handleHostCommand(
      makeMsg('/model'),
      makeCtx({ allowedHostCommands: ['model'] }),
      closeStdin,
    );
    expect(result).toBe(true);
    expect(replies).toEqual(['No profiles configured.']);
  });

  it('/model lists active preset and available choices', async () => {
    mockFiles({
      [presetsPath]: JSON.stringify({
        'ollama_k2.6': { endpoint: 'ollama', model: 'kimi-k2.6:cloud' },
        'opus_4.7': { endpoint: 'anthropic', model: 'claude-opus-4-7' },
      }),
    });
    const ctx = makeCtx({
      allowedHostCommands: ['model'],
      containerConfig: { endpoint: 'ollama', model: 'kimi-k2.6:cloud' },
    });
    const result = await handleHostCommand(makeMsg('/model'), ctx, closeStdin);
    expect(result).toBe(true);
    expect(replies.length).toBe(1);
    expect(replies[0]).toContain('Active: `ollama_k2.6`');
    expect(replies[0]).toContain('`ollama_k2.6`');
    expect(replies[0]).toContain('`opus_4.7`');
  });

  it('/model with custom endpoint/model shows raw values when no preset match', async () => {
    mockFiles({
      [presetsPath]: JSON.stringify({
        'opus_4.7': { endpoint: 'anthropic', model: 'claude-opus-4-7' },
      }),
    });
    const ctx = makeCtx({
      allowedHostCommands: ['model'],
      containerConfig: { endpoint: 'ollama', model: 'custom-model' },
    });
    const result = await handleHostCommand(makeMsg('/model'), ctx, closeStdin);
    expect(result).toBe(true);
    expect(replies[0]).toContain('Active: ollama / custom-model');
  });

  it('/model <preset> updates DB and in-memory cache', async () => {
    mockFiles({
      [presetsPath]: JSON.stringify({
        'opus_4.7': { endpoint: 'anthropic', model: 'claude-opus-4-7' },
      }),
    });
    const group = {
      name: 'Test',
      folder: 'test',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      containerConfig: {
        allowedHostCommands: ['model'],
        endpoint: 'ollama',
        model: 'kimi-k2.6:cloud',
        skills: ['x'],
      },
    };
    const ctx = {
      jid: 'tg:123',
      group,
      sender: '6013943815',
      reply: async (text: string) => {
        replies.push(text);
      },
    };
    const result = await handleHostCommand(
      makeMsg('/model opus_4.7'),
      ctx,
      closeStdin,
    );
    expect(result).toBe(true);
    expect(mockSetRegisteredGroup).toHaveBeenCalledWith(
      'tg:123',
      expect.objectContaining({
        containerConfig: expect.objectContaining({
          model: 'claude-opus-4-7',
          endpoint: 'anthropic',
          skills: ['x'],
        }),
      }),
    );
    expect(group.containerConfig).toEqual({
      allowedHostCommands: ['model'],
      endpoint: 'anthropic',
      model: 'claude-opus-4-7',
      skills: ['x'],
    });
    expect(replies[0]).toContain('Switched to `opus_4.7`');
  });

  it('/model <preset> recycles active container', async () => {
    mockFiles({
      [presetsPath]: JSON.stringify({
        'opus_4.7': { endpoint: 'anthropic', model: 'claude-opus-4-7' },
      }),
    });
    const ctx = makeCtx({
      allowedHostCommands: ['model'],
      containerConfig: { endpoint: 'ollama', model: 'kimi-k2.6:cloud' },
    });
    await handleHostCommand(makeMsg('/model opus_4.7'), ctx, closeStdin);
    expect(closeStdinCalls).toEqual(['tg:123']);
  });

  it('/model <preset> updates settings.json with new model', async () => {
    const settingsPath = '/mock/data/sessions/test/.claude/settings.json';
    mockFiles({
      [presetsPath]: JSON.stringify({
        'opus_4.7': { endpoint: 'anthropic', model: 'claude-opus-4-7' },
      }),
      [settingsPath]: JSON.stringify({
        env: {
          ANTHROPIC_MODEL: 'kimi-k2.6:cloud',
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
        },
      }),
    });
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const ctx = makeCtx({
      allowedHostCommands: ['model'],
      containerConfig: { endpoint: 'ollama', model: 'kimi-k2.6:cloud' },
    });
    await handleHostCommand(makeMsg('/model opus_4.7'), ctx, closeStdin);

    const writeCall = vi.mocked(fs.writeFileSync).mock.calls.find(
      (call) => call[0] === settingsPath,
    );
    expect(writeCall).toBeDefined();
    const written = JSON.parse(writeCall![1] as string);
    expect(written.env.ANTHROPIC_MODEL).toBe('claude-opus-4-7');
    expect(written.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('0');
  });

  it('/model <preset> creates settings.json if missing', async () => {
    const settingsPath = '/mock/data/sessions/test/.claude/settings.json';
    mockFiles({
      [presetsPath]: JSON.stringify({
        'opus_4.7': { endpoint: 'anthropic', model: 'claude-opus-4-7' },
      }),
    });
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => {
      return String(p) !== settingsPath;
    });
    const ctx = makeCtx({
      allowedHostCommands: ['model'],
      containerConfig: { endpoint: 'ollama', model: 'kimi-k2.6:cloud' },
    });
    await handleHostCommand(makeMsg('/model opus_4.7'), ctx, closeStdin);

    const writeCall = vi.mocked(fs.writeFileSync).mock.calls.find(
      (call) => call[0] === settingsPath,
    );
    expect(writeCall).toBeDefined();
    const written = JSON.parse(writeCall![1] as string);
    expect(written.env.ANTHROPIC_MODEL).toBe('claude-opus-4-7');
  });

  it('/model unknown_preset replies with rejection', async () => {
    mockFiles({
      [presetsPath]: JSON.stringify({
        'opus_4.7': { endpoint: 'anthropic', model: 'claude-opus-4-7' },
      }),
    });
    const ctx = makeCtx({ allowedHostCommands: ['model'] });
    const result = await handleHostCommand(
      makeMsg('/model unknown'),
      ctx,
      closeStdin,
    );
    expect(result).toBe(true);
    expect(replies[0]).toContain('Unknown preset');
    expect(mockSetRegisteredGroup).not.toHaveBeenCalled();
    expect(closeStdinCalls).toEqual([]);
  });

  it('falls through for /hi when only model is allowed', async () => {
    mockFiles({
      [presetsPath]: JSON.stringify({}),
    });
    const result = await handleHostCommand(
      makeMsg('/hi'),
      makeCtx({ allowedHostCommands: ['model'] }),
      closeStdin,
    );
    expect(result).toBe(false);
    expect(replies).toEqual([]);
  });

  it('falls through for /model when group has no allowedHostCommands', async () => {
    mockFiles({
      [presetsPath]: JSON.stringify({
        'opus_4.7': { endpoint: 'anthropic', model: 'claude-opus-4-7' },
      }),
    });
    const result = await handleHostCommand(
      makeMsg('/model'),
      makeCtx({ allowedHostCommands: undefined }),
      closeStdin,
    );
    expect(result).toBe(false);
    expect(replies).toEqual([]);
  });
});
