import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

/** Transcription result with optional error details. */
export interface TranscriptionResult {
  text: string | null;
  error?: string;
}

/**
 * Resolve the path to the whisper-cli binary.
 * Uses WHISPER_BIN env var, then searches PATH.
 */
function resolveWhisperBin(): string {
  return process.env.WHISPER_BIN || 'whisper-cli';
}

/**
 * Resolve the path to the GGML model file.
 * Uses WHISPER_MODEL env var, then falls back to data/models/ggml-small.bin.
 */
function resolveModelPath(): string {
  return (
    process.env.WHISPER_MODEL ||
    path.join(process.cwd(), 'data/models/ggml-small.bin')
  );
}

/**
 * Convert an audio file to WAV format (16kHz mono) using ffmpeg.
 * Returns the path to the temporary WAV file.
 */
async function convertToWav(
  inputPath: string,
  tmpDir: string,
): Promise<string> {
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const wavPath = path.join(tmpDir, `${baseName}_${Date.now()}.wav`);

  await execFileAsync('ffmpeg', [
    '-y',
    '-i',
    inputPath,
    '-ar',
    '16000',
    '-ac',
    '1',
    '-c:a',
    'pcm_s16le',
    wavPath,
  ]);

  return wavPath;
}

/**
 * Transcribe an audio file using local whisper.cpp.
 *
 * Supports any format ffmpeg can read. Automatically converts to WAV
 * before passing to whisper-cli.
 *
 * @param audioPath - Path to the audio file
 * @param opts - Optional configuration
 * @returns Transcription result with text or error
 */
export async function transcribeAudio(
  audioPath: string,
  opts?: { language?: string },
): Promise<TranscriptionResult> {
  const whisperBin = resolveWhisperBin();
  const modelPath = resolveModelPath();

  // Verify model exists
  try {
    await fs.promises.access(modelPath, fs.constants.R_OK);
  } catch {
    return { text: null, error: `Model not found: ${modelPath}` };
  }

  // Verify audio file exists
  try {
    await fs.promises.access(audioPath, fs.constants.R_OK);
  } catch {
    return { text: null, error: `Audio file not found: ${audioPath}` };
  }

  const tmpDir = path.join(os.tmpdir(), 'nanoclaw-whisper');
  await fs.promises.mkdir(tmpDir, { recursive: true });

  const outputId = `out_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const outputPath = path.join(tmpDir, outputId);

  let wavPath: string | null = null;

  try {
    // Convert to WAV if needed
    const ext = path.extname(audioPath).toLowerCase();
    if (ext === '.wav') {
      wavPath = audioPath;
    } else {
      wavPath = await convertToWav(audioPath, tmpDir);
    }

    // Build whisper-cli args
    const args = [
      '-m',
      modelPath,
      '-f',
      wavPath,
      '-nt',
      '-otxt',
      '-of',
      outputPath,
    ];

    if (opts?.language) {
      args.push('-l', opts.language);
    }

    logger.debug(
      { audioPath, modelPath, whisperBin },
      'Starting whisper.cpp transcription',
    );

    // Run whisper-cli; stderr contains progress logs, stdout is minimal
    await execFileAsync(whisperBin, args, {
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });

    // Read the generated .txt file
    const txtFile = `${outputPath}.txt`;
    const transcript = (await fs.promises.readFile(txtFile, 'utf-8')).trim();

    if (transcript) {
      logger.info(
        { audioPath, chars: transcript.length },
        'Transcribed voice message',
      );
      return { text: transcript };
    }

    return { text: null, error: 'No transcription output from whisper-cli' };
  } catch (err: any) {
    const errorMsg =
      err.stderr?.slice(0, 500) || err.message || 'whisper-cli failed';
    logger.error(
      { audioPath, error: errorMsg },
      'whisper.cpp transcription failed',
    );
    return { text: null, error: errorMsg };
  } finally {
    // Clean up temporary files
    for (const f of [wavPath, `${outputPath}.txt`]) {
      if (f && f !== audioPath) {
        try {
          await fs.promises.unlink(f);
        } catch {
          // ignore cleanup errors
        }
      }
    }
  }
}
