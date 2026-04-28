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
