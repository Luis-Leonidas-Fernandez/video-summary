import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import { pathExists, readText } from '../utils/files.js';

const FULL_STUDY_NOTES_FILE = 'full_study_notes_es.txt';
const SUMMARY_FILE = 'summary_es.txt';
const OUTPUT_DOCX_FILE = 'study_notes_es.docx';

export type StudyNotesWordSource = 'full_study_notes' | 'summary';

export interface StudyNotesWordExportResult {
  generated: boolean;
  outputPath?: string;
  sourcePath?: string;
  sourceType?: StudyNotesWordSource;
}

async function resolveExportSource(outputDir: string): Promise<{
  sourcePath: string;
  sourceType: StudyNotesWordSource;
  content: string;
} | null> {
  const candidates: Array<{ fileName: string; sourceType: StudyNotesWordSource }> = [
    { fileName: FULL_STUDY_NOTES_FILE, sourceType: 'full_study_notes' },
    { fileName: SUMMARY_FILE, sourceType: 'summary' },
  ];

  for (const candidate of candidates) {
    const sourcePath = path.join(outputDir, candidate.fileName);
    if (!(await pathExists(sourcePath))) {
      continue;
    }

    const content = (await readText(sourcePath)).trim();
    if (!content) {
      continue;
    }

    return {
      sourcePath,
      sourceType: candidate.sourceType,
      content,
    };
  }

  return null;
}

function paragraph(text: string): Paragraph {
  return new Paragraph({
    children: [new TextRun(text)],
    spacing: { after: 160 },
  });
}

type HeadingLevelValue = (typeof HeadingLevel)[keyof typeof HeadingLevel];

function heading(text: string, level: HeadingLevelValue): Paragraph {
  return new Paragraph({
    text,
    heading: level,
    spacing: { before: 200, after: 120 },
  });
}

function bullet(text: string): Paragraph {
  return new Paragraph({
    text,
    bullet: { level: 0 },
    spacing: { after: 80 },
  });
}

function buildParagraphs(sourceText: string): Paragraph[] {
  const lines = sourceText.replace(/\r\n/g, '\n').split('\n');
  const blocks: Paragraph[] = [];
  let buffer: string[] = [];

  const flushBuffer = (): void => {
    const merged = buffer.join(' ').replace(/\s+/g, ' ').trim();
    buffer = [];
    if (!merged) {
      return;
    }
    blocks.push(paragraph(merged));
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      flushBuffer();
      continue;
    }

    if (line.startsWith('### ')) {
      flushBuffer();
      blocks.push(heading(line.slice(4).trim(), HeadingLevel.HEADING_3));
      continue;
    }

    if (line.startsWith('## ')) {
      flushBuffer();
      blocks.push(heading(line.slice(3).trim(), HeadingLevel.HEADING_2));
      continue;
    }

    if (line.startsWith('# ')) {
      flushBuffer();
      blocks.push(heading(line.slice(2).trim(), HeadingLevel.HEADING_1));
      continue;
    }

    if (line.startsWith('- ')) {
      flushBuffer();
      blocks.push(bullet(line.slice(2).trim()));
      continue;
    }

    buffer.push(line);
  }

  flushBuffer();
  return blocks.length > 0 ? blocks : [paragraph(sourceText.trim())];
}

export async function exportStudyNotesDocx(outputDir: string): Promise<StudyNotesWordExportResult> {
  const resolvedSource = await resolveExportSource(outputDir);
  if (!resolvedSource) {
    return { generated: false };
  }

  const doc = new Document({
    sections: [
      {
        children: buildParagraphs(resolvedSource.content),
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  const outputPath = path.join(outputDir, OUTPUT_DOCX_FILE);
  const tempPath = `${outputPath}.tmp`;

  await fs.writeFile(tempPath, buffer);
  await fs.rename(tempPath, outputPath);

  return {
    generated: true,
    outputPath,
    sourcePath: resolvedSource.sourcePath,
    sourceType: resolvedSource.sourceType,
  };
}
