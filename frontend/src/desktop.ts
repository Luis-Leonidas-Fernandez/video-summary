export interface DesktopBridge {
  isDesktop: boolean;
  platform: string;
  backendOrigin: string;
}

declare global {
  interface Window {
    videoStudyDesktop?: DesktopBridge;
  }
}

export function getDesktopBridge(): DesktopBridge | null {
  return window.videoStudyDesktop ?? null;
}

export function isDesktopApp(): boolean {
  return window.videoStudyDesktop?.isDesktop === true;
}

export function getBackendOrigin(): string {
  return window.videoStudyDesktop?.backendOrigin ?? '';
}

export function resolveApiUrl(input: string): string {
  if (/^https?:\/\//i.test(input)) {
    return input;
  }

  const backendOrigin = getBackendOrigin();
  if (!backendOrigin) {
    return input;
  }

  return new URL(input, backendOrigin).toString();
}
