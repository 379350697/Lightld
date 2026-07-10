import { createHash } from 'node:crypto';

import { stableStringify } from '../shared/canonical-json.ts';
import {
  CandidateOpportunityObservationV2Schema,
  OpportunityEpisodeV2Schema,
  type CandidateOpportunityObservationV2,
  type OpportunityEpisodeV2
} from './types.ts';

const LABEL_WINDOW_MS = 24 * 60 * 60 * 1000;
const REQUALIFICATION_GAP_MS = 60 * 60 * 1000;

type EpisodeState = {
  episode: OpportunityEpisodeV2;
  ineligibleSinceMs: number | null;
};

export function buildNonOverlappingOpportunityEpisodes(
  observations: CandidateOpportunityObservationV2[]
): OpportunityEpisodeV2[] {
  const parsed = observations
    .map((observation) => CandidateOpportunityObservationV2Schema.parse(observation))
    .sort(compareObservations);
  const stateByIdentity = new Map<string, EpisodeState>();
  const signatureByObservationPoint = new Map<string, string>();
  const episodes: OpportunityEpisodeV2[] = [];

  for (const observation of parsed) {
    const identity = identityKey(observation);
    const observationPoint = `${identity}\u0000${observation.observedAt}`;
    const observationSignature = stableStringify({ ...observation, observationId: undefined });
    const existingSignature = signatureByObservationPoint.get(observationPoint);
    if (existingSignature !== undefined) {
      if (existingSignature !== observationSignature) {
        throw new Error(`Conflicting opportunity observations for ${observationPoint}.`);
      }
      continue;
    }
    signatureByObservationPoint.set(observationPoint, observationSignature);
    const observedAtMs = Date.parse(observation.observedAt);
    const current = stateByIdentity.get(identity);

    if (!current) {
      const episode = createEpisode(observation);
      episodes.push(episode);
      stateByIdentity.set(identity, {
        episode,
        ineligibleSinceMs: observation.eligible ? null : observedAtMs
      });
      continue;
    }

    const windowEndsAtMs = Date.parse(current.episode.labelWindowEndsAt);
    if (observedAtMs < windowEndsAtMs) {
      current.ineligibleSinceMs = observation.eligible
        ? null
        : (current.ineligibleSinceMs ?? observedAtMs);
      continue;
    }

    if (!observation.eligible && current.ineligibleSinceMs === null) {
      current.ineligibleSinceMs = observedAtMs;
    }

    const effectiveIneligibleStartMs = current.ineligibleSinceMs === null
      ? null
      : Math.max(current.ineligibleSinceMs, windowEndsAtMs);
    const requalificationSatisfied = effectiveIneligibleStartMs !== null
      && observedAtMs - effectiveIneligibleStartMs >= REQUALIFICATION_GAP_MS;

    if (!requalificationSatisfied) {
      if (observation.eligible) {
        current.ineligibleSinceMs = null;
      }
      continue;
    }

    const episode = createEpisode(observation);
    episodes.push(episode);
    stateByIdentity.set(identity, {
      episode,
      ineligibleSinceMs: observation.eligible ? null : observedAtMs
    });
  }

  return episodes.sort((left, right) => {
    const timeDifference = Date.parse(left.capturedAt) - Date.parse(right.capturedAt);
    return timeDifference !== 0 ? timeDifference : left.episodeId.localeCompare(right.episodeId);
  });
}

function compareObservations(
  left: CandidateOpportunityObservationV2,
  right: CandidateOpportunityObservationV2
) {
  const timeDifference = Date.parse(left.observedAt) - Date.parse(right.observedAt);
  if (timeDifference !== 0) {
    return timeDifference;
  }

  const identityDifference = identityKey(left).localeCompare(identityKey(right));
  return identityDifference !== 0
    ? identityDifference
    : left.observationId.localeCompare(right.observationId);
}

function identityKey(observation: CandidateOpportunityObservationV2) {
  return `${observation.strategyId}\u0000${observation.poolAddress}\u0000${observation.tokenMint}`;
}

function createEpisode(observation: CandidateOpportunityObservationV2): OpportunityEpisodeV2 {
  const capturedAtMs = Date.parse(observation.observedAt);
  const episodeIdentity = {
    schemaVersion: 2,
    strategyId: observation.strategyId,
    poolAddress: observation.poolAddress,
    tokenMint: observation.tokenMint,
    capturedAt: new Date(capturedAtMs).toISOString()
  };
  const digest = createHash('sha256')
    .update(stableStringify(episodeIdentity))
    .digest('hex')
    .slice(0, 32);

  return OpportunityEpisodeV2Schema.parse({
    schemaVersion: 2,
    episodeId: `episode-v2-${digest}`,
    capturedAt: new Date(capturedAtMs).toISOString(),
    labelWindowEndsAt: new Date(capturedAtMs + LABEL_WINDOW_MS).toISOString(),
    runId: observation.runId,
    strategyId: observation.strategyId,
    tokenMint: observation.tokenMint,
    tokenSymbol: observation.tokenSymbol,
    poolAddress: observation.poolAddress,
    deployerAddress: observation.deployerAddress,
    configSnapshotId: observation.configSnapshotId,
    policyVariantId: observation.policyVariantId,
    eligible: observation.eligible,
    selected: observation.selected,
    hardRejectionReasons: observation.hardRejectionReasons,
    softRejectionReasons: observation.softRejectionReasons,
    pointInTimeFeatures: observation.pointInTimeFeatures,
    sourceObservations: observation.sourceObservations
  });
}
