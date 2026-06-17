import { useCallback, useEffect, useState } from 'react';
import {
  getJobFileContent,
  getJobFiles,
  type GroundingReport,
  type JobFile,
  type JobResponse,
  type ValidationReport,
} from '../api';
import { TERMINAL_SUCCESS_STATUSES } from '../job-ui';

function isUsableGroundingReport(value: unknown): value is GroundingReport {
  if (!value || typeof value !== 'object' || !('parts' in value)) {
    return false;
  }

  const parts = (value as { parts?: unknown }).parts;
  return Array.isArray(parts) && parts.length > 0;
}

export function useJobArtifacts(job: JobResponse | null, selectedItemId: string | null) {
  const [files, setFiles] = useState<JobFile[]>([]);
  const [summaryContent, setSummaryContent] = useState<string | null>(null);
  const [groundingReport, setGroundingReport] = useState<GroundingReport | null>(null);
  const [validationReport, setValidationReport] = useState<ValidationReport | null>(null);
  const [isSummaryLoading, setIsSummaryLoading] = useState(false);
  const [isValidationLoading, setIsValidationLoading] = useState(false);
  const [artifactError, setArtifactError] = useState<string | null>(null);

  const resetArtifacts = useCallback(() => {
    setFiles([]);
    setSummaryContent(null);
    setGroundingReport(null);
    setValidationReport(null);
    setIsSummaryLoading(false);
    setIsValidationLoading(false);
    setArtifactError(null);
  }, []);

  const loadSummaryPreview = useCallback(async (jobId: string, itemId?: string | null) => {
    setIsSummaryLoading(true);

    try {
      let content: string;
      try {
        content = await getJobFileContent(jobId, 'full_study_notes_es.txt', itemId ?? undefined);
      } catch {
        content = await getJobFileContent(jobId, 'summary_es.txt', itemId ?? undefined);
      }
      setSummaryContent(content);
    } catch {
      setSummaryContent(null);
    } finally {
      setIsSummaryLoading(false);
    }
  }, []);

  const loadReviewReports = useCallback(async (jobId: string, itemId?: string | null) => {
    setIsValidationLoading(true);

    try {
      try {
        const rawGrounding = await getJobFileContent(jobId, 'grounding_report.json', itemId ?? undefined);
        const parsedGrounding = JSON.parse(rawGrounding) as unknown;
        setGroundingReport(isUsableGroundingReport(parsedGrounding) ? parsedGrounding : null);
      } catch {
        setGroundingReport(null);
      }

      try {
        const rawValidation = await getJobFileContent(jobId, 'validation_report.json', itemId ?? undefined);
        const parsedValidation = JSON.parse(rawValidation) as ValidationReport;
        setValidationReport(parsedValidation);
      } catch {
        setValidationReport(null);
      }
    } finally {
      setIsValidationLoading(false);
    }
  }, []);

  const refreshArtifacts = useCallback(async (currentJob: JobResponse, itemId: string | null) => {
    try {
      const scopedFiles = await getJobFiles(currentJob.id, itemId ?? undefined);
      setFiles(scopedFiles);
      setArtifactError(null);
    } catch (filesError) {
      setFiles(currentJob.files ?? []);
      setArtifactError(filesError instanceof Error ? filesError.message : 'No se pudieron cargar los artefactos del job.');
    }

    if (!currentJob.generateSummary) {
      setSummaryContent(null);
      setGroundingReport(null);
      setValidationReport(null);
      return;
    }

    const shouldAttemptDerivedArtifacts = TERMINAL_SUCCESS_STATUSES.has(currentJob.status) || currentJob.status === 'processing';
    if (!shouldAttemptDerivedArtifacts) {
      setSummaryContent(null);
      setGroundingReport(null);
      setValidationReport(null);
      return;
    }

    await Promise.all([
      loadSummaryPreview(currentJob.id, itemId),
      loadReviewReports(currentJob.id, itemId),
    ]);
  }, [loadReviewReports, loadSummaryPreview]);

  useEffect(() => {
    if (!job) {
      resetArtifacts();
      return;
    }

    void refreshArtifacts(job, selectedItemId);
  }, [job, refreshArtifacts, resetArtifacts, selectedItemId]);

  return {
    files,
    summaryContent,
    groundingReport,
    validationReport,
    isSummaryLoading,
    isValidationLoading,
    artifactError,
    refreshArtifacts,
    resetArtifacts,
  };
}
