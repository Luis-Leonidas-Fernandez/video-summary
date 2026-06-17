import { useCallback, useEffect, useState } from 'react';
import { getHealth, type HealthResponse } from '../api';

export function useRuntimeHealth() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  const refreshHealth = useCallback(async (): Promise<void> => {
    try {
      const nextHealth = await getHealth();
      setHealth(nextHealth);
      setHealthError(null);
    } catch (nextError) {
      setHealthError(nextError instanceof Error ? nextError.message : 'No se pudo consultar el runtime de IA.');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    void refreshHealth();
    const intervalId = window.setInterval(() => {
      void (async () => {
        try {
          const nextHealth = await getHealth();
          if (cancelled) {
            return;
          }

          setHealth(nextHealth);
          setHealthError(null);
        } catch (nextError) {
          if (cancelled) {
            return;
          }

          setHealthError(nextError instanceof Error ? nextError.message : 'No se pudo consultar el runtime de IA.');
        }
      })();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [refreshHealth]);

  return {
    health,
    healthError,
    refreshHealth,
  };
}
