import os from 'node:os';
import { spawnSync } from 'node:child_process';

interface PsRow {
  pid: number;
  ppid: number;
  rssKb: number;
  cpuPercent: number;
  command: string;
}

interface ResourceSnapshot {
  totalRssKb: number;
  totalCpuPercent: number;
  processCount: number;
}

interface ResourceMonitorOptions {
  includeOllama: boolean;
}

export interface JobResourceSummary {
  durationMs: number;
  peakRssMb: number;
  peakCpuPercent: number;
  finalRssMb: number;
  finalCpuPercent: number;
  peakProcessCount: number;
  finalProcessCount: number;
  monitoringError?: string;
}

export interface StageResourceSnapshot {
  timestamp: string;
  stage: string;
  processRssMb: number;
  processHeapMb: number;
  trackedProcessCount: number;
  systemUsedApproxMb: number;
  systemFreeMb: number;
  metadata?: Record<string, unknown>;
}

function runPsSnapshot(): PsRow[] {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,rss=,%cpu=,command='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    throw result.error;
  }

  if ((result.status ?? 0) !== 0) {
    throw new Error(result.stderr.trim() || 'ps devolvió un código no exitoso.');
  }

  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)$/);
      if (!match) {
        return null;
      }

      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        rssKb: Number(match[3]),
        cpuPercent: Number(match[4]),
        command: match[5],
      } satisfies PsRow;
    })
    .filter((row): row is PsRow => Boolean(row));
}

function collectDescendantPids(rows: PsRow[], rootPid: number): Set<number> {
  const descendants = new Set<number>([rootPid]);
  let changed = true;

  while (changed) {
    changed = false;

    for (const row of rows) {
      if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        changed = true;
      }
    }
  }

  return descendants;
}

function collectTrackedRows(rows: PsRow[], options: ResourceMonitorOptions): PsRow[] {
  const trackedPids = collectDescendantPids(rows, process.pid);

  if (options.includeOllama) {
    for (const row of rows) {
      if (row.command === 'ollama serve' || row.command.includes('/ollama runner --ollama-engine')) {
        trackedPids.add(row.pid);
      }
    }
  }

  return rows.filter((row) => trackedPids.has(row.pid));
}

function buildSnapshot(options: ResourceMonitorOptions): ResourceSnapshot {
  const rows = runPsSnapshot();
  const trackedRows = collectTrackedRows(rows, options);

  return trackedRows.reduce<ResourceSnapshot>(
    (accumulator, row) => {
      accumulator.totalRssKb += row.rssKb;
      accumulator.totalCpuPercent += row.cpuPercent;
      accumulator.processCount += 1;
      return accumulator;
    },
    {
      totalRssKb: 0,
      totalCpuPercent: 0,
      processCount: 0,
    },
  );
}

function kbToMb(kb: number): number {
  return Number((kb / 1024).toFixed(1));
}

function normalizeCpuPercent(cpuPercent: number): number {
  return Number(cpuPercent.toFixed(1));
}

function bytesToMb(bytes: number): number {
  return Number((bytes / (1024 * 1024)).toFixed(1));
}

function createStageSnapshot({
  options,
  stage,
  metadata,
}: {
  options: ResourceMonitorOptions;
  stage: string;
  metadata?: Record<string, unknown>;
}): StageResourceSnapshot {
  const tracked = buildSnapshot(options);
  const memoryUsage = process.memoryUsage();
  const systemFreeMb = bytesToMb(os.freemem());
  const systemUsedApproxMb = bytesToMb(os.totalmem() - os.freemem());

  return {
    timestamp: new Date().toISOString(),
    stage,
    processRssMb: kbToMb(tracked.totalRssKb),
    processHeapMb: bytesToMb(memoryUsage.heapUsed),
    trackedProcessCount: tracked.processCount,
    systemUsedApproxMb,
    systemFreeMb,
    metadata,
  };
}

export function captureResourceStageSnapshot({
  options,
  stage,
  metadata,
}: {
  options: ResourceMonitorOptions;
  stage: string;
  metadata?: Record<string, unknown>;
}): StageResourceSnapshot {
  return createStageSnapshot({ options, stage, metadata });
}

export function createJobResourceMonitor(options: ResourceMonitorOptions) {
  const startedAt = Date.now();
  let intervalId: NodeJS.Timeout | undefined;
  let peakRssKb = 0;
  let peakCpuPercent = 0;
  let peakProcessCount = 0;
  let monitoringError: string | undefined;

  const sample = (): void => {
    try {
      const snapshot = buildSnapshot(options);
      peakRssKb = Math.max(peakRssKb, snapshot.totalRssKb);
      peakCpuPercent = Math.max(peakCpuPercent, snapshot.totalCpuPercent);
      peakProcessCount = Math.max(peakProcessCount, snapshot.processCount);
    } catch (error) {
      monitoringError =
        error instanceof Error
          ? error.message
          : 'No se pudo muestrear el uso de recursos del job.';
    }
  };

  sample();
  intervalId = setInterval(sample, 1000);

  return {
    captureStage(stage: string, metadata?: Record<string, unknown>): StageResourceSnapshot {
      return createStageSnapshot({ options, stage, metadata });
    },
    async stop(): Promise<JobResourceSummary> {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = undefined;
      }

      let finalSnapshot: ResourceSnapshot = {
        totalRssKb: 0,
        totalCpuPercent: 0,
        processCount: 0,
      };

      try {
        finalSnapshot = buildSnapshot(options);
        peakRssKb = Math.max(peakRssKb, finalSnapshot.totalRssKb);
        peakCpuPercent = Math.max(peakCpuPercent, finalSnapshot.totalCpuPercent);
        peakProcessCount = Math.max(peakProcessCount, finalSnapshot.processCount);
      } catch (error) {
        if (!monitoringError) {
          monitoringError =
            error instanceof Error
              ? error.message
              : 'No se pudo tomar la métrica final de recursos del job.';
        }
      }

      return {
        durationMs: Date.now() - startedAt,
        peakRssMb: kbToMb(peakRssKb),
        peakCpuPercent: normalizeCpuPercent(peakCpuPercent),
        finalRssMb: kbToMb(finalSnapshot.totalRssKb),
        finalCpuPercent: normalizeCpuPercent(finalSnapshot.totalCpuPercent),
        peakProcessCount,
        finalProcessCount: finalSnapshot.processCount,
        monitoringError,
      };
    },
  };
}
