import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MeteringDisclosure } from "../../src/metered-usage/MeteringDisclosure";

afterEach(cleanup);

describe("MeteringDisclosure", () => {
  test.each([
    ["Pro", "pro-fable", "pro", "Claude Pro subscription detected; only Fable is included as metered API usage."],
    ["Enterprise", "enterprise-api", "enterprise", "Claude Enterprise account detected; all Claude usage is included at API rates."],
    ["excluded", "subscription-excluded", "max", "Claude max subscription detected; Claude usage is excluded from metered API cost."],
    ["unavailable", null, null, "Claude account status is unavailable; Claude usage is excluded until detection succeeds."],
  ] as const)("renders the %s policy", (_label, policy, subscriptionType, message) => {
    render(<MeteringDisclosure status={{
      detectedAtMs: null,
      error: null,
      lastSuccessAtMs: null,
      policy,
      subscriptionType,
    }} />);

    expect(screen.getByRole("status").textContent).toContain(message);
  });

  test("discloses a stale last-known-good policy", () => {
    render(<MeteringDisclosure status={{
      detectedAtMs: 1,
      error: "temporary failure",
      lastSuccessAtMs: 1,
      policy: "pro-fable",
      subscriptionType: "pro",
    }} />);

    expect(screen.getByRole("status").textContent).toContain(
      "Latest check failed; the last confirmed policy remains active.",
    );
  });
});
