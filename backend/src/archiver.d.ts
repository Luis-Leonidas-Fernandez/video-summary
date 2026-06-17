declare module 'archiver' {
  export class ZipArchive {
    constructor(options?: unknown);
    on(event: string, listener: (...args: any[]) => void): this;
    pipe(destination: NodeJS.WritableStream): NodeJS.WritableStream;
    file(filepath: string, data: { name: string }): this;
    append(source: string | Buffer, data: { name: string }): this;
    abort(): void;
    finalize(): Promise<void>;
  }
}
