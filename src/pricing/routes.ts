import type { CallLedger } from "../call-accounting/ledger";
import type { LiveUpdateHub } from "../live-sync/hub";
import type { PricingCatalog } from "./catalog";

interface PricingRouteDependencies {
  catalog: PricingCatalog;
  hub: LiveUpdateHub;
  ledger: CallLedger;
}

export async function handlePricingRoute(
  request: Request,
  url: URL,
  dependencies: PricingRouteDependencies,
): Promise<Response | null> {
  if (url.pathname === "/api/pricing/refresh") {
    if (request.method !== "POST") {
      return methodNotAllowed();
    }
    const results = await dependencies.catalog.forceRefresh();
    dependencies.hub.publish("pricing-refresh");
    return Response.json({ results });
  }

  if (url.pathname === "/api/pricing/reprice") {
    if (request.method !== "POST") {
      return methodNotAllowed();
    }
    dependencies.ledger.repriceAllCalls();
    dependencies.hub.publish("history-repriced");
    return Response.json({ repriced: true });
  }

  return null;
}

function methodNotAllowed(): Response {
  return Response.json(
    { error: "Method not allowed" },
    { status: 405, headers: { Allow: "POST" } },
  );
}
