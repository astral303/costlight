import type { Database } from "bun:sqlite";
import { isProMeteredClaudeModel } from "../pricing/anthropic-catalog";
import type { ClaudeMeteringPolicy } from "./policy";
import { MeteredUsageService } from "./service";

export interface ClaudeAccountPolicy {
  meteringPolicy: ClaudeMeteringPolicy | null;
  subscriptionType: string | null;
}

/** Reads the stored account policy only; it never runs Claude's account detection. */
export function readClaudeAccountPolicy(database: Database): ClaudeAccountPolicy {
  const status = new MeteredUsageService(database, {
    isProMeteredModel: isProMeteredClaudeModel,
  }).getClaudeStatus();

  return { meteringPolicy: status.policy, subscriptionType: status.subscriptionType };
}

/** Both Claude audits report this case, and it must not read as a comparison that found no gap. */
export function describeUnmeteredAccount(account: ClaudeAccountPolicy): string {
  const policy = account.meteringPolicy ?? "undetected";
  return `Claude calls exist but the ${policy} account policy meters none of them.`;
}
