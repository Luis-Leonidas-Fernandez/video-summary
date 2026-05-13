import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { JobFileEntry } from '../types.js';

export const projectRoot = path.resolve(process.cwd(), '..');
export const outputRoot = path.join(projectRoot, 'output');

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function appendLine(filePath: string, line: string): Promise<void> {
  await fs.appendFile(filePath, `${line}\n`, 'utf-8');
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

export async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf-8');
}

export async function writeText(filePath: string, content: string): Promise<void> {
  await fs.writeFile(filePath, content, 'utf-8');
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function listJobFiles(jobId: string, jobDir: string): Promise<JobFileEntry[]> {
  const dirEntries = await fs.readdir(jobDir, { withFileTypes: true });
  const files = await Promise.all(
    dirEntries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const absolutePath = path.join(jobDir, entry.name);
        const stats = await fs.stat(absolutePath);

        return {
          name: entry.name,
          path: absolutePath,
          size: stats.size,
          createdAt: stats.birthtime.toISOString(),
          downloadUrl: `/api/jobs/${jobId}/files/${encodeURIComponent(entry.name)}`,
        } satisfies JobFileEntry;
      }),
  );

  return files.sort((a, b) => a.name.localeCompare(b.name));
}

export function safeResolveFile(jobDir: string, fileName: string): string {
  const resolved = path.resolve(jobDir, fileName);
  if (!resolved.startsWith(path.resolve(jobDir) + path.sep) && resolved !== path.resolve(jobDir, path.basename(fileName))) {
    throw new Error('Invalid file path');
  }

  return resolved;
}

const TRANSCRIPTION_FILE_PATTERNS: RegExp[] = [
  /^audio\.mp3$/,
  /^audio_denoised\.wav$/,
  /^transcription\.txt$/,
  /^transcription_part_\d+\.txt$/,
  /^transcription_chunk_\d+_\d+\.txt$/,
  /^translation_es\.txt$/,
];

const TRANSCRIPTION_DIRECTORY_NAMES = new Set(['video_parts', 'transcription_chunks']);

async function copyDirectoryRecursive(sourceDir: string, destDir: string): Promise<number> {
  await ensureDir(destDir);
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  let copiedFiles = 0;
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copiedFiles += await copyDirectoryRecursive(sourcePath, destPath);
    } else if (entry.isFile()) {
      await fs.copyFile(sourcePath, destPath);
      copiedFiles += 1;
    }
  }
  return copiedFiles;
}

export interface CloneArtifactsResult {
  filesCopied: number;
  directoriesCopied: string[];
}

export async function cloneTranscriptionArtifacts(
  sourceDir: string,
  destDir: string,
): Promise<CloneArtifactsResult> {
  if (!(await pathExists(sourceDir))) {
    throw new Error(`El job source ${sourceDir} no existe en disco.`);
  }

  await ensureDir(destDir);
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  let filesCopied = 0;
  const directoriesCopied: string[] = [];

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      if (TRANSCRIPTION_DIRECTORY_NAMES.has(entry.name)) {
        const copied = await copyDirectoryRecursive(sourcePath, destPath);
        filesCopied += copied;
        directoriesCopied.push(entry.name);
      }
      continue;
    }

    if (entry.isFile() && TRANSCRIPTION_FILE_PATTERNS.some((pattern) => pattern.test(entry.name))) {
      await fs.copyFile(sourcePath, destPath);
      filesCopied += 1;
    }
  }

  return { filesCopied, directoriesCopied };
}
