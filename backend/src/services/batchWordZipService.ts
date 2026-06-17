import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ZipArchive } from 'archiver';
import type { Response } from 'express';
import type { JobRecord } from '../types.js';

const STUDY_NOTES_DOCX_FILE = 'study_notes_es.docx';

interface BatchWordZipEntry {
  itemId: string;
  absolutePath: string;
  archivePath: string;
}

interface BatchWordZipSkippedItem {
  itemId: string;
  reason: string;
}

interface BatchWordZipCollection {
  entries: BatchWordZipEntry[];
  skipped: BatchWordZipSkippedItem[];
}

export function buildBatchStudyNotesZipFileName(jobId: string): string {
  return `job_${jobId}_study_notes_es.zip`;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

export async function collectBatchStudyNotesDocx(job: JobRecord): Promise<BatchWordZipCollection> {
  const items = [...(job.items ?? [])].sort((left, right) => left.index - right.index);
  const entries: BatchWordZipEntry[] = [];
  const skipped: BatchWordZipSkippedItem[] = [];

  for (const item of items) {
    const absolutePath = path.join(item.outputDir, STUDY_NOTES_DOCX_FILE);
    if (await fileExists(absolutePath)) {
      entries.push({
        itemId: item.itemId,
        absolutePath,
        archivePath: `${item.itemId}/${STUDY_NOTES_DOCX_FILE}`,
      });
      continue;
    }

    skipped.push({
      itemId: item.itemId,
      reason: 'missing_study_notes_docx',
    });
  }

  return { entries, skipped };
}

function buildZipManifest(job: JobRecord, collection: BatchWordZipCollection): string {
  const lines = [
    `jobId: ${job.id}`,
    `inputMode: ${job.inputMode ?? 'single_url'}`,
    `generatedAt: ${new Date().toISOString()}`,
    `includedDocxCount: ${collection.entries.length}`,
    `skippedItemCount: ${collection.skipped.length}`,
    '',
    'Included items:',
    ...collection.entries.map((entry) => `- ${entry.itemId} -> ${entry.archivePath}`),
  ];

  if (collection.skipped.length > 0) {
    lines.push('', 'Skipped items:');
    lines.push(...collection.skipped.map((item) => `- ${item.itemId} -> ${item.reason}`));
  }

  lines.push('');
  return lines.join('\n');
}

export async function streamBatchStudyNotesZip(job: JobRecord, res: Response): Promise<void> {
  const collection = await collectBatchStudyNotesDocx(job);
  if (collection.entries.length === 0) {
    throw new Error('No hay archivos study_notes_es.docx disponibles para este lote.');
  }

  const archive = new ZipArchive({
    zlib: { level: 9 },
  });

  const fileName = buildBatchStudyNotesZipFileName(job.id);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

  archive.on('warning', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') {
      res.destroy(error);
    }
  });

  archive.on('error', (error: Error) => {
    res.destroy(error);
  });

  res.on('close', () => {
    if (!res.writableEnded) {
      archive.abort();
    }
  });

  archive.pipe(res);

  for (const entry of collection.entries) {
    archive.file(entry.absolutePath, { name: entry.archivePath });
  }

  if (collection.skipped.length > 0) {
    archive.append(buildZipManifest(job, collection), { name: 'README.txt' });
  }

  await archive.finalize();
}
