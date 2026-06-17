const { app, BrowserWindow, dialog } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const isDev = !app.isPackaged;
const rendererUrl = process.env.ELECTRON_RENDERER_URL || 'http://127.0.0.1:3000';
const backendPort = Number(process.env.VST_BACKEND_PORT || (isDev ? 3001 : 39091));
const backendOrigin = `http://127.0.0.1:${backendPort}`;
const startupTimeoutMs = 20_000;
const pollIntervalMs = 400;

let mainWindow = null;
let splashWindow = null;
let backendProcess = null;
let backendOwnedByDesktop = false;
let shuttingDown = false;

const userDataRoot = app.getPath('userData');
const logsDir = path.join(userDataRoot, 'logs');
const desktopLogPath = path.join(logsDir, 'desktop-main.log');
const knownDesktopPathEntries = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
];

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function appendDesktopLog(message) {
  ensureDir(logsDir);
  fs.appendFileSync(desktopLogPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
}

function projectRootDev() {
  return path.resolve(__dirname, '..');
}

function backendCwd() {
  return isDev
    ? path.join(projectRootDev(), 'backend')
    : path.join(process.resourcesPath, 'backend');
}

function frontendIndexPath() {
  return path.join(process.resourcesPath, 'frontend-dist', 'index.html');
}

function preloadPath() {
  return path.join(__dirname, 'preload.cjs');
}

function splashPath() {
  return path.join(__dirname, 'splash.html');
}

function backendEnv() {
  const currentPathEntries = String(process.env.PATH || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const mergedPathEntries = [...knownDesktopPathEntries, ...currentPathEntries]
    .filter((entry, index, all) => all.indexOf(entry) === index);

  return {
    ...process.env,
    PATH: mergedPathEntries.join(path.delimiter),
    VIDEO_STUDY_DESKTOP: 'true',
    PORT: String(backendPort),
    VIDEO_STUDY_OUTPUT_ROOT: path.join(userDataRoot, 'output'),
    VIDEO_STUDY_RUNTIME_DIR: path.join(userDataRoot, '.runtime'),
    VIDEO_STUDY_PROJECT_ROOT: userDataRoot,
  };
}

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 460,
    height: 320,
    frame: false,
    resizable: false,
    movable: true,
    fullscreenable: false,
    show: false,
    backgroundColor: '#08111f',
    webPreferences: {
      contextIsolation: true,
      sandbox: false,
    },
  });

  splashWindow.once('ready-to-show', () => splashWindow && splashWindow.show());
  splashWindow.loadFile(splashPath());
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 980,
    minWidth: 1120,
    minHeight: 760,
    show: false,
    backgroundColor: '#08111f',
    title: 'Video Study Tool',
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
      splashWindow = null;
    }
    mainWindow.show();
  });

  if (isDev) {
    mainWindow.loadURL(rendererUrl);
    return;
  }

  mainWindow.loadFile(frontendIndexPath());
}

async function isBackendHealthy() {
  try {
    const response = await fetch(`${backendOrigin}/api/health`);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForBackend() {
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    if (await isBackendHealthy()) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return false;
}

function startBackendProcess() {
  const cwd = backendCwd();
  const env = backendEnv();
  appendDesktopLog(`Backend PATH efectivo: ${env.PATH || '(vacío)'}`);

  if (isDev) {
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    backendProcess = spawn(npmCommand, ['run', 'dev'], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
  } else {
    const backendEntry = path.join(cwd, 'dist', 'index.js');
    backendProcess = spawn(process.execPath, [backendEntry], {
      cwd,
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
  }

  backendOwnedByDesktop = true;

  backendProcess.stdout.on('data', (chunk) => appendDesktopLog(`[backend:stdout] ${chunk.toString().trimEnd()}`));
  backendProcess.stderr.on('data', (chunk) => appendDesktopLog(`[backend:stderr] ${chunk.toString().trimEnd()}`));
  backendProcess.on('exit', (code, signal) => {
    appendDesktopLog(`backend terminó (${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`})`);
    backendProcess = null;
    if (!shuttingDown) {
      dialog.showErrorBox(
        'Backend detenido',
        'El backend local se cerró antes de tiempo. Mirá los logs de la app para más detalle.',
      );
      app.quit();
    }
  });
}

async function ensureBackendReady() {
  if (await isBackendHealthy()) {
    appendDesktopLog('Reutilizando backend ya disponible.');
    backendOwnedByDesktop = false;
    return;
  }

  appendDesktopLog('Levantando backend local para desktop shell.');
  startBackendProcess();
  const ready = await waitForBackend();
  if (!ready) {
    throw new Error('El backend no respondió a /api/health dentro del tiempo esperado.');
  }
}

async function shutdownBackend() {
  if (!backendOwnedByDesktop || !backendProcess || backendProcess.killed) {
    return;
  }

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        backendProcess.kill('SIGKILL');
      } catch {
        // ignore
      }
      resolve();
    }, 5_000);

    backendProcess.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });

    try {
      backendProcess.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function bootDesktopShell() {
  createSplashWindow();
  await ensureBackendReady();
  createMainWindow();
}

app.on('window-all-closed', async () => {
  if (process.platform !== 'darwin') {
    await app.quit();
  }
});

app.on('before-quit', async (event) => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  event.preventDefault();
  await shutdownBackend();
  app.exit(0);
});

app.whenReady()
  .then(async () => {
    appendDesktopLog('Inicializando desktop shell.');
    await bootDesktopShell();
  })
  .catch((error) => {
    appendDesktopLog(`Fallo de arranque desktop: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    dialog.showErrorBox(
      'No se pudo abrir Video Study Tool',
      error instanceof Error ? error.message : 'Error desconocido iniciando la app desktop.',
    );
    app.quit();
  });
