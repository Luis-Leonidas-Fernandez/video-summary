import path from 'node:path';
import { promises as fs } from 'node:fs';
import { appConfig } from '../config.js';
import { ensureDir, pathExists } from '../utils/files.js';
import { runCommand } from '../utils/shell.js';

interface Logger {
  (message: string): Promise<void>;
}

async function listPartFiles(partsDir: string): Promise<string[]> {
  if (!(await pathExists(partsDir))) {
    return [];
  }

  return (await fs.readdir(partsDir))
    .filter((file) => /^part_\d+\.wav$/i.test(file))
    .sort((a, b) => a.localeCompare(b))
    .map((file) => path.join(partsDir, file));
}

export async function partitionVideoAudio({
  outputDir,
  inputAudioPath,
  ffmpegCommand,
  log,
  signal,
}: {
  outputDir: string;
  inputAudioPath: string;
  ffmpegCommand: string;
  log: Logger;
  signal?: AbortSignal;
}): Promise<string[]> {
  const partsDir = path.join(outputDir, 'video_parts');
  const outputPattern = path.join(partsDir, 'part_%03d.wav');

  await ensureDir(partsDir);

  const existingParts = await listPartFiles(partsDir);
  if (existingParts.length > 0) {
    await log(`Reutilizando ${existingParts.length} partes de video ya existentes en ${partsDir}.`);
    return existingParts;
  }

  await log(
    `Segmentando el audio del video en partes de ${appConfig.videoPartDurationSeconds} segundos.`,
  );

  await runCommand({
    command: ffmpegCommand,
    args: [
      '-y',
      '-i',
      inputAudioPath,
      '-f',
      'segment',
      '-segment_start_number',
      '1',
      '-segment_time',
      String(appConfig.videoPartDurationSeconds),
      '-c',
      'copy',
      outputPattern,
    ],
    signal,
    onStdout: async (chunk) => {
      for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
        await log(`[ffmpeg:video-part] ${line}`);
      }
    },
    onStderr: async (chunk) => {
      for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
        await log(`[ffmpeg:video-part] ${line}`);
      }
    },
  });

  const parts = await listPartFiles(partsDir);
  if (parts.length === 0) {
    throw new Error('ffmpeg terminó, pero no generó partes de video en el output esperado.');
  }

  await log(`Video segmentado en ${parts.length} partes de trabajo.`);
  return parts;
}
