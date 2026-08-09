import { useEffect, useState } from "react";

interface LiveConnection {
  dataVersion: number;
  isConnected: boolean;
}

export function useLiveVersion(): LiveConnection {
  const [connection, setConnection] = useState<LiveConnection>({
    dataVersion: 0,
    isConnected: false,
  });

  useEffect(() => {
    const eventSource = new EventSource("/api/events");
    const handleVersionEvent = (event: MessageEvent<string>) => {
      try {
        const value: unknown = JSON.parse(event.data);
        if (isVersionEvent(value)) {
          setConnection({ dataVersion: value.dataVersion, isConnected: true });
        }
      } catch {
        // A later valid event will restore synchronization.
      }
    };
    eventSource.addEventListener("ready", handleVersionEvent as EventListener);
    eventSource.addEventListener("invalidate", handleVersionEvent as EventListener);
    eventSource.onopen = () => {
      setConnection((current) => ({ ...current, isConnected: true }));
    };
    eventSource.onerror = () => {
      setConnection((current) => ({ ...current, isConnected: false }));
    };
    return () => {
      eventSource.close();
    };
  }, []);

  return connection;
}

function isVersionEvent(value: unknown): value is { dataVersion: number } {
  return typeof value === "object"
    && value !== null
    && "dataVersion" in value
    && typeof value.dataVersion === "number";
}
