import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleHostCommand } from './host-commands.js';

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

const mockResolvePreset = vi.fn();
const mockGetAvailablePresetNames = vi.fn();
vi.mock('./presets.js', () => ({
  resolvePreset: (...args: unknown[]) => mockResolvePreset(...args),
  getAvailablePresetNames: () => mockGetAvailablePresetNames(),
}));

const mockSanitizeSessionJsonl = vi.fn();
vi.mock('./session-sanitizer.js', () => ({
  sanitizeSessionJsonl: (...args: unknown[]) =>
    mockSanitizeSessionJsonl(...args),
}));

vi.mock('./config.js', () => ({
  HOME_DIR: '/mock/home',
  DATA_DIR: '/mock/data',
}));

const mockImageExists = vi.fn();
const mockResolveImageTag = vi.fn();
vi.mock('./container-runtime.js', () => ({
  imageExists: (...args: unknown[]) => mockImageExists(...args),
  resolveImageTag: (...args: unknown[]) => mockResolveImageTag(...args),
  CONTAINER_RUNTIME_BIN: 'docker',
}));

// Mock fs and child_process for VERSIONS.json reading and docker inspect
const mockReadFileSync = vi.fn();
const mockExecSync = vi.fn();
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    },
  };
});
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execSync: (...args: unknown[]) => mockExecSync(...args),
  };
});

describe('handleHostCommand', () => {
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
    mockGetAvailablePresetNames.mockReturnValue([]);
    mockResolvePreset.mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

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
      sender: overrides.sender ?? '123456789',
      reply: async (text: string) => {
        replies.push(text);
      },
    };
  }

  function makeMsg(content: string) {
    return {
      id: '1',
      chat_jid: 'tg:123',
      sender: '123456789',
      sender_name: 'Test',
      content,
      timestamp: '2024-01-01T00:00:00.000Z',
    };
  }

  const closeStdin = (jid: string): boolean => {
    closeStdinCalls.push(jid);
    return true;
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
    mockGetAvailablePresetNames.mockReturnValue(['ollama_k2.6']);
    const result = await handleHostCommand(
      makeMsg('/model'),
      makeCtx({ allowedHostCommands: ['model'] }),
      closeStdin,
    );
    expect(result).toBe(true);
    expect(replies).toEqual(['Not authorised.']);
  });

  it('/model with no presets replies "No profiles configured."', async () => {
    mockGetAvailablePresetNames.mockReturnValue([]);
    const result = await handleHostCommand(
      makeMsg('/model'),
      makeCtx({ allowedHostCommands: ['model'] }),
      closeStdin,
    );
    expect(result).toBe(true);
    expect(replies).toEqual(['No profiles configured.']);
  });

  it('/model lists active preset and available choices', async () => {
    mockGetAvailablePresetNames.mockReturnValue(['ollama_k2.6', 'opus_4.7']);
    mockResolvePreset.mockImplementation((name: string) => {
      if (name === 'ollama_k2.6')
        return {
          name: 'ollama_k2.6',
          endpoint: 'ollama',
          model: 'kimi-k2.6:cloud',
          capabilities: { vision: false },
        };
      return null;
    });
    const ctx = makeCtx({
      allowedHostCommands: ['model'],
      containerConfig: { preset: 'ollama_k2.6' },
    });
    const result = await handleHostCommand(makeMsg('/model'), ctx, closeStdin);
    expect(result).toBe(true);
    expect(replies.length).toBe(1);
    expect(replies[0]).toContain('Active: `ollama_k2.6`');
    expect(replies[0]).toContain('`ollama_k2.6`');
    expect(replies[0]).toContain('`opus_4.7`');
  });

  it('/model shows unresolved when preset name exists but cannot be resolved', async () => {
    mockGetAvailablePresetNames.mockReturnValue(['opus_4.7']);
    mockResolvePreset.mockReturnValue(null);
    const ctx = makeCtx({
      allowedHostCommands: ['model'],
      containerConfig: { preset: 'deleted_preset' },
    });
    const result = await handleHostCommand(makeMsg('/model'), ctx, closeStdin);
    expect(result).toBe(true);
    expect(replies[0]).toContain('Active: `deleted_preset` (unresolved)');
  });

  it('/model shows "none" when no preset is set', async () => {
    mockGetAvailablePresetNames.mockReturnValue(['opus_4.7']);
    mockResolvePreset.mockReturnValue(null);
    const ctx = makeCtx({
      allowedHostCommands: ['model'],
      containerConfig: {},
    });
    const result = await handleHostCommand(makeMsg('/model'), ctx, closeStdin);
    expect(result).toBe(true);
    expect(replies[0]).toContain('Active: none');
  });

  it('/model <preset> updates DB with preset name only', async () => {
    mockGetAvailablePresetNames.mockReturnValue(['opus_4.7']);
    mockResolvePreset.mockImplementation((name: string) => {
      if (name === 'opus_4.7')
        return {
          name: 'opus_4.7',
          endpoint: 'anthropic',
          model: 'claude-opus-4-7',
          capabilities: { vision: true },
        };
      return null;
    });
    const group = {
      name: 'Test',
      folder: 'test',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      containerConfig: {
        allowedHostCommands: ['model'],
        preset: 'ollama_k2.6',
        skills: ['x'],
      },
    };
    const ctx = {
      jid: 'tg:123',
      group,
      sender: '123456789',
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
          preset: 'opus_4.7',
          skills: ['x'],
        }),
      }),
    );
    // Verify in-memory cache updated
    expect(group.containerConfig.preset).toBe('opus_4.7');
    expect(replies[0]).toContain('Switched to `opus_4.7`');
    expect(replies[0]).toContain('anthropic / claude-opus-4-7');
  });

  it('/model <preset> recycles active container', async () => {
    mockGetAvailablePresetNames.mockReturnValue(['opus_4.7']);
    mockResolvePreset.mockImplementation((name: string) => {
      if (name === 'opus_4.7')
        return {
          name: 'opus_4.7',
          endpoint: 'anthropic',
          model: 'claude-opus-4-7',
          capabilities: { vision: true },
        };
      return null;
    });
    const ctx = makeCtx({
      allowedHostCommands: ['model'],
      containerConfig: { preset: 'ollama_k2.6' },
    });
    await handleHostCommand(makeMsg('/model opus_4.7'), ctx, closeStdin);
    expect(closeStdinCalls).toEqual(['tg:123']);
  });

  it('/model <preset> calls sanitizeSessionJsonl on switch', async () => {
    mockGetAvailablePresetNames.mockReturnValue(['opus_4.7']);
    mockResolvePreset.mockImplementation((name: string) => {
      if (name === 'opus_4.7')
        return {
          name: 'opus_4.7',
          endpoint: 'anthropic',
          model: 'claude-opus-4-7',
          capabilities: { vision: true },
        };
      return null;
    });
    const ctx = makeCtx({
      allowedHostCommands: ['model'],
      containerConfig: { preset: 'ollama_k2.6' },
    });
    await handleHostCommand(makeMsg('/model opus_4.7'), ctx, closeStdin);
    expect(mockSanitizeSessionJsonl).toHaveBeenCalledWith('test');
  });

  it('/model <preset> continues even if sanitization throws', async () => {
    mockGetAvailablePresetNames.mockReturnValue(['opus_4.7']);
    mockResolvePreset.mockImplementation((name: string) => {
      if (name === 'opus_4.7')
        return {
          name: 'opus_4.7',
          endpoint: 'anthropic',
          model: 'claude-opus-4-7',
          capabilities: { vision: true },
        };
      return null;
    });
    mockSanitizeSessionJsonl.mockImplementation(() => {
      throw new Error('disk full');
    });
    const ctx = makeCtx({
      allowedHostCommands: ['model'],
      containerConfig: { preset: 'ollama_k2.6' },
    });
    const result = await handleHostCommand(
      makeMsg('/model opus_4.7'),
      ctx,
      closeStdin,
    );
    expect(result).toBe(true);
    expect(replies[0]).toContain('Switched to `opus_4.7`');
  });

  it('/model unknown_preset replies with rejection', async () => {
    mockGetAvailablePresetNames.mockReturnValue(['opus_4.7']);
    mockResolvePreset.mockReturnValue(null);
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
    const result = await handleHostCommand(
      makeMsg('/hi'),
      makeCtx({ allowedHostCommands: ['model'] }),
      closeStdin,
    );
    expect(result).toBe(false);
    expect(replies).toEqual([]);
  });

  it('falls through for /model when group has no allowedHostCommands', async () => {
    const result = await handleHostCommand(
      makeMsg('/model'),
      makeCtx({ allowedHostCommands: undefined }),
      closeStdin,
    );
    expect(result).toBe(false);
    expect(replies).toEqual([]);
  });

  // --- /shutdown tests ---

  it('/shutdown stops a running container and replies confirmation', async () => {
    const result = await handleHostCommand(
      makeMsg('/shutdown'),
      makeCtx({ allowedHostCommands: undefined }),
      closeStdin,
    );
    expect(result).toBe(true);
    expect(closeStdinCalls).toEqual(['tg:123']);
    expect(replies[0]).toContain('Container stopped');
  });

  it('/shutdown works without allowedHostCommands configured', async () => {
    const result = await handleHostCommand(
      makeMsg('/shutdown'),
      makeCtx({ allowedHostCommands: undefined }),
      closeStdin,
    );
    expect(result).toBe(true);
    expect(closeStdinCalls).toEqual(['tg:123']);
  });

  it('/shutdown replies "No container running" when no active container', async () => {
    const noopCloseStdin = (_jid: string): boolean => false;
    const result = await handleHostCommand(
      makeMsg('/shutdown'),
      makeCtx({ allowedHostCommands: undefined }),
      noopCloseStdin,
    );
    expect(result).toBe(true);
    expect(replies[0]).toBe('No container running for this group.');
  });

  it('/shutdown rejects unauthorized sender', async () => {
    mockIsSenderAllowed.mockReturnValue(false);
    const result = await handleHostCommand(
      makeMsg('/shutdown'),
      makeCtx({ allowedHostCommands: undefined }),
      closeStdin,
    );
    expect(result).toBe(true);
    expect(replies).toEqual(['Not authorised.']);
    expect(closeStdinCalls).toEqual([]);
  });

  it('/shutdown is case-insensitive', async () => {
    const result = await handleHostCommand(
      makeMsg('/Shutdown'),
      makeCtx({ allowedHostCommands: undefined }),
      closeStdin,
    );
    expect(result).toBe(true);
    expect(closeStdinCalls).toEqual(['tg:123']);
  });

  // --- /newsession tests ---

  it('/newsession is gated — returns false when not in allowedHostCommands', async () => {
    const result = await handleHostCommand(
      makeMsg('/newsession'),
      makeCtx({ allowedHostCommands: ['model'] }),
      closeStdin,
    );
    expect(result).toBe(false);
    expect(replies).toEqual([]);
  });

  it('/newsession stops container and clears session', async () => {
    const clearSessionCalls: string[] = [];
    const clearSession = (groupFolder: string) => {
      clearSessionCalls.push(groupFolder);
    };

    const result = await handleHostCommand(
      makeMsg('/newsession'),
      makeCtx({ allowedHostCommands: ['newsession'] }),
      closeStdin,
      clearSession,
    );
    expect(result).toBe(true);
    expect(closeStdinCalls).toEqual(['tg:123']);
    expect(clearSessionCalls).toEqual(['test']);
    expect(replies[0]).toContain('Session cleared');
  });

  it('/newsession clears session even when no container is running', async () => {
    const noopCloseStdin = (_jid: string): boolean => false;
    const clearSessionCalls: string[] = [];
    const clearSession = (groupFolder: string) => {
      clearSessionCalls.push(groupFolder);
    };

    const result = await handleHostCommand(
      makeMsg('/newsession'),
      makeCtx({ allowedHostCommands: ['newsession'] }),
      noopCloseStdin,
      clearSession,
    );
    expect(result).toBe(true);
    expect(clearSessionCalls).toEqual(['test']);
    expect(replies[0]).toContain('Session cleared');
  });

  it('/newsession rejects unauthorized sender', async () => {
    mockIsSenderAllowed.mockReturnValue(false);
    const clearSessionCalls: string[] = [];
    const clearSession = (groupFolder: string) => {
      clearSessionCalls.push(groupFolder);
    };

    const result = await handleHostCommand(
      makeMsg('/newsession'),
      makeCtx({ allowedHostCommands: ['newsession'] }),
      closeStdin,
      clearSession,
    );
    expect(result).toBe(true);
    expect(replies).toEqual(['Not authorised.']);
    expect(clearSessionCalls).toEqual([]);
  });

  it('/newsession is case-insensitive', async () => {
    const clearSessionCalls: string[] = [];
    const clearSession = (groupFolder: string) => {
      clearSessionCalls.push(groupFolder);
    };

    const result = await handleHostCommand(
      makeMsg('/NewSession'),
      makeCtx({ allowedHostCommands: ['newsession'] }),
      closeStdin,
      clearSession,
    );
    expect(result).toBe(true);
    expect(closeStdinCalls).toEqual(['tg:123']);
    expect(clearSessionCalls).toEqual(['test']);
  });

  // --- /version tests ---

  it('/version is gated — returns false when not in allowedHostCommands', async () => {
    const result = await handleHostCommand(
      makeMsg('/version'),
      makeCtx({ allowedHostCommands: ['model'] }),
      closeStdin,
    );
    expect(result).toBe(false);
  });

  it('/version (no args) returns channel info from VERSIONS.json', async () => {
    mockResolveImageTag.mockReturnValue('nanoclaw-agent:stable');
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        channels: { stable: 'v1.0.0', next: 'v1.0.0' },
        versions: {
          'v1.0.0': {
            imageId: 'sha256:abc123',
            sdkVersion: '0.2.76',
            cliVersion: '2.1.147',
          },
        },
      }),
    );
    mockExecSync.mockReturnValue('sha256:abc123\n');

    const ctx = makeCtx({ allowedHostCommands: ['version'] });
    const result = await handleHostCommand(
      makeMsg('/version'),
      ctx,
      closeStdin,
    );
    expect(result).toBe(true);
    expect(replies[0]).toContain('Container channel for this group: stable');
    expect(replies[0]).toContain('nanoclaw-agent:stable → v1.0.0');
    expect(replies[0]).toContain('SDK: @anthropic-ai/claude-agent-sdk@0.2.76');
    expect(replies[0]).toContain('CLI: @anthropic-ai/claude-code@2.1.147');
  });

  it('/version (no args) shows warning when VERSIONS.json is unreadable', async () => {
    mockResolveImageTag.mockReturnValue('nanoclaw-agent:stable');
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const ctx = makeCtx({ allowedHostCommands: ['version'] });
    const result = await handleHostCommand(
      makeMsg('/version'),
      ctx,
      closeStdin,
    );
    expect(result).toBe(true);
    expect(replies[0]).toContain('Could not read VERSIONS.json');
  });

  it('/version (no args) shows drift warning when image SHA mismatches', async () => {
    mockResolveImageTag.mockReturnValue('nanoclaw-agent:stable');
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        channels: { stable: 'v1.0.0' },
        versions: {
          'v1.0.0': {
            imageId: 'sha256:expected123',
            sdkVersion: '0.2.76',
            cliVersion: '2.1.147',
          },
        },
      }),
    );
    mockExecSync.mockReturnValue('sha256:different456\n');

    const ctx = makeCtx({ allowedHostCommands: ['version'] });
    const result = await handleHostCommand(
      makeMsg('/version'),
      ctx,
      closeStdin,
    );
    expect(result).toBe(true);
    expect(replies[0]).toContain('does not match VERSIONS.json');
  });

  it('/version invalid rejects with clear error', async () => {
    const ctx = makeCtx({ allowedHostCommands: ['version'] });
    const result = await handleHostCommand(
      makeMsg('/version beta'),
      ctx,
      closeStdin,
    );
    expect(result).toBe(true);
    expect(replies[0]).toContain('Invalid channel');
    expect(replies[0]).toContain('stable');
    expect(replies[0]).toContain('next');
    expect(mockSetRegisteredGroup).not.toHaveBeenCalled();
  });

  it('/version next rejects when image does not exist', async () => {
    mockResolveImageTag.mockReturnValue('nanoclaw-agent:next');
    mockImageExists.mockReturnValue(false);

    const ctx = makeCtx({ allowedHostCommands: ['version'] });
    const result = await handleHostCommand(
      makeMsg('/version next'),
      ctx,
      closeStdin,
    );
    expect(result).toBe(true);
    expect(replies[0]).toContain('Image nanoclaw-agent:next not found');
    expect(mockSetRegisteredGroup).not.toHaveBeenCalled();
    expect(closeStdinCalls).toEqual([]);
  });

  it('/version next updates DB and recycles container', async () => {
    mockResolveImageTag.mockReturnValue('nanoclaw-agent:next');
    mockImageExists.mockReturnValue(true);

    const ctx = makeCtx({ allowedHostCommands: ['version'] });
    const result = await handleHostCommand(
      makeMsg('/version next'),
      ctx,
      closeStdin,
    );
    expect(result).toBe(true);
    expect(mockSetRegisteredGroup).toHaveBeenCalledWith(
      'tg:123',
      expect.objectContaining({ containerChannel: 'next' }),
    );
    expect(closeStdinCalls).toEqual(['tg:123']);
    expect(replies[0]).toContain('Switched to channel: next');
  });

  it('/version stable updates DB and recycles container', async () => {
    mockResolveImageTag.mockReturnValue('nanoclaw-agent:stable');
    mockImageExists.mockReturnValue(true);

    const ctx = makeCtx({ allowedHostCommands: ['version'] });
    const result = await handleHostCommand(
      makeMsg('/version stable'),
      ctx,
      closeStdin,
    );
    expect(result).toBe(true);
    expect(mockSetRegisteredGroup).toHaveBeenCalledWith(
      'tg:123',
      expect.objectContaining({ containerChannel: 'stable' }),
    );
    expect(closeStdinCalls).toEqual(['tg:123']);
    expect(replies[0]).toContain('Switched to channel: stable');
  });

  it('/version is case-insensitive for channel arg', async () => {
    mockResolveImageTag.mockReturnValue('nanoclaw-agent:next');
    mockImageExists.mockReturnValue(true);

    const ctx = makeCtx({ allowedHostCommands: ['version'] });
    const result = await handleHostCommand(
      makeMsg('/version NEXT'),
      ctx,
      closeStdin,
    );
    expect(result).toBe(true);
    expect(mockSetRegisteredGroup).toHaveBeenCalledWith(
      'tg:123',
      expect.objectContaining({ containerChannel: 'next' }),
    );
  });

  it('/version rejects unauthorized sender', async () => {
    mockIsSenderAllowed.mockReturnValue(false);
    const ctx = makeCtx({ allowedHostCommands: ['version'] });
    const result = await handleHostCommand(
      makeMsg('/version'),
      ctx,
      closeStdin,
    );
    expect(result).toBe(true);
    expect(replies).toEqual(['Not authorised.']);
  });
});
