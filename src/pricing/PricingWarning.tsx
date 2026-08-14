import "./pricing-warning.css";

interface PricingWarningProps {
  isWorking: boolean;
  onRefresh: () => void;
  onReprice: () => void;
  providers: readonly {
    error: string | null;
    hasOverrides: boolean;
    isStale: boolean;
    provider: "anthropic" | "moonshotai";
    refreshStatus: "failed" | "not-attempted" | "partial-failure" | "succeeded";
    sourceKind: "bundled" | "remote";
    sourceName: string;
    updatedAtMs: number | null;
  }[];
  unpricedCallCount: number;
}

export function PricingWarning({
  isWorking,
  onRefresh,
  onReprice,
  providers,
  unpricedCallCount,
}: PricingWarningProps) {
  const pricingLabel = providers.map(formatProviderStatus).join(" · ") || "bundled rates";

  return (
    <details className={`pricing-menu ${unpricedCallCount > 0 ? "has-warning" : ""}`}>
      <summary>
        <span>Pricing: {pricingLabel}</span>
        {unpricedCallCount > 0 && (
          <strong>
            {unpricedCallCount.toLocaleString()} unpriced call{unpricedCallCount === 1 ? "" : "s"}
          </strong>
        )}
      </summary>
      <div className="pricing-menu__content">
        <p>Checked at startup and every 24 hours. Existing calls keep their recorded rates.</p>
        <div className="pricing-menu__actions">
          <button type="button" onClick={onRefresh} disabled={isWorking}>Update pricing</button>
          <button type="button" className="secondary" onClick={onReprice} disabled={isWorking}>
            Reprice history
          </button>
        </div>
      </div>
    </details>
  );
}

function formatProviderStatus(provider: PricingWarningProps["providers"][number]): string {
  const providerName = provider.provider === "anthropic" ? "Claude" : "Kimi";
  const sourceName = provider.sourceName === "anthropic" ? "official" : provider.sourceName;
  const source = provider.updatedAtMs === null
    ? sourceName
    : `${sourceName} ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" })
      .format(provider.updatedAtMs)}`;
  const qualifiers = [
    ...(provider.hasOverrides ? ["overrides"] : []),
    ...(provider.isStale ? ["stale"] : []),
    ...(provider.refreshStatus === "failed" ? ["refresh failed"] : []),
    ...(provider.refreshStatus === "partial-failure" ? ["partial refresh failure"] : []),
  ];
  const qualifierText = qualifiers.length === 0 ? "" : ` (${qualifiers.join(", ")})`;
  return `${providerName} ${source}${qualifierText}`;
}
