# Kimi cache window: local evidence

## Result: approximately 60 minutes

The logs strongly support a **roughly 60-minute sliding inactivity window** for large Kimi conversation prefixes.

In the August 11, 2026 snapshot:

- A 242,944-token prefix was still a hit after 59.42 minutes and grew to 247,040 cached tokens.
- A 109,312-token prefix missed after 61.11 minutes. Cached input fell to 18,944 tokens while 96,046 tokens moved to uncached input.
- Before that boundary, there were 3,213 hits and 5 incidental misses. After it, all 21 comparable transitions missed.
- Those 21 later misses span three sessions and eight separate UTC dates.
- The longest uninterrupted hit sequence lasted 202.08 minutes across 86 requests, so active requests renew or replace the relevant cached prefix instead of the cache expiring at a fixed session age.

The 59.42-minute hit had sibling-agent activity during the interval. Restricting the evidence to intervals with no intervening call anywhere in the scanned logs gives a conservative **50.30–61.11 minute** bracket. The best point estimate remains one hour, but the fully idle data does not justify a tighter lower bound than 50.30 minutes yet.

## Snapshot

| Metric | Value |
|---|---:|
| Sessions | 16 |
| Wire files | 29 |
| Canonical Moonshot calls | 4,041 |
| Stable large-prefix transitions | 3,239 |
| Strong hits / misses | 3,213 / 26 |
| Request-time coverage | 4,041 / 4,041 |
| Request range | 2026-07-21 through 2026-08-11 UTC |

The model mix was 4,010 `moonshot-ai/kimi-k3` calls and 31 `moonshot-ai/kimi-k2.6` calls. K3 supplies the boundary evidence; there are not enough K2.6 calls for an independent duration estimate.

## Sensitivity

| Minimum prior cached tokens | Same-agent observed interval | Midpoint |
|---:|---:|---:|
| 65,536 | 59.42–61.11 min | 60.26 min |
| 98,304 | 59.42–61.11 min | 60.26 min |
| 131,072 | 59.42–67.61 min | 63.52 min |

The 65,536-token cutoff keeps the evidence well above the shared 11k–19k cached prefix that remains even after a conversation-prefix miss. Testing only for `cacheRead === 0` would therefore fail: none of the 4,041 calls had zero cached tokens.

## Method

1. Discover every Kimi session and wire file with Costlight's existing importer.
2. Build the replay-deduplicated canonical call ledger in memory.
3. Pair each usage record with its preceding client-side `llm.request` timestamp. Usage timestamps occur after generation and can shift a near-boundary gap by several minutes.
4. Compare consecutive requests for the same session, agent, and model.
5. Count a strong hit when at least 90% of a prior prefix of 65,536 or more cached tokens remains.
6. Count a strong miss when at least half the cached prefix disappears and at least 80% of the lost tokens reappear as uncached input.

Transitions are excluded when the prompt size changes by more than 20%–25%, the message count decreases, or the system-prompt/tool hashes change. These filters keep context compaction, resets, and cache-key changes from looking like TTL expiry. The analysis allows rare early misses because eviction and backend routing can cause a miss before the normal TTL.

Moonshot's current public Kimi documentation describes the local [`wire.jsonl` data](https://moonshotai.github.io/kimi-cli/en/configuration/data-locations.html) and [automatic/manual context compaction](https://moonshotai.github.io/kimi-cli/en/guides/sessions.html), but the pages checked for this analysis did not state a prompt-cache TTL.

## Reproduce

```powershell
mise run analyze-cache
```

The command rescans the live logs, so counts may increase after this snapshot. It uses a temporary in-memory database and retains only token counts, timestamps, model identity, message counts, and prompt/tool hashes. It does not modify Kimi logs or the dashboard database and does not retain prompt, response, or tool content.
