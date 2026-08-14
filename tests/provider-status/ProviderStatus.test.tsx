import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  ProviderStatusList,
  type ProviderPricingStatus,
} from "../../src/provider-status/ProviderStatus";

const currentYear = new Date().getFullYear();
const statusTimestampMs = new Date(currentYear, 7, 14, 16, 38).getTime();

afterEach(cleanup);

describe("ProviderStatusList", () => {
  test("shows detected providers with metering and current-year pricing details", () => {
    const onRefreshPricing = mock(() => {});
    render(<ProviderStatusList
      claudeAccount={{
        error: null,
        lastSuccessAtMs: statusTimestampMs,
        policy: "pro-fable",
        subscriptionType: "pro",
      }}
      detectedProviders={["anthropic", "moonshotai"]}
      isWorking={false}
      onRefreshPricing={onRefreshPricing}
      pricing={pricingStatuses()}
    />);

    expect(screen.getByText("Claude Pro")).toBeTruthy();
    expect(screen.getByLabelText(/Metered API usage: Fable only/).getAttribute("title"))
      .toContain("Account checked");
    expect(screen.getByText("Pricing: Aug 14 (Claude Official)")).toBeTruthy();
    expect(screen.getByText("Kimi Platform")).toBeTruthy();
    expect(screen.getByLabelText("Metered API usage: all models")).toBeTruthy();
    expect(screen.getByText("Pricing: Aug 14 (Kimi LiteLLM)")).toBeTruthy();

    fireEvent.click(screen.getByText("Claude Pro").closest("summary") as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Refresh Claude pricing" }));
    expect(onRefreshPricing).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["enterprise", "enterprise-api", "enterprise", "Metered API usage: all models."],
    ["excluded", "subscription-excluded", "max", "Metered API usage: none."],
    ["unavailable", null, null, "Metered API usage: unavailable."],
  ] as const)("describes the %s Claude policy", (_case, policy, subscriptionType, description) => {
    render(<ProviderStatusList
      claudeAccount={{ error: null, lastSuccessAtMs: null, policy, subscriptionType }}
      detectedProviders={["anthropic"]}
      isWorking={false}
      onRefreshPricing={() => {}}
      pricing={pricingStatuses()}
    />);

    expect(screen.getByLabelText(description)).toBeTruthy();
    expect(screen.queryByText("Kimi Platform")).toBeNull();
  });
});

function pricingStatuses(): readonly ProviderPricingStatus[] {
  return [
    {
      error: null,
      hasOverrides: false,
      isStale: false,
      provider: "anthropic",
      refreshStatus: "succeeded",
      sourceKind: "remote",
      sourceName: "anthropic",
      updatedAtMs: statusTimestampMs,
    },
    {
      error: null,
      hasOverrides: false,
      isStale: false,
      provider: "moonshotai",
      refreshStatus: "succeeded",
      sourceKind: "remote",
      sourceName: "litellm",
      updatedAtMs: statusTimestampMs,
    },
  ];
}
