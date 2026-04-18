import { rm } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  appendJsonLine,
  readJsonLines,
  readRotatedJsonTail
} from '../../../src/journals/jsonl-writer';

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

  it('reads the latest tail across rotated daily files', async () => {
    const path = 'tmp/journals/test-jsonl-rotated-tail.jsonl';
    await rm('tmp/journals', { recursive: true, force: true });

    await appendJsonLine(path, { id: 'day-1-a' }, {
      rotateDaily: true,
      now: new Date('2026-04-17T08:00:00.000Z')
    });
    await appendJsonLine(path, { id: 'day-1-b' }, {
      rotateDaily: true,
      now: new Date('2026-04-17T08:01:00.000Z')
    });
    await appendJsonLine(path, { id: 'day-2-a' }, {
      rotateDaily: true,
      now: new Date('2026-04-18T08:00:00.000Z')
    });

    await expect(readRotatedJsonTail<{ id: string }>(path, 2)).resolves.toEqual([
      { id: 'day-1-b' },
      { id: 'day-2-a' }
    ]);
  });
});
