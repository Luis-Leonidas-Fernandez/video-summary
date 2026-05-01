import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';

export interface RunCommandOptions {
  command: string;
  args: string[];
  cwd?: string;
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
  const { command, args, cwd, onStdout, onStderr } = options;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (chunk) => {
      void Promise.resolve(onStdout?.(chunk.toString())).catch(reject);
    });

    child.stderr.on('data', (chunk) => {
      void Promise.resolve(onStderr?.(chunk.toString())).catch(reject);
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Command failed: ${command} ${args.join(' ')} (exit code ${code ?? 'unknown'})`));
    });
  });
}
