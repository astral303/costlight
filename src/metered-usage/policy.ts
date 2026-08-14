export type ClaudeMeteringPolicy = "enterprise-api" | "pro-fable" | "subscription-excluded";

export interface AccountStateForMetering {
  accountStateId: number;
  policy: ClaudeMeteringPolicy;
  subscriptionType: string;
}

export interface MeteringAssignment {
  accountStateId: number | null;
  basis: string;
  isMetered: boolean;
}

export type ProMeteredModelClassifier = (rawModel: string) => boolean;

export function policyForSubscription(subscriptionType: string): ClaudeMeteringPolicy {
  if (subscriptionType === "pro") return "pro-fable";
  if (subscriptionType === "enterprise") return "enterprise-api";
  return "subscription-excluded";
}

export function assignMetering(
  provider: string,
  rawModel: string,
  accountState: AccountStateForMetering | null,
  isProMeteredModel: ProMeteredModelClassifier,
): MeteringAssignment {
  if (provider !== "anthropic") {
    return { accountStateId: null, basis: "metered-api", isMetered: true };
  }
  if (accountState === null) {
    return {
      accountStateId: null,
      basis: "account-status-unavailable",
      isMetered: false,
    };
  }
  if (accountState.policy === "enterprise-api") {
    return {
      accountStateId: accountState.accountStateId,
      basis: "enterprise-api",
      isMetered: true,
    };
  }
  if (accountState.policy === "pro-fable") {
    const isMetered = isProMeteredModel(rawModel);
    return {
      accountStateId: accountState.accountStateId,
      basis: isMetered ? "pro-fable" : "pro-subscription-excluded",
      isMetered,
    };
  }
  return {
    accountStateId: accountState.accountStateId,
    basis: "subscription-excluded",
    isMetered: false,
  };
}
