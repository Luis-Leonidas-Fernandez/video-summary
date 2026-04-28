import { useEffect, useMemo, useState } from 'react';
import './styles.css';
import {
  createJob,
  getJob,
  getJobFileContent,
  getJobFiles,
  type CreateJobPayload,
  type JobFile,
  type JobResponse,
} from './api';
import { FileList } from './components/FileList';
import { JobForm } from './components/JobForm';
import { JobStatus } from './components/JobStatus';
import { SummaryPreview } from './components/SummaryPreview';

const TERMINAL_STATUSES = new Set(['completed', 'failed']);

function App() {
  const [job, setJob] = useState<JobResponse | null>(null);
  const [files, setFiles] = useState<JobFile[]>([]);
  const [summaryContent, setSummaryContent] = useState<string | null>(null);
  const [isSummaryLoading, setIsSummaryLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSummaryPreview = async (jobId: string) => {
    setIsSummaryLoading(true);

    try {
      const content = await getJobFileContent(jobId, 'summary_es.txt');
      setSummaryContent(content);
    } catch (summaryError) {
      setSummaryContent(null);
      if (job?.generateSummary) {
        setError(summaryError instanceof Error ? summaryError.message : 'No se pudo cargar el resumen.');
      }
    } finally {
      setIsSummaryLoading(false);
    }
  };

  useEffect(() => {
    if (!job || TERMINAL_STATUSES.has(job.status)) {
      return;
    }

    const intervalId = window.setInterval(async () => {
      try {
        const refreshedJob = await getJob(job.id);
        setJob(refreshedJob);

        if (TERMINAL_STATUSES.has(refreshedJob.status)) {
          const nextFiles = await getJobFiles(refreshedJob.id);
          setFiles(nextFiles);
        }
      } catch (pollError) {
        setError(pollError instanceof Error ? pollError.message : 'No se pudo refrescar el job.');
      }
    }, 2000);

    return () => window.clearInterval(intervalId);
  }, [job]);

  useEffect(() => {
    if (!job || !job.generateSummary || job.status !== 'completed') {
      return;
    }

    void loadSummaryPreview(job.id);
  }, [job?.id, job?.status, job?.generateSummary]);

  const handleSubmit = async (payload: CreateJobPayload) => {
    setIsSubmitting(true);
    setError(null);
    setFiles([]);
    setSummaryContent(null);
    setIsSummaryLoading(false);

    try {
      const created = await createJob(payload);
      setJob(created);
      setFiles(created.files);
      if (created.generateSummary && TERMINAL_STATUSES.has(created.status)) {
        await loadSummaryPreview(created.id);
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'No se pudo crear el job.');
      setJob(null);
    } finally {
      setIsSubmitting(false);
    }
  };

  const logs = useMemo(() => job?.logs.join('\n') ?? 'Todavía no hay logs.', [job]);

  return (
    <main className="app-shell">
      <header>
        <p className="eyebrow">MVP local para Mac</p>
        <h1>Video Study Tool</h1>
        <p>
          Pegá una URL de YouTube, descargá el audio, transcribí con whisper y guardá todo en
          <code> /output</code>.
        </p>
      </header>

      <div className="layout-grid">
        <JobForm isSubmitting={isSubmitting} onSubmit={handleSubmit} />
        <JobStatus job={job} error={error} />
      </div>

      <section className="panel">
        <h2>Logs / progreso</h2>
        <pre className="log-viewer">{logs}</pre>
      </section>

      <SummaryPreview content={summaryContent} isLoading={isSummaryLoading} />

      <FileList files={files.length > 0 ? files : job?.files ?? []} />
    </main>
  );
}

export default App;
