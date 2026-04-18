import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { appendJsonLine, readJsonLines } from '../journals/jsonl-writer.ts';
import {
  PoolDecisionSampleRecordArraySchema,
  PoolDecisionSampleRecordSchema,
  type PoolDecisionSampleRecord
} from './types.ts';

export class PoolDecisionSampleStore {
  constructor(private readonly path: string) {}

  async append(sample: PoolDecisionSampleRecord): Promise<void> {
    await appendJsonLine(this.path, PoolDecisionSampleRecordSchema.parse(sample));
  }

  async writeAll(samples: PoolDecisionSampleRecord[]): Promise<void> {
    const parsed = PoolDecisionSampleRecordArraySchema.parse(samples);
    const content = parsed.map((sample) => JSON.stringify(sample)).join('\n');
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, content.length > 0 ? `${content}\n` : '', 'utf8');
  }

  async readAll(): Promise<PoolDecisionSampleRecord[]> {
    const rows = await readJsonLines<PoolDecisionSampleRecord>(this.path);
    return rows.map((row) => PoolDecisionSampleRecordSchema.parse(row));
  }
}
