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

export async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, content, 'utf-8');
  await fs.rename(tempPath, filePath);
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function inferFileKind(relativePath: string): JobFileEntry['kind'] {
  const normalized = relativePath.toLowerCase();
  if (normalized.endsWith('.mp3') || normalized.endsWith('.wav') || normalized.includes('/audio')) {
    return 'audio';
  }
  if (normalized.includes('transcription') || normalized.includes('translation_')) {
    return 'transcript';
  }
  if (normalized.includes('summary') || normalized.includes('study_notes') || normalized.includes('glossary') || normalized.includes('outline')) {
    return 'summary';
  }
  if (normalized.includes('grounding') || normalized.includes('evidence') || normalized.includes('citation')) {
    return 'grounding';
  }
  if (normalized.includes('report') || normalized.includes('coverage') || normalized.includes('validation')) {
    return 'report';
  }
  if (normalized.includes('log')) {
    return 'log';
  }
  return 'other';
}

async function collectFilesRecursive(rootDir: string, currentDir = rootDir): Promise<string[]> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      return collectFilesRecursive(rootDir, absolutePath);
    }
    if (entry.isFile()) {
      return [path.relative(rootDir, absolutePath)];
    }
    return [] as string[];
  }));

  return nested.flat();
}

export async function listJobFiles(jobId: string, rootDir: string, itemId?: string): Promise<JobFileEntry[]> {
  const relativePaths = await collectFilesRecursive(rootDir).catch(() => []);
  const files = await Promise.all(
    relativePaths.map(async (relativePath) => {
      const absolutePath = path.join(rootDir, relativePath);
      const stats = await fs.stat(absolutePath);
      const filename = path.basename(relativePath);
      const encodedPath = encodeURIComponent(relativePath);
      const downloadUrl = itemId
        ? `/api/jobs/${jobId}/items/${encodeURIComponent(itemId)}/files/${encodedPath}`
        : `/api/jobs/${jobId}/files/${encodedPath}`;

      return {
        itemId,
        name: filename,
        filename,
        relativePath,
        path: absolutePath,
        size: stats.size,
        createdAt: stats.birthtime.toISOString(),
        downloadUrl,
        kind: inferFileKind(relativePath),
      } satisfies JobFileEntry;
    }),
  );

  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export function safeResolveFile(rootDir: string, fileName: string): string {
  const resolved = path.resolve(rootDir, fileName);
  const resolvedRoot = path.resolve(rootDir);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`) && resolved !== path.resolve(rootDir, path.basename(fileName))) {
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
  /^translation_part_\d+\.txt$/,
  /^translation_chunk_\d+_\d+\.txt$/,
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
