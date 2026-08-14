import type { ClaudeMeteringPolicy } from "./policy";
import "./metering-disclosure.css";

export interface ClaudeMeteringDisclosureStatus {
  detectedAtMs: number | null;
  error: string | null;
  lastSuccessAtMs: number | null;
  policy: ClaudeMeteringPolicy | null;
  subscriptionType: string | null;
}

export function MeteringDisclosure({ status }: {
  status: ClaudeMeteringDisclosureStatus;
}) {
  const message = disclosureMessage(status);
  const confirmed = status.lastSuccessAtMs === null
    ? null
    : new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(status.lastSuccessAtMs);
  return (
    <p className="metering-disclosure" role="status">
      {message}
      {confirmed !== null && <small> Account checked {confirmed}.</small>}
      {status.error !== null && <small> Latest check failed; the last confirmed policy remains active.</small>}
    </p>
  );
}

function disclosureMessage(status: ClaudeMeteringDisclosureStatus): string {
  if (status.policy === "pro-fable") {
    return "Claude Pro subscription detected; only Fable is included as metered API usage.";
  }
  if (status.policy === "enterprise-api") {
    return "Claude Enterprise account detected; all Claude usage is included at API rates.";
  }
  if (status.subscriptionType !== null) {
    return `Claude ${status.subscriptionType} subscription detected; Claude usage is excluded from metered API cost.`;
  }
  return "Claude account status is unavailable; Claude usage is excluded until detection succeeds.";
}
