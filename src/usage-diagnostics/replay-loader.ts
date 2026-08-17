import type { Database } from "bun:sqlite";

const ANTHROPIC_PROVIDER = "anthropic";

/** A type alias rather than an interface: only aliases satisfy the `CsvRow` index signature. */
export type ReplayClassificationRow = {
  canonical: number;
  fork_replay: number;
  possible_replay: number;
  raw_model: string;
  superseded: number;
  utc_day: string;
};

/**
 * Occurrences per day and model, split by how the ledger classified each one. Occurrences rather
 * than calls: a shortfall caused by over-eager deduplication shows up here as replays the audit
 * excluded, which the canonical counts alone would hide.
 */
export function loadReplayClassifications(
  database: Database,
  fromDate: string,
  toDate: string,
): readonly ReplayClassificationRow[] {
  return database.query(`
    SELECT
      date(timestamp_ms / 1000, 'unixepoch') AS utc_day,
      raw_model,
      SUM(replay_classification = 'original')         AS canonical,
      SUM(replay_classification = 'fork-replay')      AS fork_replay,
      SUM(replay_classification = 'possible-replay')  AS possible_replay,
      SUM(replay_classification = 'superseded-usage') AS superseded
    FROM usage_occurrences
    WHERE provider = $provider
      AND is_metered = 1
      AND date(timestamp_ms / 1000, 'unixepoch') BETWEEN $from AND $to
    GROUP BY utc_day, raw_model
    ORDER BY utc_day, raw_model
  `).all({
    from: fromDate,
    provider: ANTHROPIC_PROVIDER,
    to: toDate,
  }) as ReplayClassificationRow[];
}
