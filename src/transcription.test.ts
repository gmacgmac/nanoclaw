import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { logger } from './logger.js';
import { transcribeAudio } from './transcription.js';

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('transcribeAudio', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'transcription-test-'));
  });

  afterEach(async () => {
    delete process.env.WHISPER_MODEL;
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns error when model is not found', async () => {
    process.env.WHISPER_MODEL = path.join(tmpDir, 'nonexistent.bin');
    const result = await transcribeAudio('/tmp/nonexistent.wav');
    expect(result.text).toBeNull();
    expect(result.error).toMatch(/Model not found/);
  });

  it('returns error when audio file is not found', async () => {
    const modelPath = path.join(tmpDir, 'ggml-test.bin');
    await fs.promises.writeFile(modelPath, 'dummy-model');
    process.env.WHISPER_MODEL = modelPath;

    const result = await transcribeAudio('/tmp/nonexistent.wav');
    expect(result.text).toBeNull();
    expect(result.error).toMatch(/Audio file not found/);
  });
});
