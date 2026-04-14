import {
  appendJsonLine,
  type JsonlFileOptions,
  readJsonLines,
  resolveActiveJsonlPath
} from './jsonl-writer.ts';

export class LiveIncidentJournal<T extends object = object> {
  private readonly basePath: string;
  private readonly options?: Omit<JsonlFileOptions, 'now'> & { now?: () => Date };

  constructor(path: string, options?: Omit<JsonlFileOptions, 'now'> & { now?: () => Date }) {
    this.basePath = path;
    this.options = options;
  }

  get path() {
    if (!this.options?.rotateDaily) {
      return this.basePath;
    }

    return resolveActiveJsonlPath(this.basePath, this.options.now?.() ?? new Date());
  }

  async append(entry: T): Promise<void> {
    await appendJsonLine(this.basePath, entry, {
      rotateDaily: this.options?.rotateDaily,
      retentionDays: this.options?.retentionDays,
      now: this.options?.now?.()
    });
  }

  async readAll(): Promise<T[]> {
    return readJsonLines<T>(this.path);
  }
}
