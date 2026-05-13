import type { JobResourceUsage } from '../api';

interface JobResourceUsagePanelProps {
  resourceUsage?: JobResourceUsage;
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

export function JobResourceUsagePanel({ resourceUsage }: JobResourceUsagePanelProps) {
  if (!resourceUsage) {
    return null;
  }

  return (
    <section className="panel resource-panel">
      <div className="panel-header">
        <h2>Uso de recursos del job</h2>
        <span className="resource-badge">VISIBLE</span>
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
      </div>

      {resourceUsage.monitoringError ? (
        <p className="resource-warning">
          Advertencia de monitoreo: {resourceUsage.monitoringError}
        </p>
      ) : null}
    </section>
  );
}
