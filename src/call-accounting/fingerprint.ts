import { createHash } from "node:crypto";
import type { ParsedUsageRecord } from "../session-import/types";

export function createEventFingerprint(record: ParsedUsageRecord): string {
  const provider = resolveProvider(record.model);
  if (record.providerRequestId !== null) {
    return `request:${provider}:${record.providerRequestId}`;
  }

  if (record.stepUuid !== null) {
    return `step:${provider}:${record.stepUuid}`;
  }

  const fallbackIdentity = JSON.stringify({
    model: record.model,
    requestMetadata: record.requestMetadata,
    timestampMs: record.timestampMs,
    tokens: record.tokens,
  });
  const digest = createHash("sha256").update(fallbackIdentity).digest("hex");
  return `fallback:${digest}`;
}

export function resolveProvider(rawModel: string): string {
  const [provider = "unknown"] = rawModel.toLowerCase().split("/", 1);
  if (provider === "moonshot-ai" || provider === "moonshot") {
    return "moonshotai";
  }
  return provider;
}
