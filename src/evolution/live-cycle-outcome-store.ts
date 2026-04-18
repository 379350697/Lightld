import { appendJsonLine, readJsonLines } from '../journals/jsonl-writer.ts';
import { LiveCycleOutcomeRecordSchema, type LiveCycleOutcomeRecord } from './types.ts';

export class LiveCycleOutcomeStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async appendOutcome(record: LiveCycleOutcomeRecord): Promise<void> {
    await appendJsonLine(this.path, LiveCycleOutcomeRecordSchema.parse(record));
  }

  async readAll(): Promise<LiveCycleOutcomeRecord[]> {
    const rows = await readJsonLines<LiveCycleOutcomeRecord>(this.path);
    return rows.map((row) => LiveCycleOutcomeRecordSchema.parse(row));
  }
}
