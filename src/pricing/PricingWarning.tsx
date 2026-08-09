import "./pricing-warning.css";

interface PricingWarningProps {
  isWorking: boolean;
  newestSnapshotMs: number | null;
  onRefresh: () => void;
  onReprice: () => void;
  unpricedCallCount: number;
}

export function PricingWarning({
  isWorking,
  newestSnapshotMs,
  onRefresh,
  onReprice,
  unpricedCallCount,
}: PricingWarningProps) {
  const snapshotLabel = newestSnapshotMs === null
    ? "bundled rates"
    : new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(newestSnapshotMs);

  return (
    <details className={`pricing-menu ${unpricedCallCount > 0 ? "has-warning" : ""}`}>
      <summary>
        <span>Pricing updated: {snapshotLabel}</span>
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
