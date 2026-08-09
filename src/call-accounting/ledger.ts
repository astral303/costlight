import type { Database } from "bun:sqlite";
import type { ParsedUsageRecord } from "../session-import/types";
import { createEventFingerprint, resolveProvider } from "./fingerprint";

export interface RateQuote {
  basis: string;
  cacheCreationNanoPerToken: number;
  cacheReadNanoPerToken: number;
  confidence: "exact" | "alias" | "inferred" | "override" | "bundled";
  inputNanoPerToken: number;
  outputNanoPerToken: number;
  rateId: number | null;
  resolvedModelKey: string;
}

export type RateResolver = (rawModel: string, timestampMs: number) => RateQuote | null;

interface OccurrenceIdentity {
  agentId: string;
  generation: number;
  sessionId: string;
  sourcePath: string;
}

interface StoredOccurrence {
  agent_id: string;
  byte_offset: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  generation: number;
  input_other_tokens: number;
  output_tokens: number;
  provider_request_id: string | null;
  raw_model: string;
  session_id: string;
  source_path: string;
  step_uuid: string | null;
  timestamp_ms: number;
}

interface StoredPricing {
  cache_creation_cost_nano: number | null;
  cache_read_cost_nano: number | null;
  input_cost_nano: number | null;
  output_cost_nano: number | null;
  pricing_basis: string;
  pricing_confidence: string;
  rate_id: number | null;
  resolved_model_key: string | null;
  total_cost_nano: number | null;
}

export class CallLedger {
  readonly #database: Database;
  readonly #resolveRate: RateResolver;

  constructor(database: Database, resolveRate: RateResolver = () => null) {
    this.#database = database;
    this.#resolveRate = resolveRate;
  }

  recordUsage(identity: OccurrenceIdentity, record: ParsedUsageRecord): boolean {
    const eventFingerprint = createEventFingerprint(record);
    const result = this.#database
      .query(`
        INSERT OR IGNORE INTO usage_occurrences (
          source_path, generation, byte_offset, event_fingerprint, timestamp_ms, raw_model,
          input_other_tokens, cache_creation_tokens, cache_read_tokens, output_tokens,
          session_id, agent_id, provider_request_id, step_uuid
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        identity.sourcePath,
        identity.generation,
        record.byteOffset,
        eventFingerprint,
        record.timestampMs,
        record.model,
        record.tokens.inputOther,
        record.tokens.cacheCreation,
        record.tokens.cacheRead,
        record.tokens.output,
        identity.sessionId,
        identity.agentId,
        record.providerRequestId,
        record.stepUuid,
      );

    if (result.changes > 0) {
      this.rebuildCanonicalCall(eventFingerprint);
      return true;
    }
    return false;
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

  private rebuildCanonicalCall(eventFingerprint: string, shouldReprice = false): void {
    const occurrences = this.#database
      .query<StoredOccurrence, [string]>(`
        SELECT
          occurrence.source_path,
          occurrence.generation,
          occurrence.byte_offset,
          occurrence.timestamp_ms,
          occurrence.raw_model,
          occurrence.input_other_tokens,
          occurrence.cache_creation_tokens,
          occurrence.cache_read_tokens,
          occurrence.output_tokens,
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

    const canonicalOccurrence = occurrences[0];
    if (canonicalOccurrence === undefined) {
      return;
    }

    this.#database
      .query(`
        UPDATE usage_occurrences
        SET is_canonical = 0,
            replay_classification = ?
        WHERE event_fingerprint = ?
      `)
      .run(
        canonicalOccurrence.provider_request_id === null ? "possible-replay" : "fork-replay",
        eventFingerprint,
      );
    this.#database
      .query(`
        UPDATE usage_occurrences
        SET is_canonical = 1,
            replay_classification = 'original'
        WHERE source_path = ? AND generation = ? AND byte_offset = ?
      `)
      .run(
        canonicalOccurrence.source_path,
        canonicalOccurrence.generation,
        canonicalOccurrence.byte_offset,
      );

    const storedPricing = shouldReprice
      ? null
      : this.#database
        .query<StoredPricing, [string]>(`
          SELECT
            resolved_model_key, input_cost_nano, cache_creation_cost_nano,
            cache_read_cost_nano, output_cost_nano, total_cost_nano, rate_id,
            pricing_confidence, pricing_basis
          FROM api_calls
          WHERE event_fingerprint = ?
        `)
        .get(eventFingerprint);
    const rateQuote = storedPricing === null
      ? this.#resolveRate(canonicalOccurrence.raw_model, canonicalOccurrence.timestamp_ms)
      : null;
    const costs = storedPricing === null
      ? calculateCosts(canonicalOccurrence, rateQuote)
      : {
        cacheCreation: storedPricing.cache_creation_cost_nano,
        cacheRead: storedPricing.cache_read_cost_nano,
        input: storedPricing.input_cost_nano,
        output: storedPricing.output_cost_nano,
        total: storedPricing.total_cost_nano,
      };
    this.#database
      .query(`
        INSERT INTO api_calls (
          event_fingerprint, canonical_source_path, canonical_generation, canonical_byte_offset,
          timestamp_ms, provider, raw_model, resolved_model_key,
          input_other_tokens, cache_creation_tokens, cache_read_tokens, output_tokens,
          session_id, agent_id, input_cost_nano, cache_creation_cost_nano,
          cache_read_cost_nano, output_cost_nano, total_cost_nano, rate_id,
          pricing_confidence, pricing_basis
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          pricing_basis = excluded.pricing_basis
      `)
      .run(
        eventFingerprint,
        canonicalOccurrence.source_path,
        canonicalOccurrence.generation,
        canonicalOccurrence.byte_offset,
        canonicalOccurrence.timestamp_ms,
        resolveProvider(canonicalOccurrence.raw_model),
        canonicalOccurrence.raw_model,
        storedPricing?.resolved_model_key ?? rateQuote?.resolvedModelKey ?? null,
        canonicalOccurrence.input_other_tokens,
        canonicalOccurrence.cache_creation_tokens,
        canonicalOccurrence.cache_read_tokens,
        canonicalOccurrence.output_tokens,
        canonicalOccurrence.session_id,
        canonicalOccurrence.agent_id,
        costs.input,
        costs.cacheCreation,
        costs.cacheRead,
        costs.output,
        costs.total,
        storedPricing?.rate_id ?? rateQuote?.rateId ?? null,
        storedPricing?.pricing_confidence ?? rateQuote?.confidence ?? "unpriced",
        storedPricing?.pricing_basis ?? rateQuote?.basis ?? "No matching rate",
      );
  }
}

function calculateCosts(occurrence: StoredOccurrence, rateQuote: RateQuote | null) {
  if (rateQuote === null) {
    return { cacheCreation: null, cacheRead: null, input: null, output: null, total: null };
  }

  const input = occurrence.input_other_tokens * rateQuote.inputNanoPerToken;
  const cacheCreation = occurrence.cache_creation_tokens * rateQuote.cacheCreationNanoPerToken;
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
