import type { ClaudeMeteringPolicy } from "../metered-usage/policy";
import "./provider-status.css";

type SupportedProvider = "anthropic" | "moonshotai";

interface ClaudeAccountStatus {
  error: string | null;
  lastSuccessAtMs: number | null;
  policy: ClaudeMeteringPolicy | null;
  subscriptionType: string | null;
}

export interface ProviderPricingStatus {
  error: string | null;
  hasOverrides: boolean;
  isStale: boolean;
  provider: SupportedProvider;
  refreshStatus: "failed" | "not-attempted" | "partial-failure" | "succeeded";
  sourceKind: "bundled" | "remote";
  sourceName: string;
  updatedAtMs: number | null;
}

interface ProviderStatusListProps {
  claudeAccount: ClaudeAccountStatus;
  detectedProviders: readonly string[];
  isWorking: boolean;
  onRefreshPricing: () => void;
  pricing: readonly ProviderPricingStatus[];
}

const PROVIDER_ORDER: readonly SupportedProvider[] = ["anthropic", "moonshotai"];

export function ProviderStatusList({
  claudeAccount,
  detectedProviders,
  isWorking,
  onRefreshPricing,
  pricing,
}: ProviderStatusListProps) {
  const detected = new Set(detectedProviders);
  return (
    <div className="provider-status-list" aria-label="Detected providers">
      {PROVIDER_ORDER.filter((provider) => detected.has(provider)).map((provider) => (
        <ProviderStatus
          accountDescription={provider === "anthropic"
            ? describeClaudeMetering(claudeAccount)
            : "Metered API usage: all models"}
          isWorking={isWorking}
          key={provider}
          label={provider === "anthropic" ? claudeLabel(claudeAccount) : "Kimi Platform"}
          onRefreshPricing={onRefreshPricing}
          pricing={pricing.find((status) => status.provider === provider)}
          provider={provider}
        />
      ))}
    </div>
  );
}

function ProviderStatus({
  accountDescription,
  isWorking,
  label,
  onRefreshPricing,
  pricing,
  provider,
}: {
  accountDescription: string;
  isWorking: boolean;
  label: string;
  onRefreshPricing: () => void;
  pricing: ProviderPricingStatus | undefined;
  provider: SupportedProvider;
}) {
  const providerName = provider === "anthropic" ? "Claude" : "Kimi";
  return (
    <details className={`provider-status ${hasPricingWarning(pricing) ? "has-warning" : ""}`}>
      <summary>
        <span className="provider-status__name">
          <strong>{label}</strong>
          <span
            aria-label={accountDescription}
            className="provider-status__info"
            tabIndex={0}
            title={accountDescription}
          >i</span>
        </span>
        <small title={describePricingWarning(pricing)}>{formatPricingLine(pricing, provider)}</small>
      </summary>
      <div className="provider-status__menu">
        {hasPricingWarning(pricing) && <p>{describePricingWarning(pricing)}</p>}
        <button
          aria-label={`Refresh ${providerName} pricing`}
          disabled={isWorking}
          onClick={onRefreshPricing}
          type="button"
        >Refresh pricing</button>
      </div>
    </details>
  );
}

function claudeLabel(account: ClaudeAccountStatus): string {
  if (account.subscriptionType === null) {
    return "Claude";
  }
  return `Claude ${capitalize(account.subscriptionType)}`;
}

function describeClaudeMetering(account: ClaudeAccountStatus): string {
  const metering = account.policy === "pro-fable"
    ? "Metered API usage: Fable only."
    : account.policy === "enterprise-api"
      ? "Metered API usage: all models."
      : account.policy === "subscription-excluded"
        ? "Metered API usage: none."
        : "Metered API usage: unavailable.";
  const accountCheck = account.lastSuccessAtMs === null
    ? ""
    : ` Account checked ${formatDateTime(account.lastSuccessAtMs)}.`;
  const stalePolicy = account.error === null
    ? ""
    : " Latest account check failed; the last confirmed policy remains active.";
  return `${metering}${accountCheck}${stalePolicy}`;
}

function formatPricingLine(
  pricing: ProviderPricingStatus | undefined,
  provider: SupportedProvider,
): string {
  if (pricing === undefined) {
    return "Pricing unavailable";
  }
  const date = pricingDate(pricing);
  const dateLabel = date === null ? "Bundled" : formatPricingDate(date);
  return `Pricing: ${dateLabel} (${pricingSourceLabel(pricing.sourceName, provider)})`;
}

function pricingDate(pricing: ProviderPricingStatus): Date | null {
  if (pricing.updatedAtMs !== null) {
    return new Date(pricing.updatedAtMs);
  }
  const bundledDate = /(\d{4})-(\d{2})-(\d{2})/.exec(pricing.sourceName);
  if (bundledDate === null) {
    return null;
  }
  const [, year, month, day] = bundledDate;
  return new Date(Number(year), Number(month) - 1, Number(day), 12);
}

function formatPricingDate(date: Date, now = new Date()): string {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" as const }),
  }).format(date);
}

function pricingSourceLabel(sourceName: string, provider: SupportedProvider): string {
  if (sourceName === "anthropic") return "Claude Official";
  if (sourceName === "models.dev") return "Kimi models.dev";
  if (sourceName === "litellm") return "Kimi LiteLLM";
  return provider === "anthropic" ? "Claude Bundled" : "Kimi Bundled";
}

function hasPricingWarning(pricing: ProviderPricingStatus | undefined): boolean {
  return pricing === undefined
    || pricing.error !== null
    || pricing.isStale
    || pricing.refreshStatus === "failed"
    || pricing.refreshStatus === "partial-failure";
}

function describePricingWarning(pricing: ProviderPricingStatus | undefined): string {
  if (pricing === undefined) return "No pricing catalog is available.";
  const warnings = [
    ...(pricing.isStale ? ["Pricing is stale."] : []),
    ...(pricing.error === null ? [] : [`Pricing refresh failed: ${pricing.error}`]),
    ...(pricing.hasOverrides ? ["User overrides are active."] : []),
  ];
  return warnings.join(" ");
}

function formatDateTime(timestampMs: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestampMs);
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase()}${value.slice(1)}`;
}
