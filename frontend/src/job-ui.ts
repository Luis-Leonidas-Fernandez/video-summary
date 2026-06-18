import type { JobFile, JobResponse } from './api';

const STUDY_NOTES_DOCX_FILE = 'study_notes_es.docx';

export const TERMINAL_STATUSES = new Set(['completed', 'completed_with_warnings', 'failed', 'cancelled']);
export const TERMINAL_SUCCESS_STATUSES = new Set(['completed', 'completed_with_warnings']);

export function getPollingInterval(status: JobResponse['status'] | undefined): number | null {
  if (!status || TERMINAL_STATUSES.has(status)) {
    return null;
  }

  if (status === 'queued' || status === 'pending' || status === 'resolving_sources') {
    return 4000;
  }

  return 2000;
}

export function getWorkflowHeadline(job: JobResponse | null): string {
  if (!job) {
    return 'Prepará el próximo procesamiento';
  }

  switch (job.status) {
    case 'completed':
      return 'Resultado listo para leer y auditar';
    case 'completed_with_warnings':
      return 'Resultado listo, pero con señales para revisar';
    case 'failed':
      return 'El pipeline necesita intervención';
    case 'cancelled':
      return 'Procesamiento cancelado';
    case 'cancelling':
      return 'Frenando el pipeline actual';
    case 'resolving_sources':
      return 'Resolviendo videos del lote';
    default:
      return 'Pipeline en ejecución';
  }
}

export function getJobModeLabel(job: JobResponse | null): string {
  if (!job?.inputMode) {
    return 'video único';
  }

  switch (job.inputMode) {
    case 'url_list':
      return 'lista manual';
    case 'playlist':
      return 'playlist';
    default:
      return 'video único';
  }
}

export function pickDefaultItemId(job: JobResponse | null): string | null {
  if (!job?.items?.length) {
    return null;
  }

  const active = job.summary?.activeItemId && job.items.find((item) => item.itemId === job.summary?.activeItemId);
  if (active) {
    return active.itemId;
  }

  const lastCompleted = [...job.items]
    .filter((item) => item.status === 'completed' || item.status === 'warning')
    .sort((left, right) => right.index - left.index)[0];

  return lastCompleted?.itemId ?? job.items[0]?.itemId ?? null;
}

export function getSelectedItem(job: JobResponse | null, selectedItemId: string | null) {
  if (!job?.items?.length || !selectedItemId) {
    return null;
  }

  return job.items.find((item) => item.itemId === selectedItemId) ?? null;
}

export function buildReviewRoute(jobId: string): string {
  return `/jobs/${encodeURIComponent(jobId)}/review`;
}

function getFileName(file: { filename?: string; name?: string; relativePath?: string }): string {
  return (file.filename || file.name || file.relativePath || '').toLowerCase();
}

function isStudyNotesWordFile(file: { filename?: string; name?: string; relativePath?: string }): boolean {
  return getFileName(file).endsWith(STUDY_NOTES_DOCX_FILE);
}

export function hasBatchWordExports(job: JobResponse | null): boolean {
  if (!job?.items?.length || job.inputMode === 'single_url') {
    return false;
  }

  return job.items.some((item) =>
    item.files.some((file) => isStudyNotesWordFile(file)),
  );
}

export function getSingleWordExport(job: JobResponse | null): JobFile | null {
  if (!job || job.inputMode !== 'single_url') {
    return null;
  }

  return job.files.find((file) => isStudyNotesWordFile(file)) ?? null;
}

export function buildBatchWordZipDownloadUrl(jobId: string): string {
  return `/api/jobs/${encodeURIComponent(jobId)}/download/study-notes.zip`;
}
