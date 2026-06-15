import { useEffect, useState } from 'react';
import { getSystemMemory, type SystemMemoryResponse } from '../api';

interface SystemMemoryWidgetProps {
  visible: boolean;
}

export function SystemMemoryWidget({ visible }: SystemMemoryWidgetProps) {
  const [memory, setMemory] = useState<SystemMemoryResponse | null>(null);

  useEffect(() => {
    if (!visible) {
      return;
    }

    let cancelled = false;

    const poll = async () => {
      try {
        const data = await getSystemMemory();
        if (!cancelled) {
          setMemory(data);
        }
      } catch {
        // silent — no queremos romper la UI por un fallo de métricas
      }
    };

    void poll();
    const id = window.setInterval(() => void poll(), 2000);

    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [visible]);

  if (!visible || !memory) {
    return null;
  }

  const barColor =
    memory.usedPercent >= 85
      ? 'var(--danger)'
      : memory.usedPercent >= 70
        ? 'var(--warning)'
        : 'var(--success)';

  return (
    <section className="panel system-memory-widget">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Sistema</p>
          <h2>RAM del sistema</h2>
        </div>
        <span className="memory-badge" style={{ color: barColor }}>
          {memory.usedPercent}%
        </span>
      </div>

      <div className="memory-bar-track">
        <div
          className="memory-bar-fill"
          style={{ width: `${memory.usedPercent}%`, background: barColor }}
        />
      </div>

      <div className="memory-stats">
        <span>
          <strong>{memory.usedMb.toLocaleString()}</strong> MB usados
        </span>
        <span>
          <strong>{memory.freeMb.toLocaleString()}</strong> MB libres
        </span>
        <span className="memory-total">
          {memory.totalMb.toLocaleString()} MB total
        </span>
      </div>
    </section>
  );
}
