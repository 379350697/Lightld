import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { z } from 'zod';

import { stableNormalize, stableStringify } from '../shared/canonical-json.ts';

const execFileAsync = promisify(execFile);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_COMMIT_PATTERN = /^[a-f0-9]{40,64}$/;
const RUNTIME_ENV_PREFIX_PATTERN = /^(LIVE_|SOLANA_|GMGN_|JUPITER_|METEORA_|LIGHTLD_|NODE_)/;
const SENSITIVE_KEY_PATTERN = /(?:^|_)(?:auth|authorization|bearer|access_token|refresh_token|api_key|secret|password|passphrase|private_key|keypair|mnemonic|seed|credential|cookie)(?:$|_)/i;
const SENSITIVE_CAMEL_KEY_PATTERN = /(?:authToken|accessToken|refreshToken|apiKey|privateKey|keypair|mnemonic|passphrase|password|secret|credential|cookie)/i;
const SENSITIVE_QUERY_KEY_PATTERN = /^(?:token|auth|authorization|key|api_key|secret|password|signature)$/i;

export const RunModeV2Schema = z.enum(['mechanical-soak', 'economic-shadow', 'canary', 'live']);

export const RunManifestV2Schema = z.object({
  schemaVersion: z.literal(2),
  runId: z.string().uuid(),
  mode: RunModeV2Schema,
  gitCommit: z.string().regex(GIT_COMMIT_PATTERN),
  dirtyDiffSha256: z.string().regex(SHA256_PATTERN),
  effectiveConfigSha256: z.string().regex(SHA256_PATTERN),
  effectiveConfig: z.record(z.string(), z.unknown()),
  environmentFingerprint: z.string().regex(SHA256_PATTERN),
  datasetVersion: z.string().min(1),
  candidateSnapshotId: z.string().min(1),
  policyVariantId: z.string().min(1),
  startedAt: z.string().datetime(),
  endedAt: z.null()
}).strict();

export const RunCompletionV2Schema = z.object({
  schemaVersion: z.literal(2),
  runId: z.string().uuid(),
  endedAt: z.string().datetime()
}).strict();

export type RunModeV2 = z.infer<typeof RunModeV2Schema>;
export type RunManifestV2 = z.infer<typeof RunManifestV2Schema>;
export type RunCompletionV2 = z.infer<typeof RunCompletionV2Schema>;

type EnvironmentBase = {
  nodeVersion: string;
  platform: string;
  arch: string;
  osRelease: string;
};

type GitMetadata = {
  gitCommit: string;
  dirtyDiffSha256: string;
};

export function hashCanonicalValue(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function redactRuntimeConfig(value: unknown, key = ''): unknown {
  if (isSensitiveKey(key)) {
    return '[REDACTED]';
  }

  if (value === undefined) {
    return null;
  }

  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return typeof value === 'string' ? sanitizeUrlIfNeeded(value) : value;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactRuntimeConfig(entry));
  }

  if (typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((result, childKey) => {
        result[childKey] = redactRuntimeConfig((value as Record<string, unknown>)[childKey], childKey);
        return result;
      }, {});
  }

  return String(value);
}

export function selectRuntimeEnvironment(
  environment: Record<string, string | undefined>
): Record<string, unknown> {
  return Object.keys(environment)
    .filter((key) => RUNTIME_ENV_PREFIX_PATTERN.test(key))
    .sort()
    .reduce<Record<string, unknown>>((result, key) => {
      result[key] = redactRuntimeConfig(environment[key], key);
      return result;
    }, {});
}

export function parseRunModeV2(value: string | undefined): RunModeV2 {
  return RunModeV2Schema.parse(value ?? 'live');
}

export function buildRunManifestV2(input: {
  runId?: string;
  mode: RunModeV2;
  gitCommit: string;
  dirtyDiffSha256: string;
  effectiveConfig: Record<string, unknown>;
  environment?: Record<string, string | undefined>;
  environmentBase?: EnvironmentBase;
  datasetVersion: string;
  candidateSnapshotId: string;
  policyVariantId: string;
  startedAt?: string;
}): RunManifestV2 {
  const effectiveConfig = redactRuntimeConfig(input.effectiveConfig) as Record<string, unknown>;
  const environmentBase = input.environmentBase ?? {
    nodeVersion: process.version,
    platform: platform(),
    arch: arch(),
    osRelease: release()
  };
  const environmentFingerprintInput = stableNormalize({
    ...environmentBase,
    runtimeEnvironment: selectRuntimeEnvironment(input.environment ?? process.env)
  });

  return RunManifestV2Schema.parse({
    schemaVersion: 2,
    runId: input.runId ?? randomUUID(),
    mode: input.mode,
    gitCommit: input.gitCommit.toLowerCase(),
    dirtyDiffSha256: input.dirtyDiffSha256.toLowerCase(),
    effectiveConfigSha256: hashCanonicalValue(effectiveConfig),
    effectiveConfig,
    environmentFingerprint: hashCanonicalValue(environmentFingerprintInput),
    datasetVersion: input.datasetVersion,
    candidateSnapshotId: input.candidateSnapshotId,
    policyVariantId: input.policyVariantId,
    startedAt: input.startedAt ?? new Date().toISOString(),
    endedAt: null
  });
}

export async function collectGitMetadata(worktreeRoot = process.cwd()): Promise<GitMetadata> {
  const cwd = resolve(worktreeRoot);
  const options = { cwd, encoding: 'utf8' as const, maxBuffer: 64 * 1024 * 1024 };
  const [{ stdout: commitOutput }, { stdout: trackedDiff }, { stdout: untrackedOutput }] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD'], options),
    execFileAsync('git', ['diff', '--binary', '--no-ext-diff', 'HEAD', '--', '.'], options),
    execFileAsync('git', ['ls-files', '--others', '--exclude-standard', '-z'], options)
  ]);
  const gitCommit = commitOutput.trim().toLowerCase();
  if (!GIT_COMMIT_PATTERN.test(gitCommit)) {
    throw new Error(`Unable to capture a valid git commit for RunManifestV2: ${gitCommit || 'empty output'}`);
  }

  const digest = createHash('sha256');
  digest.update('tracked-diff\0');
  digest.update(trackedDiff);

  const untrackedPaths = untrackedOutput.split('\0').filter(Boolean).sort();
  for (const relativePath of untrackedPaths) {
    const contents = await readFile(join(cwd, relativePath));
    digest.update('\0untracked-path\0');
    digest.update(relativePath.replaceAll('\\', '/'));
    digest.update('\0untracked-content\0');
    digest.update(contents);
  }

  return {
    gitCommit,
    dirtyDiffSha256: digest.digest('hex')
  };
}

export class RunManifestStore {
  private readonly rootDir: string;

  constructor(stateRootDir: string) {
    this.rootDir = join(stateRootDir, 'run-manifests');
  }

  pathsFor(runId: string) {
    const runDir = join(this.rootDir, runId);
    return {
      runDir,
      manifestPath: join(runDir, 'run-manifest.json'),
      completionPath: join(runDir, 'run-completion.json')
    };
  }

  async create(input: RunManifestV2) {
    const manifest = RunManifestV2Schema.parse(input);
    const paths = this.pathsFor(manifest.runId);
    await mkdir(paths.runDir, { recursive: true });
    await writeImmutableJson(paths.manifestPath, manifest, RunManifestV2Schema);
    return paths;
  }

  async complete(runId: string, endedAt = new Date().toISOString()) {
    const completion = RunCompletionV2Schema.parse({ schemaVersion: 2, runId, endedAt });
    const paths = this.pathsFor(runId);
    if (!(await this.read(runId))) {
      throw new Error(`Cannot complete run ${runId}: missing startup manifest`);
    }
    await mkdir(paths.runDir, { recursive: true });
    await writeImmutableJson(paths.completionPath, completion, RunCompletionV2Schema);
    return paths;
  }

  async read(runId: string): Promise<RunManifestV2 | null> {
    return readSchemaFile(this.pathsFor(runId).manifestPath, RunManifestV2Schema);
  }

  async readResolved(runId: string): Promise<(Omit<RunManifestV2, 'endedAt'> & { endedAt: string | null }) | null> {
    const paths = this.pathsFor(runId);
    const manifest = await readSchemaFile(paths.manifestPath, RunManifestV2Schema);
    if (!manifest) {
      return null;
    }

    const completion = await readSchemaFile(paths.completionPath, RunCompletionV2Schema);
    return {
      ...manifest,
      endedAt: completion?.endedAt ?? null
    };
  }
}

export async function initializeDaemonRunManifest(input: {
  stateRootDir: string;
  mode: RunModeV2;
  effectiveConfig: Record<string, unknown>;
  environment?: Record<string, string | undefined>;
  datasetVersion: string;
  candidateSnapshotId: string;
  policyVariantId: string;
  worktreeRoot?: string;
  gitMetadata?: GitMetadata;
  runId?: string;
  startedAt?: string;
}) {
  const gitMetadata = input.gitMetadata ?? await collectGitMetadata(input.worktreeRoot);
  const manifest = buildRunManifestV2({
    runId: input.runId,
    mode: input.mode,
    ...gitMetadata,
    effectiveConfig: input.effectiveConfig,
    environment: input.environment,
    datasetVersion: input.datasetVersion,
    candidateSnapshotId: input.candidateSnapshotId,
    policyVariantId: input.policyVariantId,
    startedAt: input.startedAt
  });
  const store = new RunManifestStore(input.stateRootDir);
  const paths = await store.create(manifest);

  return { manifest, store, paths };
}

function isSensitiveKey(key: string) {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return SENSITIVE_KEY_PATTERN.test(normalized) || SENSITIVE_CAMEL_KEY_PATTERN.test(key);
}

function sanitizeUrlIfNeeded(value: string) {
  if (!/^https?:\/\//i.test(value)) {
    return value;
  }

  try {
    const url = new URL(value);
    if (url.username) url.username = 'redacted';
    if (url.password) url.password = 'redacted';
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveKey(key) || SENSITIVE_QUERY_KEY_PATTERN.test(key)) {
        url.searchParams.set(key, '[REDACTED]');
      }
    }
    url.searchParams.sort();
    return url.toString();
  } catch {
    return '[REDACTED_INVALID_URL]';
  }
}

async function writeImmutableJson<T>(
  path: string,
  value: T,
  schema: z.ZodType<T>
): Promise<T> {
  const parsed = schema.parse(value);

  try {
    await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }

  const existing = await readSchemaFile(path, schema);
  if (existing && stableStringify(existing) === stableStringify(parsed)) {
    return existing;
  }

  throw new Error(`Run manifest record is immutable and already exists at ${path}`);
}

async function readSchemaFile<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    return schema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}
