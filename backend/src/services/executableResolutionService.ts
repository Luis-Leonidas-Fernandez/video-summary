import path from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { appConfig } from '../config.js';

export type ExecutableResolutionSource = 'env' | 'path' | 'known_path' | 'missing';

export interface ExecutableResolution {
  key: 'ollama' | 'ffmpeg' | 'yt_dlp';
  binaryName: string;
  overrideEnvVar: 'OLLAMA_BINARY' | 'FFMPEG_BINARY' | 'YT_DLP_BINARY';
  configuredCommand: string;
  resolvedPath?: string;
  exists: boolean;
  source: ExecutableResolutionSource;
  searchedPaths: string[];
}

const KNOWN_SEARCH_DIRS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
];

function getPathEntries(): string[] {
  return (process.env.PATH ?? '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function uniquePaths(entries: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of entries) {
    if (seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    normalized.push(entry);
  }
  return normalized;
}

async function isExecutable(candidatePath: string): Promise<boolean> {
  try {
    await access(candidatePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveCandidateFromDirectories(commandName: string, directories: string[]): Promise<string | undefined> {
  for (const directory of directories) {
    const candidatePath = path.join(directory, commandName);
    if (await isExecutable(candidatePath)) {
      return candidatePath;
    }
  }

  return undefined;
}

async function resolveExecutableFromCommand(
  configuredCommand: string,
): Promise<{
  resolvedPath?: string;
  source: ExecutableResolutionSource;
  searchedPaths: string[];
}> {
  if (configuredCommand.includes('/')) {
    return {
      resolvedPath: (await isExecutable(configuredCommand)) ? configuredCommand : undefined,
      source: 'env',
      searchedPaths: [],
    };
  }

  const pathEntries = uniquePaths(getPathEntries());
  const knownEntries = uniquePaths(KNOWN_SEARCH_DIRS.filter((entry) => !pathEntries.includes(entry)));
  const searchedPaths = uniquePaths([...pathEntries, ...knownEntries]);

  const fromPath = await resolveCandidateFromDirectories(configuredCommand, pathEntries);
  if (fromPath) {
    return {
      resolvedPath: fromPath,
      source: 'path',
      searchedPaths,
    };
  }

  const fromKnownPath = await resolveCandidateFromDirectories(configuredCommand, knownEntries);
  if (fromKnownPath) {
    return {
      resolvedPath: fromKnownPath,
      source: 'known_path',
      searchedPaths,
    };
  }

  return {
    resolvedPath: undefined,
    source: 'missing',
    searchedPaths,
  };
}

async function resolveExecutableForKey(
  key: ExecutableResolution['key'],
  configuredCommand: string,
  binaryName: string,
  overrideEnvVar: ExecutableResolution['overrideEnvVar'],
): Promise<ExecutableResolution> {
  const resolved = await resolveExecutableFromCommand(configuredCommand);
  return {
    key,
    binaryName,
    overrideEnvVar,
    configuredCommand,
    resolvedPath: resolved.resolvedPath,
    exists: Boolean(resolved.resolvedPath),
    source: resolved.source,
    searchedPaths: resolved.searchedPaths,
  };
}

export async function resolveOllamaExecutable(): Promise<ExecutableResolution> {
  return resolveExecutableForKey('ollama', appConfig.ollamaBinary, 'ollama', 'OLLAMA_BINARY');
}

export async function resolveFfmpegExecutable(): Promise<ExecutableResolution> {
  return resolveExecutableForKey('ffmpeg', appConfig.ffmpegBinary, 'ffmpeg', 'FFMPEG_BINARY');
}

export async function resolveYtDlpExecutable(): Promise<ExecutableResolution> {
  return resolveExecutableForKey('yt_dlp', appConfig.ytDlpBinary, 'yt-dlp', 'YT_DLP_BINARY');
}

export function getEffectiveBackendPath(): string {
  return process.env.PATH ?? '';
}

export function formatSearchedPaths(paths: string[]): string {
  return paths.length > 0 ? paths.join(', ') : '(sin PATH configurado)';
}
