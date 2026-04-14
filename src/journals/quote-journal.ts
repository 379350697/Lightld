import { appendJsonLine, readJsonLines } from './jsonl-writer.ts';

export class QuoteJournal<T extends object = object> {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async append(entry: T): Promise<void> {
    await appendJsonLine(this.path, entry);
  }

  async readAll(): Promise<T[]> {
    return readJsonLines<T>(this.path);
  }
}
