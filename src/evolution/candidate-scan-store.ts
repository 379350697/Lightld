import { appendJsonLine, readJsonLines } from '../journals/jsonl-writer.ts';
import { CandidateScanRecordSchema, type CandidateScanRecord } from './types.ts';

export class CandidateScanStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async appendScan(scan: CandidateScanRecord): Promise<void> {
    await appendJsonLine(this.path, CandidateScanRecordSchema.parse(scan));
  }

  async readAll(): Promise<CandidateScanRecord[]> {
    const rows = await readJsonLines<CandidateScanRecord>(this.path);
    return rows.map((row) => CandidateScanRecordSchema.parse(row));
  }
}
