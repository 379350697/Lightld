import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  RunManifestStore,
  buildRunManifestV2,
  hashCanonicalValue,
  redactRuntimeConfig
} from '../../../src/runtime/run-manifest-v2';

describe('RunManifestV2', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('redacts secrets recursively while preserving reproducible non-secret configuration', () => {
    const redacted = redactRuntimeConfig({
      LIVE_AUTH_TOKEN: 'do-not-store',
      nested: {
        privateKey: 'do-not-store-either',
        quoteUrl: 'https://user:password@example.test/quote?token=secret&market=SOL'
      },
      maxPositionSol: 0.01
    });

    expect(redacted).toEqual({
      LIVE_AUTH_TOKEN: '[REDACTED]',
      maxPositionSol: 0.01,
      nested: {
        privateKey: '[REDACTED]',
        quoteUrl: 'https://redacted:redacted@example.test/quote?market=SOL&token=%5BREDACTED%5D'
      }
    });
    expect(JSON.stringify(redacted)).not.toContain('do-not-store');
    expect(JSON.stringify(redacted)).not.toContain('password');
  });

  it('hashes canonical values independently of object key insertion order', () => {
    expect(hashCanonicalValue({ b: 2, a: { y: 1, x: 0 } }))
      .toBe(hashCanonicalValue({ a: { x: 0, y: 1 }, b: 2 }));
    expect(hashCanonicalValue({ a: 1 })).toMatch(/^[a-f0-9]{64}$/);
  });

  it('builds a deterministic manifest snapshot around an injected run identity and git state', () => {
    const manifest = buildRunManifestV2({
      runId: '019f49c1-2058-7d53-a969-8efccb28628c',
      mode: 'mechanical-soak',
      gitCommit: '0123456789abcdef0123456789abcdef01234567',
      dirtyDiffSha256: 'a'.repeat(64),
      effectiveConfig: {
        authToken: 'secret',
        requestedPositionSol: 0.01
      },
      environment: {
        LIVE_AUTH_TOKEN: 'secret',
        LIVE_MAX_ACTIVE_POSITIONS: '1',
        IRRELEVANT_HOST_VALUE: 'ignored'
      },
      environmentBase: {
        nodeVersion: 'v24.0.0',
        platform: 'win32',
        arch: 'x64',
        osRelease: 'test'
      },
      datasetVersion: '2',
      candidateSnapshotId: 'candidate-snapshot-1',
      policyVariantId: 'baseline',
      startedAt: '2026-07-10T00:00:00.000Z'
    });

    expect(manifest).toMatchObject({
      schemaVersion: 2,
      runId: '019f49c1-2058-7d53-a969-8efccb28628c',
      mode: 'mechanical-soak',
      effectiveConfig: {
        authToken: '[REDACTED]',
        requestedPositionSol: 0.01
      },
      datasetVersion: '2',
      candidateSnapshotId: 'candidate-snapshot-1',
      policyVariantId: 'baseline',
      endedAt: null
    });
    expect(manifest.effectiveConfigSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.environmentFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(manifest)).not.toContain('secret');
    expect(JSON.stringify(manifest)).not.toContain('IRRELEVANT_HOST_VALUE');
  });

  it('stores the startup manifest immutably and records completion separately', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lightld-run-manifest-store-'));
    directories.push(root);
    const store = new RunManifestStore(root);
    const manifest = buildRunManifestV2({
      runId: '019f49c1-2058-7d53-a969-8efccb28628c',
      mode: 'live',
      gitCommit: '0123456789abcdef0123456789abcdef01234567',
      dirtyDiffSha256: '0'.repeat(64),
      effectiveConfig: { strategy: 'new-token-v1' },
      environment: {},
      environmentBase: { nodeVersion: 'v24', platform: 'win32', arch: 'x64', osRelease: 'test' },
      datasetVersion: '2',
      candidateSnapshotId: 'candidate-snapshot-1',
      policyVariantId: 'baseline',
      startedAt: '2026-07-10T00:00:00.000Z'
    });

    const paths = await store.create(manifest);
    await expect(
      store.complete('019f49c1-2058-7d53-a969-8efccb28628d', '2026-07-10T01:00:00.000Z')
    ).rejects.toThrow(/missing startup manifest/i);
    await expect(store.create(manifest)).resolves.toEqual(paths);
    await expect(store.create({ ...manifest, policyVariantId: 'changed' })).rejects.toThrow(/immutable/i);
    await store.complete(manifest.runId, '2026-07-10T01:00:00.000Z');
    await expect(store.complete(manifest.runId, '2026-07-10T01:00:00.000Z')).resolves.toBeDefined();
    await expect(store.complete(manifest.runId, '2026-07-10T02:00:00.000Z')).rejects.toThrow(/immutable/i);

    expect(JSON.parse(await readFile(paths.manifestPath, 'utf8'))).toEqual(manifest);
    expect(await store.readResolved(manifest.runId)).toMatchObject({
      ...manifest,
      endedAt: '2026-07-10T01:00:00.000Z'
    });
  });
});
