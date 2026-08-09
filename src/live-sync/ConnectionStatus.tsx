import "./connection-status.css";

interface ConnectionStatusProps {
  isConnected: boolean;
  isScanning: boolean;
  lastSuccessfulScanMs: number | null;
}

export function ConnectionStatus({
  isConnected,
  isScanning,
  lastSuccessfulScanMs,
}: ConnectionStatusProps) {
  const label = isScanning ? "Scanning" : isConnected ? "Live" : "Reconnecting";
  const lastScanLabel = lastSuccessfulScanMs === null
    ? "No completed scan yet"
    : `Last scan ${new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    }).format(lastSuccessfulScanMs)}`;
  const detail = isScanning ? "Reading local files" : "Watches files · Rechecks every 30s";

  return (
    <div className="connection-status" aria-live="polite" title={lastScanLabel}>
      <span
        className={`connection-status__dot ${isConnected ? "is-connected" : ""}`}
        aria-hidden="true"
      />
      <span>
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
    </div>
  );
}
