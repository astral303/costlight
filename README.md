# Costlight

> Local, replay-safe metered API cost tracking for Kimi Code and Claude Code.

**Zero Telemetry. 100% Local.** Your usage data never leaves the machine. Costlight's only outbound requests fetch public model-pricing catalogs.

Costlight reads local Kimi Code and Claude Code usage records without modifying them, stores only derived usage metadata in SQLite, and serves the dashboard on loopback by default. It reconstructs metered API cost from recorded tokens and configured rates; it does not report invoice totals.

## Start Costlight

Prerequisite: [mise](https://mise.jdx.dev/) is installed.

```powershell
mise install
mise run start
```

Open <http://127.0.0.1:4637>. `mise run start` installs the locked dependencies, builds the frontend, imports current history, starts the watcher, and serves the production dashboard.
Press `Q` in the terminal to stop the dashboard cleanly. `Ctrl+C` remains supported.

Windows users can run the equivalent launcher:

```powershell
.\Start-Costlight.ps1
```

For frontend hot reload and automatic API restarts during development:

```powershell
mise run dev
```

## What the report means

- **Total API cost\*** includes one canonical, metered row per provider request. The asterisk means “Estimated from recorded tokens and configured rates.”
- **Inherited/replayed usage** remains inspectable but is never counted twice.
- **Main and subagent API cost** follows each provider's session and agent metadata.
- **Cache costs** remain separate for uncached input, 5-minute and 1-hour cache writes, cache reads, and output.
- **Unpriced calls** produce warnings and a blank cost, never a misleading `$0.00`.

Kimi calls are eligible for metered accounting. Claude eligibility follows the subscription type reported by `claude auth status`:

| Claude account | Calls included |
|---|---|
| Pro | Explicit Fable models only |
| Enterprise | All Claude calls with a known rate |
| Any other subscription | None |
| Status unavailable with no prior successful check | None |

The first successful check is documented as a current-state backfill. Later subscription changes affect only calls at or after the observed change; earlier calls retain their saved account snapshot and metering decision. A transient failure retains the last confirmed policy and appears as a warning.

Official provider billing exports remain the authority for reconciliation.

## Commands

| Command | Result |
|---|---|
| `mise run install` | Install the exact dependencies recorded in `bun.lock` |
| `mise run start` | Build and run the production dashboard |
| `mise run dev` | Run the API watcher and Vite development server |
| `bun run check:packages` | Reject floating dependency versions in `package.json` |
| `mise run check` | Run strict TypeScript checking |
| `mise run test` | Run unit, integration, and component tests |
| `mise run build` | Build the browser application into `dist/` |
| `mise run verify` | Run type-checking, tests, and the production build |
| `bun run import` | Import/reconcile history once and print aggregate diagnostics |
| `mise run analyze-cache` | Infer the Kimi cache inactivity window from all local wire logs |
| `bun run reprice` | Explicitly refresh rates and recalculate all historical calls |
| `bun run audit` | Compare Kimi and Claude totals with ccusage through Bun's package runner |
| `bun run audit:claude-usage` | Compare Claude totals with a usage export downloaded from Anthropic |

All JavaScript and TypeScript executables run through the mise-pinned Bun toolchain. `bun.lock` and `mise.lock` pin the resolved dependencies and Bun artifacts.

## Data sources and locations

The importer discovers current Kimi files under:

```text
~/.kimi-code/sessions/<workspace>/<session>/
├── state.json
└── agents/<agent-id>/wire.jsonl
```

It also checks `~/.kimi`, supports the legacy session-level `wire.jsonl` layout, and honors `KIMI_CODE_HOME` or `--kimi-root`.

Claude Code transcripts are discovered under:

```text
~/.claude/projects/<encoded-project>/
├── <session-id>.jsonl
└── <session-id>/subagents/agent-<id>.jsonl
```

Costlight honors `CLAUDE_CONFIG_DIR` or `--claude-root`. Missing provider directories are treated as empty, so either backend can be used independently.

Claude transcripts may repeat an assistant message while its usage fields are still being finalized or after a session is forked. Costlight attributes the call to its original session, uses the final compatible usage snapshot once, and keeps distinct 5-minute and 1-hour cache-write counts. Synthetic local messages and records with no billable tokens are ignored.

Claude transcript files do not identify whether a call used the subscription allowance or extra usage. The account policy above is therefore an explicit accounting rule: Pro includes only Fable, Enterprise includes all priced Claude calls, and unknown states are never inferred as metered.

Costlight runs `claude auth status` as an argument-array command with a bounded timeout. It stores only the normalized subscription type, effective detection interval, provenance, and latest check status. It does not read Claude's credential file or retain the command's raw response.

## Cache-window analysis

Run the cache analysis independently of the dashboard database:

```powershell
mise run analyze-cache
```

The current local-data conclusion and uncertainty are recorded in [CACHE_WINDOW_ANALYSIS.md](CACHE_WINDOW_ANALYSIS.md).

The command rebuilds canonical calls in memory, pairs each usage record with its client-side `llm.request` timestamp, and compares consecutive requests in the same session, agent, and model. A strong hit retains at least 90% of a large prior cached prefix. A strong miss moves most of the lost cached tokens into uncached input. Prompt-size changes, decreasing message counts, and changed system/tool hashes are excluded.

The report contains only aggregate counts and anonymized boundary examples. It does not retain prompts, responses, tool arguments, or tool output, and it does not modify Kimi logs or the dashboard database.

Default application-data directories are:

| Platform | Directory |
|---|---|
| Windows | `%LOCALAPPDATA%\Costlight\` |
| macOS | `~/Library/Application Support/Costlight/` |
| Linux and other Unix systems | `${XDG_DATA_HOME:-~/.local/share}/costlight/` |

Costlight follows the XDG data-directory convention on Unix. It does not use `XDG_CACHE_HOME` because the SQLite ledger and historical price assignments are persistent application data, not disposable cache files.

The application-data directory contains `dashboard.sqlite`, downloaded pricing catalogs, and a `logs/` subdirectory.

Structured errors are written to `logs/costlight.log`, rotated at 5 MiB, and retained in up to five numbered archives. Logs remain local and do not include transcript content.

Existing installations automatically reuse their pre-Costlight data directory when no Costlight directory exists. Use `--data-dir <path>` to choose another location. Costlight never writes inside a Kimi data root.

## Runtime options

Pass options after the mise task separator:

```powershell
mise run start -- --privacy --port 4700
```

| Option | Behavior |
|---|---|
| `--data-dir <path>` | Override the SQLite and pricing-cache directory |
| `--claude-root <path>` | Use one explicit Claude configuration directory |
| `--kimi-root <path>` | Use one explicit Kimi home directory |
| `--host <host>` | Override the default `127.0.0.1` binding |
| `--port <port>` | Override port `4637` |
| `--privacy` | Hide work directories, titles, and workspace names in the UI |
| `--no-watch` | Disable filesystem events; periodic reconciliation remains active |
| `--access-token <token>` | Authenticate a deliberately non-loopback server |

Non-loopback binding is refused unless the token contains at least 16 characters. Browsers use HTTP Basic authentication: the username can be any value and the password is the configured access token. API clients may send the same value as a Bearer token. Exposing the dashboard to another machine should be treated as exposing local session metadata.

`COSTLIGHT_TOKEN` supplies the token without placing it on the command line.

## Pricing behavior

Resolution order is:

1. Exact raw-model user override.
2. Official Anthropic model pricing for Claude.
3. Direct Moonshot provider rate from the last-good models.dev catalog.
4. Direct Moonshot entry from LiteLLM.
5. Bundled provider rates, including published Claude Fable 5, Opus 5, and Haiku 4.5 rates.
6. Visible unpriced warning.

Remote catalogs refresh when stale and then at most every 24 hours. Anthropic's Markdown response is validated against the exact model-pricing table and retained by content hash because the server does not advertise an ETag or Last-Modified validator. A failed refresh retains normalized rates and the last-good raw response. Pricing status is shown separately for Claude and Kimi, so one provider's timestamp never implies that the other was updated. When a catalog omits cache-creation pricing, cache creation uses normal uncached-input pricing and the rate is labeled inferred.

Claude's bundled rates preserve the published 5-minute and 1-hour cache-write prices independently. See [Claude model pricing](https://platform.claude.com/docs/en/about-claude/pricing).

Catalog changes apply to new calls. Existing calls retain their stored rate until the user selects **Reprice history** or runs `bun run reprice`.

### Pricing overrides

Create `pricing-overrides.json` in the application data directory. Values are USD per token, matching ccusage-compatible field names:

```json
{
  "pricingOverrides": {
    "moonshot-ai/kimi-k3": {
      "inputCostPerToken": 0.000003,
      "outputCostPerToken": 0.000015,
      "cacheReadInputTokenCost": 0.0000003,
      "cacheCreationInputTokenCost": 0.000003,
      "effectiveAt": "2026-08-01T00:00:00Z"
    }
  }
}
```

For providers with TTL-specific cache pricing, overrides may also set `cacheCreation5mInputTokenCost` and `cacheCreation1hInputTokenCost`. Each omitted TTL-specific field falls back to `cacheCreationInputTokenCost`, which in turn falls back to the normal input rate. Override provenance remains visible in the model table.

## Privacy and security

Costlight sends no telemetry. Session discovery, parsing, cost reconstruction, storage, and dashboard traffic stay on the local machine. The only outbound network requests fetch the public pricing catalogs described above; no usage data, account metadata, or calculated totals are included.

The database stores token counts, model identity, timestamps, canonical request identifiers, rate provenance, session/agent attribution, and the minimal Claude subscription snapshot needed for metering. It does not store:

- Prompts or model output.
- Tool arguments or tool output.
- Raw wire lines.
- API keys, OAuth tokens, email addresses, organization details, `config.toml`, or provider credentials.

The server sends a restrictive Content Security Policy, refuses remote binding without authentication, and streams only invalidation versions over SSE. The browser refetches aggregate JSON; raw provider records are never sent.

## Safe recovery and rebuild

SQLite checkpoints and source fingerprints make restarts idempotent. If the derived database is damaged or you want an independent rebuild, leave the existing files untouched and start with a new data directory:

```powershell
$rebuildDirectory = Join-Path $env:LOCALAPPDATA 'Costlight-Rebuild'
mise run start -- --data-dir $rebuildDirectory
```

Verify the totals in the rebuilt dashboard before archiving the old application-data directory. Provider source files do not need repair or modification.

When pricing is offline, the app uses the last-good catalog or bundled provider rates. The health endpoint and UI show the failure until a refresh succeeds.

## API

Read endpoints:

- `GET /api/health`
- `GET /api/summary`
- `GET /api/timeseries`
- `GET /api/sessions`
- `GET /api/sessions/:id/agents`
- `GET /api/models`
- `GET /api/options`
- `GET /api/events` (SSE)

Explicit actions:

- `POST /api/rescan`
- `POST /api/pricing/refresh`
- `POST /api/pricing/reprice`

Summary, timeseries, session, and model endpoints accept the same `from`, `to`, `provider`, `workspace`, `session`, `model`, `agentType`, `agent`, `bucket`, and `timeZone` filters. The options endpoint accepts `provider` to return matching workspace, session, model, and stable agent-role choices.

## Feature-grouped layout

Implementation files are grouped by product concept, not technical type:

```text
src/
├── app/                 # runtime composition and project lifecycle
├── session-import/      # provider-neutral checkpoints, monitoring and orchestration
│   ├── kimi/            # Kimi discovery, state and wire parsing
│   └── claude/          # Claude discovery and transcript parsing
├── call-accounting/     # occurrence identity, canonical ledger, audit
├── pricing/             # storage, catalogs, routes, warning UI and styles
├── metered-usage/       # Claude account policy, persistence and disclosure UI
├── dashboard/           # queries, contracts, routes, React UI and styles
└── live-sync/           # SSE, health, browser connection UI and styles
```

`tests/` mirrors these feature directories. There are no global `styles`, `controllers`, `models`, `routes`, `db`, `server`, or test-type directories.

## Verification

```powershell
mise run verify
```

The suite covers Kimi and Claude parsing, account-policy boundaries, append checkpoints, zero-byte unchanged reconciliation, partial JSON, concurrent appends, rewrites, source deletion, new subagents, progressive usage snapshots, fork deduplication, canonical reassignment, historical rate preservation, official and offline pricing, timezone/DST buckets, metered-only report reconciliation, usage-export deviations, filter propagation, and SSE-triggered refresh.

The optional ccusage audit never runs during normal ingestion:

```powershell
bun run audit
```

It audits Kimi with `bunx ccusage kimi daily --json` and Claude with `bunx ccusage claude daily --json --mode calculate`, which downloads ccusage into Bun's package cache on first use when needed. The audit reports replay exclusions rather than hiding the expected difference. The compatibility reference is ccusage commit [`033c1f7631f603fc939fdc85163e8203f0084f83`](https://github.com/ccusage/ccusage/tree/033c1f7631f603fc939fdc85163e8203f0084f83); ccusage is not a runtime dependency, and no ccusage source file is copied into this project.

Each provider is audited only when it has calls in the ledger, so a machine that runs one backend never invokes ccusage for the other. Both keys always appear in the report:

| Status | Meaning |
|---|---|
| `compared` | ccusage ran and the totals are reported |
| `not-detected` | The ledger holds no calls for that provider |
| `nothing-metered` | Claude ran locally, but the account policy meters none of its models |
| `failed` | ccusage could not be run or its output could not be read |

One provider's failure never suppresses the other's numbers; `bun run audit` exits non-zero when either reports `failed`.

`--mode calculate` makes ccusage recompute Claude costs from tokens instead of reusing the `costUSD` value Claude Code wrote into the transcript, so the comparison comes from two independent price calculations rather than one shared figure.

The Claude comparison is metered-only on both sides. `ccusage claude daily` totals every Claude model, while Costlight applies the account policy above, so the audit sums only the `modelBreakdowns` whose model the ledger metered — on Pro that is Fable alone, excluding Haiku and Opus usage covered by the subscription. The compared set is listed under `meteredModels` and the remaining Claude models under `unmeteredModels`, by name only: subscription-covered spend is not what this audit measures. Model-level filtering cannot split a day whose account policy changed mid-history, such as Pro to Enterprise, because ccusage's breakdown carries no metering dimension.

### Auditing Claude against Anthropic's usage export

ccusage reads the same transcripts Costlight does, so it cannot explain a gap against the invoice. This audit compares the ledger with the daily usage export downloaded from Anthropic's web UI, which is what the account was actually billed:

```powershell
bun run audit:claude-usage --report claude_usage_by_model.json
```

| Option | Default | Purpose |
|---|---|---|
| `--report <file>` | required | The usage export downloaded from Anthropic |
| `--csv <file>` | `claude-usage-deviations.csv` in the data directory | Where the per-day deviations are written |
| `--timezone <zone>` | `UTC` | The zone that assigns each ledger call to an export day |

Totals print to stdout; every day-and-model deviation goes to the CSV, which carries three rows per day and model — `anthropic`, `costlight`, and their `difference` — with cost, request count, and each token class. A shortfall in tokens points at calls Costlight never recorded, while matching tokens under a cost gap points at rates. Anthropic reports whole cents per day and model, so each row's cost is exact only to half a cent.

The export must be the daily model-tier report in USD; another grouping is rejected rather than compared against mismatched buckets. Anthropic buckets it server-side, so a deviation pattern that shifts consistently by one day means `--timezone` needs the zone the account is billed in.

Two summary fields report gaps that no single day exposes: `unmeteredCallCount` counts Claude calls the account policy did not meter, and `unpricedCallCount` counts metered calls no rate could price. On an Enterprise account both should be zero, because every call is billed. Metering is filtered per call here rather than per model, so unlike the ccusage audit a policy change inside the range stays correctly split.
