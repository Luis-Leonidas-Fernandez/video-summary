import type { BatchJobItem, GroundingReport, GroundingReportPart, JobFile, JobResponse, ValidationReport } from './api';

export type JobHealth = 'healthy' | 'warning' | 'needs_review' | 'failed';

export interface JobHealthInfo {
  status: JobHealth;
  label: string;
  description: string;
}

export interface GroundingKpiSummary {
  invalidCitationCount: number;
  unsupportedClaimCount: number;
  fallbackRatePercent: number;
  schemaBrokenCount: number;
  thinReasoningCount: number;
  windowsTooCompressed: number;
  needsHumanReview: boolean;
  reviewedWindows: number;
}

export type ArtifactCategory = 'reading' | 'report' | 'debug' | 'raw' | 'log';

export interface CategorizedJobFile extends JobFile {
  category: ArtifactCategory;
}

const PRIMARY_READING_PATTERNS = [
  /^full_study_notes_es\.txt$/i,
  /^summary_es\.txt$/i,
  /^translation_part_/i,
  /^transcription_part_/i,
];

const REPORT_PATTERNS = [
  /^grounding_report\.json$/i,
  /^validation_report\.json$/i,
  /^coverage/i,
  /^resource/i,
  /^citation_integrity/i,
  /^evidence(_pack)?/i,
  /^claims_/i,
  /^grounding_worker_report/i,
];

const LOG_PATTERNS = [/log/i, /^resource_stages\.jsonl$/i];
const RAW_PATTERNS = [/raw/i, /invalid/i, /recovered/i];
const DEBUG_PATTERNS = [/thin_reasoning/i, /controlled_rewrite/i, /resolved_changes/i, /evidence_hints/i, /window/i, /extraction_part_/i];

function sumPartMetric(parts: GroundingReportPart[], selector: (part: GroundingReportPart) => number): number {
  return parts.reduce((total, part) => total + selector(part), 0);
}

function itemHasWarningSignals(item: BatchJobItem): boolean {
  return item.status === 'warning'
    || item.transcriptionQuality === 'suspicious'
    || item.transcriptionQuality === 'poor'
    || item.groundingStatus === 'partially_grounded'
    || item.groundingStatus === 'needs_human_review'
    || item.groundingStatus === 'too_compressed'
    || item.groundingStatus === 'legacy_warning'
    || (item.unsupportedClaimCount ?? 0) > 0
    || (item.invalidCitationCount ?? 0) > 0
    || (item.windowsTooCompressed ?? 0) > 0
    || (item.warnings?.length ?? 0) > 0;
}

export function summarizeGrounding(report: GroundingReport | null): GroundingKpiSummary | null {
  if (!report || report.parts.length === 0) {
    return null;
  }

  const invalidCitationCount = sumPartMetric(report.parts, (part) => part.metrics.invalidCitationCount);
  const unsupportedClaimCount = sumPartMetric(report.parts, (part) => part.metrics.unsupportedClaimCount);
  const windowsTooCompressed = sumPartMetric(report.parts, (part) => part.windowsTooCompressed);
  const schemaBrokenCount = sumPartMetric(report.parts, (part) => part.rejectedWindowMetrics?.schemaBroken ?? 0);
  const thinReasoningCount = sumPartMetric(report.parts, (part) => part.rejectedWindowMetrics?.thinReasoning ?? 0);
  const reviewedWindows = sumPartMetric(report.parts, (part) => part.windows.length);
  const fallbackRatePercent = report.parts.length > 0
    ? Math.round(
      (report.parts.reduce((total, part) => total + (part.fallbackRate ?? 0), 0) / report.parts.length) * 1000,
    ) / 10
    : 0;
  const needsHumanReview = report.parts.some(
    (part) => part.finalStatus === 'needs_human_review'
      || part.windows.some((window) => window.status === 'needs_human_review' || window.finalStatus === 'needs_review'),
  );

  return {
    invalidCitationCount,
    unsupportedClaimCount,
    fallbackRatePercent,
    schemaBrokenCount,
    thinReasoningCount,
    windowsTooCompressed,
    needsHumanReview,
    reviewedWindows,
  };
}

function deriveHealthFromGrounding(summary: GroundingKpiSummary): JobHealthInfo {
  if (summary.invalidCitationCount > 0 || summary.schemaBrokenCount > 0) {
    return {
      status: 'failed',
      label: 'Failed',
      description: 'Hay errores estructurales o citas inválidas que rompen la confianza del resultado.',
    };
  }

  if (summary.needsHumanReview || summary.unsupportedClaimCount > 0 || summary.windowsTooCompressed > 0) {
    return {
      status: 'needs_review',
      label: 'Needs review',
      description: 'El job terminó, pero hay señales de grounding que requieren mirada humana.',
    };
  }

  if (summary.fallbackRatePercent >= 10 || summary.thinReasoningCount > 0) {
    return {
      status: 'warning',
      label: 'Warnings',
      description: 'El material es usable, pero hubo recovery, fallback o compresión en partes del pipeline.',
    };
  }

  return {
    status: 'healthy',
    label: 'Healthy',
    description: 'El grounding y la salida final se ven consistentes y sin señales fuertes de riesgo.',
  };
}

export function deriveJobHealth(
  job: JobResponse | null,
  groundingReport: GroundingReport | null,
  validationReport: ValidationReport | null,
): JobHealthInfo | null {
  if (!job) {
    return null;
  }

  if (job.status === 'failed') {
    return {
      status: 'failed',
      label: 'Failed',
      description: 'El job falló y necesita intervención antes de reutilizar el resultado.',
    };
  }

  if (job.status === 'cancelled' || job.status === 'cancelling') {
    return {
      status: 'warning',
      label: 'Warnings',
      description: 'El pipeline fue frenado antes de completar todo el procesamiento.',
    };
  }

  const groundingSummary = summarizeGrounding(groundingReport);
  if (groundingSummary) {
    return deriveHealthFromGrounding(groundingSummary);
  }

  const items = job.items ?? [];
  const warningItems = job.summary?.warningItems ?? items.filter(itemHasWarningSignals).length;
  const failedItems = job.summary?.failedItems ?? items.filter((item) => item.status === 'failed').length;

  if (failedItems > 0) {
    return {
      status: warningItems > 0 || (job.summary?.completedItems ?? 0) > 0 ? 'needs_review' : 'failed',
      label: warningItems > 0 || (job.summary?.completedItems ?? 0) > 0 ? 'Needs review' : 'Failed',
      description: 'Al menos un item del lote falló o quedó en un estado no confiable.',
    };
  }

  if (warningItems > 0 || job.status === 'completed_with_warnings') {
    return {
      status: 'warning',
      label: 'Warnings',
      description: 'El lote terminó con items utilizables, pero no todos quedaron limpios desde el punto de vista de grounding o transcripción.',
    };
  }

  if (validationReport?.parts.some((part) => part.status === 'failed')) {
    return {
      status: 'needs_review',
      label: 'Needs review',
      description: 'El fallback legacy detectó señales fuertes que conviene revisar manualmente.',
    };
  }

  if (job.status === 'completed') {
    return {
      status: 'healthy',
      label: 'Healthy',
      description: 'El job completó el flujo principal sin señales fuertes visibles en esta vista.',
    };
  }

  if (job.status === 'resolving_sources') {
    return {
      status: 'warning',
      label: 'Warnings',
      description: 'La playlist todavía se está expandiendo. El pipeline de items aún no empezó.',
    };
  }

  return {
    status: 'warning',
    label: 'Warnings',
    description: 'El job sigue en curso. Mirá progreso, items, logs y grounding a medida que avanza.',
  };
}

function getFileName(file: JobFile): string {
  return file.filename || file.name || file.relativePath;
}

function categorizeFile(file: JobFile): ArtifactCategory {
  const name = getFileName(file);
  if (PRIMARY_READING_PATTERNS.some((pattern) => pattern.test(name))) {
    return 'reading';
  }

  if (REPORT_PATTERNS.some((pattern) => pattern.test(name))) {
    return 'report';
  }

  if (LOG_PATTERNS.some((pattern) => pattern.test(name))) {
    return 'log';
  }

  if (RAW_PATTERNS.some((pattern) => pattern.test(name))) {
    return 'raw';
  }

  if (DEBUG_PATTERNS.some((pattern) => pattern.test(name))) {
    return 'debug';
  }

  return 'raw';
}

function getFilePriority(file: JobFile): number {
  const normalized = getFileName(file).toLowerCase();
  if (normalized === 'full_study_notes_es.txt') return 0;
  if (normalized === 'summary_es.txt') return 1;
  if (normalized === 'grounding_report.json') return 2;
  if (normalized.includes('coverage') || normalized.includes('resource')) return 3;
  if (normalized.includes('log')) return 4;
  return 10;
}

export function sortAndCategorizeFiles(files: JobFile[]): CategorizedJobFile[] {
  return [...files]
    .map((file) => ({ ...file, category: categorizeFile(file) }))
    .sort((left, right) => {
      const priorityDiff = getFilePriority(left) - getFilePriority(right);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }
      return getFileName(left).localeCompare(getFileName(right));
    });
}
