import type { Database } from "bun:sqlite";
import type { ParsedUsageRecord } from "../session-import/types";
import { createEventFingerprint, resolveProvider } from "./fingerprint";

export interface RateQuote {
  basis: string;
  cacheCreation1hNanoPerToken: number;
  cacheCreation5mNanoPerToken: number;
  cacheCreationNanoPerToken: number;
  cacheReadNanoPerToken: number;
  confidence: "exact" | "alias" | "inferred" | "override" | "bundled";
  inputNanoPerToken: number;
  outputNanoPerToken: number;
  rateId: number | null;
  resolvedModelKey: string;
}

export type RateResolver = (rawModel: string, timestampMs: number) => RateQuote | null;

export interface CallPricing {
  resolve: RateResolver;
  resolveByRateId: (rateId: number) => RateQuote | null;
}

export interface MeteringAssignment {
  accountStateId: number | null;
  basis: string;
  isMetered: boolean;
}

export type MeteringResolver = (
  provider: string,
  rawModel: string,
  timestampMs: number,
) => MeteringAssignment;

interface OccurrenceIdentity {
  agentId: string;
  generation: number;
  sessionId: string;
  sourcePath: string;
}

interface StoredOccurrence {
  account_state_id: number | null;
  agent_id: string;
  byte_offset: number;
  cache_creation_1h_tokens: number;
  cache_creation_5m_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  generation: number;
  input_other_tokens: number;
  is_metered: number;
  metering_basis: string;
  output_tokens: number;
  provider: string;
  provider_request_id: string | null;
  raw_model: string;
  session_id: string;
  source_path: string;
  step_uuid: string | null;
  timestamp_ms: number;
}

interface StoredPricing {
  cache_creation_1h_tokens: number;
  cache_creation_5m_tokens: number;
  cache_creation_cost_nano: number | null;
  cache_creation_tokens: number;
  cache_read_cost_nano: number | null;
  cache_read_tokens: number;
  input_cost_nano: number | null;
  input_other_tokens: number;
  output_cost_nano: number | null;
  output_tokens: number;
  pricing_basis: string;
  pricing_confidence: string;
  rate_id: number | null;
  resolved_model_key: string | null;
  total_cost_nano: number | null;
}

export class CallLedger {
  readonly #database: Database;
  readonly #pricing: CallPricing;
  readonly #resolveMetering: MeteringResolver;

  constructor(
    database: Database,
    pricing: CallPricing = unpricedCallPricing,
    resolveMetering: MeteringResolver = meterEveryCall,
  ) {
    this.#database = database;
    this.#pricing = pricing;
    this.#resolveMetering = resolveMetering;
  }

  recordUsage(identity: OccurrenceIdentity, record: ParsedUsageRecord): boolean {
    const storeOccurrence = this.#database.transaction(() => {
      const eventFingerprint = createEventFingerprint(record);
      const provider = resolveProvider(record.model);
      const metering = this.#resolveMetering(provider, record.model, record.timestampMs);
      const result = this.#database
        .query(`
          INSERT OR IGNORE INTO usage_occurrences (
            source_path, generation, byte_offset, event_fingerprint, timestamp_ms,
            provider, raw_model, input_other_tokens, cache_creation_tokens,
            cache_creation_5m_tokens, cache_creation_1h_tokens, cache_read_tokens,
            output_tokens, session_id, agent_id, provider_request_id, step_uuid,
            account_state_id, is_metered, metering_basis
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          identity.sourcePath,
          identity.generation,
          record.byteOffset,
          eventFingerprint,
          record.timestampMs,
          provider,
          record.model,
          record.tokens.inputOther,
          record.tokens.cacheCreation,
          record.tokens.cacheCreation5m,
          record.tokens.cacheCreation1h,
          record.tokens.cacheRead,
          record.tokens.output,
          identity.sessionId,
          identity.agentId,
          record.providerRequestId,
          record.stepUuid,
          metering.accountStateId,
          metering.isMetered ? 1 : 0,
          metering.basis,
        );

      if (result.changes === 0) {
        return false;
      }
      this.rebuildCanonicalCall(eventFingerprint);
      return true;
    });
    return storeOccurrence();
  }

  removeSourceOccurrences(sourcePath: string): number {
    const fingerprints = this.#database
      .query<{ event_fingerprint: string }, [string]>(
        "SELECT DISTINCT event_fingerprint FROM usage_occurrences WHERE source_path = ?",
      )
      .all(sourcePath)
      .map(({ event_fingerprint }) => event_fingerprint);
    const result = this.#database
      .query("DELETE FROM usage_occurrences WHERE source_path = ?")
      .run(sourcePath);

    for (const fingerprint of fingerprints) {
      this.rebuildCanonicalCall(fingerprint);
    }
    return result.changes;
  }

  repriceAllCalls(): void {
    const fingerprints = this.#database
      .query<{ event_fingerprint: string }, []>("SELECT event_fingerprint FROM api_calls")
      .all();
    for (const { event_fingerprint } of fingerprints) {
      this.rebuildCanonicalCall(event_fingerprint, true);
    }
  }

  priceUnpricedCalls(): void {
    const fingerprints = this.#database
      .query<{ event_fingerprint: string }, []>(`
        SELECT event_fingerprint FROM api_calls WHERE pricing_confidence = 'unpriced'
      `)
      .all();
    for (const { event_fingerprint } of fingerprints) {
      this.rebuildCanonicalCall(event_fingerprint, true);
    }
  }

  rebuildSessionCanonicalCalls(sessionId: string): void {
    const fingerprints = this.#database
      .query<{ event_fingerprint: string }, [string]>(`
        SELECT DISTINCT event_fingerprint
        FROM usage_occurrences
        WHERE session_id = ?
      `)
      .all(sessionId);
    for (const { event_fingerprint } of fingerprints) {
      this.rebuildCanonicalCall(event_fingerprint);
    }
  }

  rebuildCanonicalCalls(eventFingerprints: Iterable<string>): void {
    for (const eventFingerprint of eventFingerprints) {
      this.rebuildCanonicalCall(eventFingerprint);
    }
  }

  private rebuildCanonicalCall(eventFingerprint: string, shouldReprice = false): void {
    const occurrences = this.#database
      .query<StoredOccurrence, [string]>(`
        SELECT
          occurrence.account_state_id,
          occurrence.source_path,
          occurrence.generation,
          occurrence.byte_offset,
          occurrence.timestamp_ms,
          occurrence.provider,
          occurrence.raw_model,
          occurrence.input_other_tokens,
          occurrence.cache_creation_tokens,
          occurrence.cache_creation_5m_tokens,
          occurrence.cache_creation_1h_tokens,
          occurrence.cache_read_tokens,
          occurrence.output_tokens,
          occurrence.is_metered,
          occurrence.metering_basis,
          occurrence.session_id,
          occurrence.agent_id,
          occurrence.provider_request_id,
          occurrence.step_uuid
        FROM usage_occurrences AS occurrence
        LEFT JOIN sessions AS session ON session.session_id = occurrence.session_id
        WHERE occurrence.event_fingerprint = ?
        ORDER BY
          COALESCE(session.created_at_ms, occurrence.timestamp_ms),
          occurrence.source_path,
          occurrence.generation,
          occurrence.byte_offset
      `)
      .all(eventFingerprint);

    if (occurrences.length === 0) {
      this.#database.query("DELETE FROM api_calls WHERE event_fingerprint = ?").run(eventFingerprint);
      return;
    }

    const [attributionOccurrence, ...remainingOccurrences] = occurrences;
    if (attributionOccurrence === undefined) {
      throw new Error(`Canonical occurrence selection failed for ${eventFingerprint}.`);
    }
    const billableUsageOccurrence = selectBillableUsageOccurrence(
      [attributionOccurrence, ...remainingOccurrences],
      attributionOccurrence,
    );

    this.#database
      .query(`
        UPDATE usage_occurrences
        SET is_canonical = 0,
            replay_classification = ?
        WHERE event_fingerprint = ?
      `)
      .run(
        attributionOccurrence.provider_request_id === null ? "possible-replay" : "fork-replay",
        eventFingerprint,
      );
    this.#database
      .query(`
        UPDATE usage_occurrences
        SET replay_classification = 'superseded-usage'
        WHERE event_fingerprint = ? AND session_id = ? AND source_path = ?
      `)
      .run(
        eventFingerprint,
        attributionOccurrence.session_id,
        attributionOccurrence.source_path,
      );
    this.#database
      .query(`
        UPDATE usage_occurrences
        SET is_canonical = 1,
            replay_classification = 'original'
        WHERE source_path = ? AND generation = ? AND byte_offset = ?
      `)
      .run(
        attributionOccurrence.source_path,
        attributionOccurrence.generation,
        attributionOccurrence.byte_offset,
      );

    const storedPricing = shouldReprice
      ? null
      : this.#database
        .query<StoredPricing, [string]>(`
          SELECT
            resolved_model_key, input_cost_nano, cache_creation_cost_nano,
            cache_read_cost_nano, output_cost_nano, total_cost_nano, rate_id,
            pricing_confidence, pricing_basis, input_other_tokens,
            cache_creation_tokens, cache_creation_5m_tokens, cache_creation_1h_tokens,
            cache_read_tokens, output_tokens
          FROM api_calls
          WHERE event_fingerprint = ?
        `)
        .get(eventFingerprint);
    const hasUnchangedUsage = storedPricing !== null
      && usageMatches(storedPricing, billableUsageOccurrence);
    const rateQuote = storedPricing === null || shouldReprice
      ? this.#pricing.resolve(attributionOccurrence.raw_model, attributionOccurrence.timestamp_ms)
      : hasUnchangedUsage
        ? null
        : (storedPricing.rate_id === null
          ? null
          : this.#pricing.resolveByRateId(storedPricing.rate_id))
          ?? this.#pricing.resolve(
            attributionOccurrence.raw_model,
            attributionOccurrence.timestamp_ms,
          );
    const costs = storedPricing === null || !hasUnchangedUsage || shouldReprice
      ? calculateCosts(billableUsageOccurrence, rateQuote)
      : {
        cacheCreation: storedPricing.cache_creation_cost_nano,
        cacheRead: storedPricing.cache_read_cost_nano,
        input: storedPricing.input_cost_nano,
        output: storedPricing.output_cost_nano,
        total: storedPricing.total_cost_nano,
      };
    const keepStoredPricing = storedPricing !== null && hasUnchangedUsage && !shouldReprice;
    this.#database
      .query(`
        INSERT INTO api_calls (
          event_fingerprint, canonical_source_path, canonical_generation, canonical_byte_offset,
          timestamp_ms, provider, raw_model, resolved_model_key,
          input_other_tokens, cache_creation_tokens, cache_creation_5m_tokens,
          cache_creation_1h_tokens, cache_read_tokens, output_tokens,
          session_id, agent_id, input_cost_nano, cache_creation_cost_nano,
          cache_read_cost_nano, output_cost_nano, total_cost_nano, rate_id,
          pricing_confidence, pricing_basis, account_state_id, is_metered, metering_basis
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(event_fingerprint) DO UPDATE SET
          canonical_source_path = excluded.canonical_source_path,
          canonical_generation = excluded.canonical_generation,
          canonical_byte_offset = excluded.canonical_byte_offset,
          timestamp_ms = excluded.timestamp_ms,
          provider = excluded.provider,
          raw_model = excluded.raw_model,
          resolved_model_key = excluded.resolved_model_key,
          input_other_tokens = excluded.input_other_tokens,
          cache_creation_tokens = excluded.cache_creation_tokens,
          cache_creation_5m_tokens = excluded.cache_creation_5m_tokens,
          cache_creation_1h_tokens = excluded.cache_creation_1h_tokens,
          cache_read_tokens = excluded.cache_read_tokens,
          output_tokens = excluded.output_tokens,
          session_id = excluded.session_id,
          agent_id = excluded.agent_id,
          input_cost_nano = excluded.input_cost_nano,
          cache_creation_cost_nano = excluded.cache_creation_cost_nano,
          cache_read_cost_nano = excluded.cache_read_cost_nano,
          output_cost_nano = excluded.output_cost_nano,
          total_cost_nano = excluded.total_cost_nano,
          rate_id = excluded.rate_id,
          pricing_confidence = excluded.pricing_confidence,
          pricing_basis = excluded.pricing_basis,
          account_state_id = excluded.account_state_id,
          is_metered = excluded.is_metered,
          metering_basis = excluded.metering_basis
      `)
      .run(
        eventFingerprint,
        attributionOccurrence.source_path,
        attributionOccurrence.generation,
        attributionOccurrence.byte_offset,
        attributionOccurrence.timestamp_ms,
        attributionOccurrence.provider,
        attributionOccurrence.raw_model,
        keepStoredPricing ? storedPricing.resolved_model_key : rateQuote?.resolvedModelKey ?? null,
        billableUsageOccurrence.input_other_tokens,
        billableUsageOccurrence.cache_creation_tokens,
        billableUsageOccurrence.cache_creation_5m_tokens,
        billableUsageOccurrence.cache_creation_1h_tokens,
        billableUsageOccurrence.cache_read_tokens,
        billableUsageOccurrence.output_tokens,
        attributionOccurrence.session_id,
        attributionOccurrence.agent_id,
        costs.input,
        costs.cacheCreation,
        costs.cacheRead,
        costs.output,
        costs.total,
        keepStoredPricing ? storedPricing.rate_id : rateQuote?.rateId ?? null,
        keepStoredPricing
          ? storedPricing.pricing_confidence
          : rateQuote?.confidence ?? "unpriced",
        keepStoredPricing ? storedPricing.pricing_basis : rateQuote?.basis ?? "No matching rate",
        attributionOccurrence.account_state_id,
        attributionOccurrence.is_metered,
        attributionOccurrence.metering_basis,
      );
  }
}

const unpricedCallPricing: CallPricing = {
  resolve: () => null,
  resolveByRateId: () => null,
};

const meterEveryCall: MeteringResolver = () => ({
  accountStateId: null,
  basis: "metered-api",
  isMetered: true,
});

function calculateCosts(occurrence: StoredOccurrence, rateQuote: RateQuote | null) {
  if (rateQuote === null) {
    return { cacheCreation: null, cacheRead: null, input: null, output: null, total: null };
  }

  const input = occurrence.input_other_tokens * rateQuote.inputNanoPerToken;
  const cacheCreation = occurrence.cache_creation_tokens * rateQuote.cacheCreationNanoPerToken
    + occurrence.cache_creation_5m_tokens * rateQuote.cacheCreation5mNanoPerToken
    + occurrence.cache_creation_1h_tokens * rateQuote.cacheCreation1hNanoPerToken;
  const cacheRead = occurrence.cache_read_tokens * rateQuote.cacheReadNanoPerToken;
  const output = occurrence.output_tokens * rateQuote.outputNanoPerToken;
  return {
    cacheCreation,
    cacheRead,
    input,
    output,
    total: input + cacheCreation + cacheRead + output,
  };
}

function usageMatches(stored: StoredPricing, occurrence: StoredOccurrence): boolean {
  return stored.input_other_tokens === occurrence.input_other_tokens
    && stored.cache_creation_tokens === occurrence.cache_creation_tokens
    && stored.cache_creation_5m_tokens === occurrence.cache_creation_5m_tokens
    && stored.cache_creation_1h_tokens === occurrence.cache_creation_1h_tokens
    && stored.cache_read_tokens === occurrence.cache_read_tokens
    && stored.output_tokens === occurrence.output_tokens;
}

function selectBillableUsageOccurrence(
  occurrences: readonly [StoredOccurrence, ...StoredOccurrence[]],
  attributionOccurrence: StoredOccurrence,
): StoredOccurrence {
  validateCompatibleUsageOccurrences(occurrences, attributionOccurrence);

  // Progressive records normally culminate in one snapshot containing every earlier component.
  const componentMaximum = occurrences.find((candidate) => (
    occurrences.every((occurrence) => usageContains(candidate, occurrence))
  ));
  if (componentMaximum !== undefined) {
    return componentMaximum;
  }

  if (attributionOccurrence.provider === "anthropic") {
    // Claude appends revisions of one assistant message to the same transcript. If token
    // components cross, the last revision in the original transcript is the final snapshot.
    return occurrences
      .filter((occurrence) => (
        occurrence.session_id === attributionOccurrence.session_id
        && occurrence.source_path === attributionOccurrence.source_path
      ))
      .reduce(laterTranscriptOccurrence);
  }

  // Kimi emits one cumulative usage record per call. Contradictory copies have no defined
  // progression, so retain the original instead of synthesizing a larger call.
  return attributionOccurrence;
}

function validateCompatibleUsageOccurrences(
  occurrences: readonly StoredOccurrence[],
  attributionOccurrence: StoredOccurrence,
): void {
  const incompatible = occurrences.find((occurrence) => (
    occurrence.provider !== attributionOccurrence.provider
    || occurrence.raw_model !== attributionOccurrence.raw_model
  ));
  if (incompatible !== undefined) {
    throw new Error(
      "Usage records sharing one fingerprint disagree on provider or model: "
      + `${attributionOccurrence.provider}/${attributionOccurrence.raw_model} versus `
      + `${incompatible.provider}/${incompatible.raw_model}.`,
    );
  }
}

function laterTranscriptOccurrence(
  current: StoredOccurrence,
  candidate: StoredOccurrence,
): StoredOccurrence {
  if (candidate.generation !== current.generation) {
    return candidate.generation > current.generation ? candidate : current;
  }
  return candidate.byte_offset > current.byte_offset ? candidate : current;
}

function usageContains(candidate: StoredOccurrence, occurrence: StoredOccurrence): boolean {
  return candidate.input_other_tokens >= occurrence.input_other_tokens
    && candidate.cache_creation_tokens >= occurrence.cache_creation_tokens
    && candidate.cache_creation_5m_tokens >= occurrence.cache_creation_5m_tokens
    && candidate.cache_creation_1h_tokens >= occurrence.cache_creation_1h_tokens
    && candidate.cache_read_tokens >= occurrence.cache_read_tokens
    && candidate.output_tokens >= occurrence.output_tokens;
}
