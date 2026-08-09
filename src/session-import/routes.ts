import type { SessionMonitor } from "./monitor";

export async function handleSessionImportRoute(
  request: Request,
  url: URL,
  monitor: SessionMonitor,
): Promise<Response | null> {
  if (url.pathname !== "/api/rescan") {
    return null;
  }
  if (request.method !== "POST") {
    return Response.json(
      { error: "Method not allowed" },
      { status: 405, headers: { Allow: "POST" } },
    );
  }

  const summary = await monitor.requestReconciliation("manual");
  return Response.json(summary);
}
