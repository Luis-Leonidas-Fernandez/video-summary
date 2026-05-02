import { generateSpanishSummary, repairSpanishSummary } from './ollamaClient.js';
import {
  validateExtractionContent,
  type ValidationMatch,
  type ValidationMetrics,
  type ValidationResult,
  type ValidationStatus,
} from './studyValidation.js';

export interface ValidationReportPart {
  part: string;
  status: ValidationStatus;
  decisionReason: string;
  metrics: ValidationMetrics;
  matches: ValidationMatch[];
  warnings: string[];
  strongFlags: string[];
  repairAttempts: number;
}

export interface ExtractionGenerationResult {
  content: string;
  validation: ValidationReportPart;
}

function normalizePartExtraction(partNumber: number, content: string): string {
  const partHeading = `## Parte ${String(partNumber).padStart(3, '0')}`;
  const trimmed = content.trim();

  if (!trimmed) {
    return `${partHeading}\n`;
  }

  if (trimmed.startsWith(partHeading)) {
    return `${trimmed}\n`;
  }

  return `${partHeading}\n\n${trimmed}\n`;
}

function buildReportPart(
  partNumber: number,
  status: ValidationStatus,
  validation: ValidationResult,
  repairAttempts: number,
  encounteredStrongFlags: string[] = validation.decision.strongFlags,
): ValidationReportPart {
  return {
    part: String(partNumber).padStart(3, '0'),
    status,
    decisionReason: validation.decision.decisionReason,
    metrics: validation.metrics,
    matches: validation.matches,
    warnings: validation.decision.warnings,
    strongFlags: encounteredStrongFlags,
    repairAttempts: repairAttempts,
  };
}

export async function generateExtractionForPart({
  transcription,
  partNumber,
  existingExtraction,
}: {
  transcription: string;
  partNumber: number;
  existingExtraction?: string;
}): Promise<ExtractionGenerationResult> {
  let repairAttempts = 0;
  let extraction = normalizePartExtraction(
    partNumber,
    existingExtraction?.trim() || (await generateSpanishSummary(transcription)),
  );
  let validation = validateExtractionContent({ transcription, extraction });
  const encounteredStrongFlags = [...validation.decision.strongFlags];

  if (validation.decision.action === 'reject_or_repair') {
    repairAttempts = 1;
    extraction = normalizePartExtraction(
      partNumber,
      await repairSpanishSummary({
        rawExtraction: extraction,
        transcription,
        strongFlags: validation.decision.strongFlags,
      }),
    );
    validation = validateExtractionContent({ transcription, extraction });
    for (const flag of validation.decision.strongFlags) {
      if (!encounteredStrongFlags.includes(flag)) {
        encounteredStrongFlags.push(flag);
      }
    }
  }

  const status: ValidationStatus = validation.decision.action === 'reject_or_repair'
    ? 'failed'
    : repairAttempts > 0
      ? 'repaired'
      : validation.decision.action === 'accept_with_warnings'
        ? 'accepted_with_warnings'
        : 'accepted';

  return {
    content: extraction,
    validation: buildReportPart(partNumber, status, validation, repairAttempts, encounteredStrongFlags),
  };
}

export function consolidateExtractions(extractions: string[]): string {
  const content = extractions
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n');

  return `${content.trim()}\n`;
}
