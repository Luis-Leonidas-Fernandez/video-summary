import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';

export interface RunCommandOptions {
  command: string;
  args: string[];
  cwd?: string;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void | Promise<void>;
  onStderr?: (chunk: string) => void | Promise<void>;
}

export async function checkCommandAvailable(command: string): Promise<boolean> {
  if (command.includes('/')) {
    try {
      await access(command, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  return new Promise((resolve) => {
    const child = spawn('which', [command]);
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

export async function runCommand(options: RunCommandOptions): Promise<void> {
  const { command, args, cwd, signal, onStdout, onStderr } = options;

  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(`Command aborted: ${command} ${args.join(' ')}`));
      return;
    }

    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (killTimer) {
        clearTimeout(killTimer);
      }
      if (signal && abortListener) {
        signal.removeEventListener('abort', abortListener);
      }
    };

    const failOnce = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const abortListener = signal
      ? () => {
          try {
            child.kill('SIGTERM');
          } catch {
            // no-op
          }
          killTimer = setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              // no-op
            }
          }, 1_500);
          failOnce(new Error(`Command aborted: ${command} ${args.join(' ')}`));
        }
      : undefined;

    if (signal && abortListener) {
      signal.addEventListener('abort', abortListener, { once: true });
    }

    child.stdout.on('data', (chunk) => {
      void Promise.resolve(onStdout?.(chunk.toString())).catch((error) => {
        failOnce(error instanceof Error ? error : new Error(String(error)));
      });
    });

    child.stderr.on('data', (chunk) => {
      void Promise.resolve(onStderr?.(chunk.toString())).catch((error) => {
        failOnce(error instanceof Error ? error : new Error(String(error)));
      });
    });

    child.on('error', (error) => {
      failOnce(error);
    });

    child.on('close', (code) => {
      if (settled) {
        cleanup();
        return;
      }

      settled = true;
      cleanup();
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Command failed: ${command} ${args.join(' ')} (exit code ${code ?? 'unknown'})`));
    });
  });
}
