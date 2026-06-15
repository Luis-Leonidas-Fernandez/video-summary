import type { JobResourceUsage, ResourceUsageScope } from '../api';

interface JobResourceUsagePanelProps {
  resourceUsage?: JobResourceUsage;
  scope?: ResourceUsageScope;
  batchWallClockMs?: number;
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
}

function getScopeLabel(scope?: ResourceUsageScope): string {
  switch (scope) {
    case 'batch_aggregate':
      return 'aggregate';
    case 'last_item':
      return 'last item';
    case 'single_item':
      return 'single item';
    default:
      return 'unknown';
  }
}

export function JobResourceUsagePanel({ resourceUsage, scope, batchWallClockMs }: JobResourceUsagePanelProps) {
  if (!resourceUsage) {
    return null;
  }

  return (
    <section className="panel resource-panel resource-panel-muted">
      <div className="panel-header panel-header-top">
        <div>
          <p className="eyebrow">Diagnóstico</p>
          <h2>Uso de recursos del job</h2>
          <p className="panel-caption">Panel técnico secundario para memoria, CPU y procesos del pipeline.</p>
        </div>
        <span className="resource-badge resource-badge-muted">{getScopeLabel(scope)}</span>
      </div>

      <div className="resource-grid">
        <div className="resource-card resource-peak">
          <strong>Pico de RAM</strong>
          <p>{resourceUsage.peakRssMb} MB</p>
        </div>
        <div className="resource-card resource-peak">
          <strong>Pico de CPU</strong>
          <p>{resourceUsage.peakCpuPercent}%</p>
        </div>
        <div className="resource-card">
          <strong>RAM al final</strong>
          <p>{resourceUsage.finalRssMb} MB</p>
        </div>
        <div className="resource-card">
          <strong>CPU al final</strong>
          <p>{resourceUsage.finalCpuPercent}%</p>
        </div>
        <div className="resource-card">
          <strong>Pico de procesos</strong>
          <p>{resourceUsage.peakProcessCount}</p>
        </div>
        <div className="resource-card">
          <strong>Procesos al final</strong>
          <p>{resourceUsage.finalProcessCount}</p>
        </div>
        <div className="resource-card resource-duration">
          <strong>Duración monitoreada</strong>
          <p>{formatDuration(resourceUsage.durationMs)}</p>
        </div>
        {batchWallClockMs != null ? (
          <div className="resource-card resource-duration">
            <strong>Duración lote real</strong>
            <p>{formatDuration(batchWallClockMs)}</p>
          </div>
        ) : null}
      </div>

      {resourceUsage.monitoringError ? (
        <p className="resource-warning">
          Advertencia de monitoreo: {resourceUsage.monitoringError}
        </p>
      ) : null}
    </section>
  );
}
