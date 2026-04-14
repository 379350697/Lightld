import { rm } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { appendJsonLine, readJsonLines } from '../../../src/journals/jsonl-writer';

describe('jsonl writer', () => {
  it('appends and reads JSONL records', async () => {
    const path = 'tmp/journals/test-jsonl.jsonl';
    await rm(path, { force: true });

    await appendJsonLine(path, { id: 'one' });
    await appendJsonLine(path, { id: 'two' });

    await expect(readJsonLines<{ id: string }>(path)).resolves.toEqual([
      { id: 'one' },
      { id: 'two' }
    ]);
  });

  it('drops empty fields while preserving meaningful values', async () => {
    const path = 'tmp/journals/test-jsonl-compact.jsonl';
    await rm(path, { force: true });

    await appendJsonLine(path, {
      id: 'one',
      emptyString: '',
      optional: undefined,
      nested: {
        keep: 0,
        drop: ''
      },
      emptyObject: {},
      emptyArray: []
    });

    await expect(readJsonLines<Record<string, unknown>>(path)).resolves.toEqual([
      {
        id: 'one',
        nested: {
          keep: 0
        }
      }
    ]);
  });
});
