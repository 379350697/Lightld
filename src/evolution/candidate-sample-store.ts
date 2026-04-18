import { readJsonLines, appendJsonLine } from '../journals/jsonl-writer.ts';
import { CandidateSampleRecordSchema, type CandidateSampleRecord } from './types.ts';

export class CandidateSampleStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async append(sample: CandidateSampleRecord): Promise<void> {
    await appendJsonLine(this.path, CandidateSampleRecordSchema.parse(sample));
  }

  async readAll(): Promise<CandidateSampleRecord[]> {
    const rows = await readJsonLines<CandidateSampleRecord>(this.path);
    return rows.map((row) => CandidateSampleRecordSchema.parse(row));
  }
}
