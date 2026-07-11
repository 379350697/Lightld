import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { ZodType } from 'zod';

import { readJsonLines } from '../journals/jsonl-writer.ts';
import { stableStringify } from '../shared/canonical-json.ts';
import {
  CandidateOpportunityObservationV2Schema,
  ExecutableMarkV2Schema,
  ExperimentRegistryV2Schema,
  OpportunityEpisodeV2Schema,
  ValidationReportV2Schema,
  type CandidateOpportunityObservationV2,
  type ExecutableMarkV2,
  type ExperimentRegistryV2,
  type OpportunityEpisodeV2,
  type ValidationReportV2
} from './types.ts';

type ImmutableIdentity<T> = {
  primaryKey: (record: T) => string;
  secondaryKey?: (record: T) => string;
  secondaryDescription?: string;
};

class ImmutableJsonlStore<T> {
  constructor(
    private readonly path: string,
    private readonly schema: ZodType<T>,
    private readonly identity: ImmutableIdentity<T>
  ) {}

  async append(record: T): Promise<void> {
    const parsed = this.schema.parse(record);
    const rows = await this.readAll();
    const primaryKey = this.identity.primaryKey(parsed);
    const existing = rows.find((row) => this.identity.primaryKey(row) === primaryKey);

    if (existing) {
      if (stableStringify(existing) === stableStringify(parsed)) {
        return;
      }
      throw new Error(`Immutable conflict for key ${primaryKey}.`);
    }

    if (this.identity.secondaryKey) {
      const secondaryKey = this.identity.secondaryKey(parsed);
      const secondaryExisting = rows.find((row) => this.identity.secondaryKey?.(row) === secondaryKey);
      if (secondaryExisting) {
        throw new Error(
          `Immutable conflict: ${this.identity.secondaryDescription ?? 'secondary identity'} ${secondaryKey}.`
        );
      }
    }

    await appendResearchJsonLine(this.path, parsed);
  }

  async readAll(): Promise<T[]> {
    const rows = await readJsonLines<unknown>(this.path);
    return rows.map((row) => this.schema.parse(row));
  }
}

async function appendResearchJsonLine(path: string, record: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${stableStringify(record)}\n`, 'utf8');
}

export class OpportunityEpisodeV2Store {
  private readonly store: ImmutableJsonlStore<OpportunityEpisodeV2>;

  constructor(path: string) {
    this.store = new ImmutableJsonlStore(path, OpportunityEpisodeV2Schema, {
      primaryKey: (record) => record.episodeId
    });
  }

  append(record: OpportunityEpisodeV2) {
    return this.store.append(record);
  }

  readAll() {
    return this.store.readAll();
  }
}

/** Immutable pre-filter universe; episodes are derived offline from this log. */
export class CandidateOpportunityObservationV2Store {
  private readonly store: ImmutableJsonlStore<CandidateOpportunityObservationV2>;

  constructor(path: string) {
    this.store = new ImmutableJsonlStore(path, CandidateOpportunityObservationV2Schema, {
      primaryKey: (record) => record.observationId
    });
  }

  append(record: CandidateOpportunityObservationV2) {
    return this.store.append(record);
  }

  readAll() {
    return this.store.readAll();
  }
}

export class ExecutableMarkV2Store {
  private readonly store: ImmutableJsonlStore<ExecutableMarkV2>;

  constructor(path: string) {
    this.store = new ImmutableJsonlStore(path, ExecutableMarkV2Schema, {
      primaryKey: (record) => record.markId,
      secondaryKey: (record) => `${record.episodeId}:${record.horizon}`,
      secondaryDescription: 'episode and horizon'
    });
  }

  append(record: ExecutableMarkV2) {
    return this.store.append(record);
  }

  readAll() {
    return this.store.readAll();
  }
}

export class ExperimentRegistryV2Store {
  private readonly store: ImmutableJsonlStore<ExperimentRegistryV2>;

  constructor(path: string) {
    this.store = new ImmutableJsonlStore(path, ExperimentRegistryV2Schema, {
      primaryKey: (record) => record.hypothesisId
    });
  }

  register(record: ExperimentRegistryV2) {
    return this.store.append(record);
  }

  readAll() {
    return this.store.readAll();
  }
}

export class ValidationReportV2Store {
  private readonly store: ImmutableJsonlStore<ValidationReportV2>;

  constructor(path: string) {
    this.store = new ImmutableJsonlStore(path, ValidationReportV2Schema, {
      primaryKey: (record) => record.reportId
    });
  }

  append(record: ValidationReportV2) {
    return this.store.append(record);
  }

  readAll() {
    return this.store.readAll();
  }
}
