import path from 'node:path';
import { promises as fs } from 'node:fs';

interface RuntimeSessionState {
  pid?: number;
  startedAt?: string;
  ollamaStartedByDev?: boolean;
  ollamaStartedByBackend?: boolean;
}

const runtimeDir = process.env.VIDEO_STUDY_RUNTIME_DIR
  ? path.resolve(process.env.VIDEO_STUDY_RUNTIME_DIR)
  : path.resolve(process.cwd(), '..', '.runtime');
const runtimeStatePath = path.join(runtimeDir, 'dev-state.json');

async function ensureRuntimeDir(): Promise<void> {
  await fs.mkdir(runtimeDir, { recursive: true });
}

async function readRuntimeState(): Promise<RuntimeSessionState> {
  try {
    const raw = await fs.readFile(runtimeStatePath, 'utf8');
    return JSON.parse(raw) as RuntimeSessionState;
  } catch {
    return {};
  }
}

export async function updateRuntimeSessionState(
  patch: Partial<RuntimeSessionState>,
): Promise<void> {
  await ensureRuntimeDir();
  const current = await readRuntimeState();
  await fs.writeFile(
    runtimeStatePath,
    JSON.stringify(
      {
        ...current,
        ...patch,
      },
      null,
      2,
    ),
  );
}
