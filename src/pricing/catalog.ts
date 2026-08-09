import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import type { RateQuote } from "../call-accounting/ledger";
import { resolveProvider } from "../call-accounting/fingerprint";
import { bundledRates, type CatalogRate } from "./bundled-rates";
import { loadPricingOverrides } from "./overrides";
import { remoteCatalogs, type RemoteCatalogDefinition } from "./remote-catalogs";

const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

interface StoredRate {
  cache_creation_nano_per_token: number;
  cache_read_nano_per_token: number;
  confidence: RateQuote["confidence"];
  effective_at_ms: number | null;
  input_nano_per_token: number;
  model_key: string;
  output_nano_per_token: number;
  rate_id: number;
  raw_alias: string | null;
  source_name: string;
}

interface LastSnapshot {
  etag: string | null;
  fetched_at_ms: number;
  snapshot_id: number;
}

export interface CatalogRefreshResult {
  error: string | null;
  rateCount: number;
  sourceName: string;
  status: "failed" | "not-modified" | "refreshed" | "skipped";
}

export class PricingCatalog {
  readonly #dataDirectory: string;
  readonly #database: Database;
  #lastRefreshResults: readonly CatalogRefreshResult[] = [];
  #refreshQueue: Promise<readonly CatalogRefreshResult[]> = Promise.resolve([]);

  constructor(database: Database, dataDirectory: string) {
    this.#database = database;
    this.#dataDirectory = dataDirectory;
  }

  async initialize(): Promise<void> {
    await mkdir(this.#dataDirectory, { recursive: true });
    this.#replaceStaticRates("bundled", bundledRates);
    const overrides = await loadPricingOverrides(join(this.#dataDirectory, "pricing-overrides.json"));
    this.#replaceStaticRates("user-override", overrides);
  }

  resolve(rawModel: string, timestampMs: number): RateQuote | null {
    const provider = resolveProvider(rawModel);
    const modelKey = modelKeyFromRawModel(rawModel);
    const rates = this.#database
      .query<StoredRate, [string, string, string, number]>(`
        SELECT
          rate.rate_id,
          rate.model_key,
          rate.raw_alias,
          rate.input_nano_per_token,
          rate.output_nano_per_token,
          rate.cache_read_nano_per_token,
          rate.cache_creation_nano_per_token,
          rate.source_name,
          rate.confidence,
          rate.effective_at_ms
        FROM model_rates AS rate
        LEFT JOIN pricing_snapshots AS snapshot ON snapshot.snapshot_id = rate.snapshot_id
        WHERE
          (rate.raw_alias = ? OR (rate.raw_alias IS NULL AND rate.provider = ? AND rate.model_key = ?))
          AND (rate.effective_at_ms IS NULL OR rate.effective_at_ms <= ?)
          AND (rate.snapshot_id IS NULL OR snapshot.is_last_good = 1)
          AND rate.is_active = 1
      `)
      .all(rawModel, provider, modelKey, timestampMs);
    const rate = rates.sort(compareRatePriority)[0];
    if (rate === undefined) {
      return null;
    }

    return {
      basis: describeRateBasis(rate),
      cacheCreationNanoPerToken: rate.cache_creation_nano_per_token,
      cacheReadNanoPerToken: rate.cache_read_nano_per_token,
      confidence: rate.confidence,
      inputNanoPerToken: rate.input_nano_per_token,
      outputNanoPerToken: rate.output_nano_per_token,
      rateId: rate.rate_id,
      resolvedModelKey: `${provider}/${rate.model_key}`,
    };
  }

  async refreshIfStale(): Promise<readonly CatalogRefreshResult[]> {
    return this.#enqueueRefresh(false);
  }

  async forceRefresh(): Promise<readonly CatalogRefreshResult[]> {
    return this.#enqueueRefresh(true);
  }

  async waitForRefreshes(): Promise<void> {
    await this.#refreshQueue;
  }

  getLastRefreshResults(): readonly CatalogRefreshResult[] {
    return this.#lastRefreshResults;
  }

  getNewestSnapshotTimestamp(): number | null {
    return this.#database
      .query<{ fetched_at_ms: number | null }, []>(
        "SELECT MAX(fetched_at_ms) AS fetched_at_ms FROM pricing_snapshots WHERE is_last_good = 1",
      )
      .get()?.fetched_at_ms ?? null;
  }

  async #refresh(force: boolean): Promise<readonly CatalogRefreshResult[]> {
    const results: CatalogRefreshResult[] = [];
    for (const catalog of remoteCatalogs) {
      results.push(await this.#refreshCatalog(catalog, force));
    }
    this.#lastRefreshResults = results;
    return results;
  }

  #enqueueRefresh(force: boolean): Promise<readonly CatalogRefreshResult[]> {
    const refresh = this.#refreshQueue.then(
      () => this.#refresh(force),
      () => this.#refresh(force),
    );
    this.#refreshQueue = refresh;
    return refresh;
  }

  async #refreshCatalog(
    catalog: RemoteCatalogDefinition,
    force: boolean,
  ): Promise<CatalogRefreshResult> {
    const lastSnapshot = this.#getLastSnapshot(catalog.name);
    if (
      !force
      && lastSnapshot !== null
      && Date.now() - lastSnapshot.fetched_at_ms < CATALOG_MAX_AGE_MS
    ) {
      return { error: null, rateCount: 0, sourceName: catalog.name, status: "skipped" };
    }

    try {
      const headers = new Headers({ Accept: "application/json" });
      if (lastSnapshot?.etag !== null && lastSnapshot?.etag !== undefined) {
        headers.set("If-None-Match", lastSnapshot.etag);
      }
      const response = await fetch(catalog.url, { headers, signal: AbortSignal.timeout(15_000) });
      if (response.status === 304 && lastSnapshot !== null) {
        this.#database
          .query("UPDATE pricing_snapshots SET fetched_at_ms = ? WHERE snapshot_id = ?")
          .run(Date.now(), lastSnapshot.snapshot_id);
        return { error: null, rateCount: 0, sourceName: catalog.name, status: "not-modified" };
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const content = await response.text();
      const rates = catalog.parse(JSON.parse(content));
      this.#storeRemoteSnapshot(catalog, content, response.headers.get("etag"), rates);
      await this.#writeLastGoodCatalog(catalog.name, content);
      return { error: null, rateCount: rates.length, sourceName: catalog.name, status: "refreshed" };
    } catch (error) {
      return {
        error: errorMessage(error),
        rateCount: 0,
        sourceName: catalog.name,
        status: "failed",
      };
    }
  }

  #getLastSnapshot(sourceName: string): LastSnapshot | null {
    return this.#database
      .query<LastSnapshot, [string]>(`
        SELECT snapshot_id, etag, fetched_at_ms
        FROM pricing_snapshots
        WHERE source_name = ? AND is_last_good = 1
        ORDER BY fetched_at_ms DESC
        LIMIT 1
      `)
      .get(sourceName);
  }

  #storeRemoteSnapshot(
    catalog: RemoteCatalogDefinition,
    content: string,
    etag: string | null,
    rates: readonly CatalogRate[],
  ): void {
    const contentHash = createHash("sha256").update(content).digest("hex");
    const storeSnapshot = this.#database.transaction(() => {
      this.#database
        .query("UPDATE pricing_snapshots SET is_last_good = 0 WHERE source_name = ?")
        .run(catalog.name);
      this.#database
        .query(`
          INSERT INTO pricing_snapshots (
            source_name, source_url, fetched_at_ms, etag, content_hash, is_last_good
          ) VALUES (?, ?, ?, ?, ?, 1)
          ON CONFLICT(source_name, content_hash) DO UPDATE SET
            fetched_at_ms = excluded.fetched_at_ms,
            etag = excluded.etag,
            is_last_good = 1
        `)
        .run(catalog.name, catalog.url, Date.now(), etag, contentHash);
      const snapshotId = this.#database
        .query<{ snapshot_id: number }, [string, string]>(`
          SELECT snapshot_id FROM pricing_snapshots
          WHERE source_name = ? AND content_hash = ?
        `)
        .get(catalog.name, contentHash)?.snapshot_id;
      if (snapshotId === undefined) {
        throw new Error(`Unable to persist ${catalog.name} pricing snapshot.`);
      }

      this.#database.query("DELETE FROM model_rates WHERE snapshot_id = ?").run(snapshotId);
      this.#insertRates(rates, snapshotId);
    });
    storeSnapshot();
  }

  #replaceStaticRates(sourceGroup: "bundled" | "user-override", rates: readonly CatalogRate[]): void {
    const replaceRates = this.#database.transaction(() => {
      if (sourceGroup === "bundled") {
        this.#database
          .query("UPDATE model_rates SET is_active = 0 WHERE snapshot_id IS NULL AND source_name LIKE 'bundled-%'")
          .run();
      } else {
        this.#database
          .query("UPDATE model_rates SET is_active = 0 WHERE snapshot_id IS NULL AND source_name = 'user-override'")
          .run();
      }
      for (const rate of rates) {
        const existingRateId = this.#database
          .query<{ rate_id: number }, [
            string,
            string,
            string | null,
            number,
            number,
            number,
            number,
            string,
            string,
            number | null,
          ]>(`
            SELECT rate_id
            FROM model_rates
            WHERE snapshot_id IS NULL
              AND provider = ?
              AND model_key = ?
              AND raw_alias IS ?
              AND input_nano_per_token = ?
              AND output_nano_per_token = ?
              AND cache_read_nano_per_token = ?
              AND cache_creation_nano_per_token = ?
              AND source_name = ?
              AND confidence = ?
              AND effective_at_ms IS ?
            ORDER BY created_at_ms DESC
            LIMIT 1
          `)
          .get(
            rate.provider,
            rate.modelKey,
            rate.rawAlias,
            rate.inputNanoPerToken,
            rate.outputNanoPerToken,
            rate.cacheReadNanoPerToken,
            rate.cacheCreationNanoPerToken,
            rate.sourceName,
            rate.confidence,
            rate.effectiveAtMs,
          )?.rate_id;
        if (existingRateId === undefined) {
          this.#insertRates([rate], null);
        } else {
          this.#database
            .query("UPDATE model_rates SET is_active = 1 WHERE rate_id = ?")
            .run(existingRateId);
        }
      }
    });
    replaceRates();
  }

  #insertRates(rates: readonly CatalogRate[], snapshotId: number | null): void {
    const insert = this.#database.query(`
      INSERT INTO model_rates (
        snapshot_id, provider, model_key, raw_alias, input_nano_per_token,
        output_nano_per_token, cache_read_nano_per_token, cache_creation_nano_per_token,
        source_name, confidence, effective_at_ms, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const createdAtMs = Date.now();
    for (const rate of rates) {
      insert.run(
        snapshotId,
        rate.provider,
        rate.modelKey,
        rate.rawAlias,
        rate.inputNanoPerToken,
        rate.outputNanoPerToken,
        rate.cacheReadNanoPerToken,
        rate.cacheCreationNanoPerToken,
        rate.sourceName,
        rate.confidence,
        rate.effectiveAtMs,
        createdAtMs,
      );
    }
  }

  async #writeLastGoodCatalog(sourceName: string, content: string): Promise<void> {
    const destination = join(this.#dataDirectory, `pricing-${sourceName}.json`);
    const temporaryPath = `${destination}.tmp`;
    await Bun.write(temporaryPath, content);
    await rename(temporaryPath, destination);
  }
}

function compareRatePriority(left: StoredRate, right: StoredRate): number {
  const sourceDifference = sourcePriority(left.source_name) - sourcePriority(right.source_name);
  if (sourceDifference !== 0) {
    return sourceDifference;
  }
  return (right.effective_at_ms ?? 0) - (left.effective_at_ms ?? 0);
}

function sourcePriority(sourceName: string): number {
  if (sourceName === "user-override") return 0;
  if (sourceName === "models.dev") return 1;
  if (sourceName === "litellm") return 2;
  return 3;
}

function describeRateBasis(rate: StoredRate): string {
  const cacheCreationNote = rate.confidence === "inferred"
    ? "; cache creation uses the normal input rate"
    : "";
  return `${rate.source_name}${cacheCreationNote}`;
}

function modelKeyFromRawModel(rawModel: string): string {
  const separatorIndex = rawModel.indexOf("/");
  return separatorIndex === -1 ? rawModel : rawModel.slice(separatorIndex + 1);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
