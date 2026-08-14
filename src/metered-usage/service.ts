import type { Database } from "bun:sqlite";
import type { MeteringResolver } from "../call-accounting/ledger";
import { detectClaudeAccount, type ClaudeAccountDetector } from "./account-status";
import {
  assignMetering,
  type AccountStateForMetering,
  policyForSubscription,
  type ProMeteredModelClassifier,
} from "./policy";

const ANTHROPIC_PROVIDER = "anthropic";
const ACCOUNT_STATUS_MAX_AGE_MS = 5 * 60 * 1_000;

interface StoredAccountState {
  account_state_id: number;
  policy: AccountStateForMetering["policy"];
  subscription_type: string;
}

interface StoredProviderStatus {
  last_attempt_at_ms: number;
}

export interface MeteringRefreshResult {
  affectedFingerprints: readonly string[];
  didDetectAccount: boolean;
  error: string | null;
}

export interface ClaudeMeteringStatus {
  detectedAtMs: number | null;
  error: string | null;
  lastAttemptAtMs: number | null;
  lastSuccessAtMs: number | null;
  policy: AccountStateForMetering["policy"] | null;
  subscriptionType: string | null;
}

interface MeteredUsageServiceOptions {
  detectAccount?: ClaudeAccountDetector;
  isProMeteredModel: ProMeteredModelClassifier;
  now?: () => number;
}

export class MeteredUsageService {
  readonly #database: Database;
  readonly #detectAccount: ClaudeAccountDetector;
  readonly #isProMeteredModel: ProMeteredModelClassifier;
  readonly #now: () => number;
  #refreshQueue: Promise<MeteringRefreshResult> = Promise.resolve({
    affectedFingerprints: [],
    didDetectAccount: false,
    error: null,
  });

  constructor(database: Database, options: MeteredUsageServiceOptions) {
    this.#database = database;
    this.#detectAccount = options.detectAccount ?? detectClaudeAccount;
    this.#isProMeteredModel = options.isProMeteredModel;
    this.#now = options.now ?? Date.now;
  }

  readonly resolveMetering: MeteringResolver = (provider, rawModel, timestampMs) => {
    const accountState = provider === ANTHROPIC_PROVIDER
      ? this.#findAccountState(timestampMs)
      : null;
    return assignMetering(provider, rawModel, accountState, this.#isProMeteredModel);
  };

  refreshClaudeAccount(force = false): Promise<MeteringRefreshResult> {
    const refresh = this.#refreshQueue.then(
      () => this.#refreshClaudeAccount(force),
      () => this.#refreshClaudeAccount(force),
    );
    this.#refreshQueue = refresh;
    return refresh;
  }

  getClaudeStatus(): ClaudeMeteringStatus {
    const row = this.#database
      .query<{
        detected_at_ms: number | null;
        last_attempt_at_ms: number | null;
        last_error: string | null;
        last_success_at_ms: number | null;
        policy: AccountStateForMetering["policy"] | null;
        subscription_type: string | null;
      }, []>(`
        SELECT state.detected_at_ms, status.last_attempt_at_ms, status.last_success_at_ms,
               status.last_error, state.policy, state.subscription_type
        FROM metering_provider_status AS status
        LEFT JOIN metering_account_states AS state
          ON state.account_state_id = status.current_account_state_id
        WHERE status.provider = 'anthropic'
      `)
      .get();
    return {
      detectedAtMs: row?.detected_at_ms ?? null,
      error: row?.last_error ?? null,
      lastAttemptAtMs: row?.last_attempt_at_ms ?? null,
      lastSuccessAtMs: row?.last_success_at_ms ?? null,
      policy: row?.policy ?? null,
      subscriptionType: row?.subscription_type ?? null,
    };
  }

  async #refreshClaudeAccount(force: boolean): Promise<MeteringRefreshResult> {
    const nowMs = this.#now();
    const storedStatus = this.#database
      .query<StoredProviderStatus, []>(`
        SELECT last_attempt_at_ms
        FROM metering_provider_status
        WHERE provider = 'anthropic'
      `)
      .get();
    if (
      !force
      && storedStatus !== null
      && nowMs - storedStatus.last_attempt_at_ms < ACCOUNT_STATUS_MAX_AGE_MS
    ) {
      return { affectedFingerprints: [], didDetectAccount: false, error: null };
    }

    try {
      const detected = await this.#detectAccount();
      const accountStateId = this.#recordSuccessfulDetection(detected.subscriptionType, nowMs);
      const affectedFingerprints = this.#assignUnclassifiedClaudeOccurrences(accountStateId);
      return { affectedFingerprints, didDetectAccount: true, error: null };
    } catch (error) {
      const message = errorMessage(error);
      this.#recordDetectionFailure(nowMs, message);
      const affectedFingerprints = this.#assignUnclassifiedClaudeOccurrences(null);
      return { affectedFingerprints, didDetectAccount: false, error: message };
    }
  }

  #recordSuccessfulDetection(subscriptionType: string, nowMs: number): number {
    const currentState = this.#database
      .query<StoredAccountState, []>(`
        SELECT state.account_state_id, state.policy, state.subscription_type
        FROM metering_provider_status AS status
        JOIN metering_account_states AS state
          ON state.account_state_id = status.current_account_state_id
        WHERE status.provider = 'anthropic'
      `)
      .get();
    const store = this.#database.transaction((): number => {
      let accountStateId = currentState?.account_state_id;
      if (currentState?.subscription_type === subscriptionType) {
        this.#database.query(`
          UPDATE metering_account_states
          SET last_confirmed_at_ms = ?
          WHERE account_state_id = ?
        `).run(nowMs, currentState.account_state_id);
      } else {
        const hasPriorState = this.#database
          .query<{ count: number }, []>(`
            SELECT COUNT(*) AS count
            FROM metering_account_states
            WHERE provider = 'anthropic'
          `)
          .get()?.count ?? 0;
        const insertion = this.#database.query(`
          INSERT INTO metering_account_states (
            provider, subscription_type, policy, effective_from_ms,
            detected_at_ms, last_confirmed_at_ms, provenance
          ) VALUES ('anthropic', ?, ?, ?, ?, ?, ?)
        `).run(
          subscriptionType,
          policyForSubscription(subscriptionType),
          hasPriorState === 0 ? 0 : nowMs,
          nowMs,
          nowMs,
          hasPriorState === 0 ? "current-state-backfill" : "detected-change",
        );
        accountStateId = Number(insertion.lastInsertRowid);
      }

      if (accountStateId === undefined) {
        throw new Error("Claude account state was not persisted.");
      }

      this.#database.query(`
        INSERT INTO metering_provider_status (
          provider, current_account_state_id, last_attempt_at_ms,
          last_success_at_ms, last_error
        ) VALUES ('anthropic', ?, ?, ?, NULL)
        ON CONFLICT(provider) DO UPDATE SET
          current_account_state_id = excluded.current_account_state_id,
          last_attempt_at_ms = excluded.last_attempt_at_ms,
          last_success_at_ms = excluded.last_success_at_ms,
          last_error = NULL
      `).run(accountStateId, nowMs, nowMs);
      return accountStateId;
    });
    return store();
  }

  #recordDetectionFailure(nowMs: number, message: string): void {
    this.#database.query(`
      INSERT INTO metering_provider_status (
        provider, current_account_state_id, last_attempt_at_ms,
        last_success_at_ms, last_error
      ) VALUES ('anthropic', NULL, ?, NULL, ?)
      ON CONFLICT(provider) DO UPDATE SET
        last_attempt_at_ms = excluded.last_attempt_at_ms,
        last_error = excluded.last_error
    `).run(nowMs, message);
  }

  #assignUnclassifiedClaudeOccurrences(
    detectedAccountStateId: number | null,
  ): readonly string[] {
    const occurrences = this.#database
      .query<{
        byte_offset: number;
        event_fingerprint: string;
        generation: number;
        raw_model: string;
        source_path: string;
        timestamp_ms: number;
      }, []>(`
        SELECT source_path, generation, byte_offset, event_fingerprint,
               timestamp_ms, raw_model
        FROM usage_occurrences
        WHERE provider = 'anthropic' AND account_state_id IS NULL
      `)
      .all();
    if (occurrences.length === 0) {
      return [];
    }

    const fingerprints = new Set<string>();
    const update = this.#database.query(`
      UPDATE usage_occurrences
      SET account_state_id = ?, is_metered = ?, metering_basis = ?
      WHERE source_path = ? AND generation = ? AND byte_offset = ?
    `);
    const assign = this.#database.transaction(() => {
      for (const occurrence of occurrences) {
        const accountState = this.#findAccountState(occurrence.timestamp_ms)
          ?? this.#findAccountStateById(detectedAccountStateId);
        const assignment = assignMetering(
          ANTHROPIC_PROVIDER,
          occurrence.raw_model,
          accountState,
          this.#isProMeteredModel,
        );
        update.run(
          assignment.accountStateId,
          assignment.isMetered ? 1 : 0,
          assignment.basis,
          occurrence.source_path,
          occurrence.generation,
          occurrence.byte_offset,
        );
        fingerprints.add(occurrence.event_fingerprint);
      }
    });
    assign();
    return [...fingerprints];
  }

  #findAccountState(timestampMs: number): AccountStateForMetering | null {
    const state = this.#database
      .query<StoredAccountState, [number]>(`
        SELECT account_state_id, policy, subscription_type
        FROM metering_account_states
        WHERE provider = 'anthropic' AND effective_from_ms <= ?
        ORDER BY effective_from_ms DESC
        LIMIT 1
      `)
      .get(timestampMs);
    return state === null ? null : mapAccountState(state);
  }

  #findAccountStateById(accountStateId: number | null): AccountStateForMetering | null {
    if (accountStateId === null) return null;
    const state = this.#database
      .query<StoredAccountState, [number]>(`
        SELECT account_state_id, policy, subscription_type
        FROM metering_account_states
        WHERE account_state_id = ?
      `)
      .get(accountStateId);
    return state === null ? null : mapAccountState(state);
  }
}

function mapAccountState(state: StoredAccountState): AccountStateForMetering {
  return {
    accountStateId: state.account_state_id,
    policy: state.policy,
    subscriptionType: state.subscription_type,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
