export function formatUsdNano(nanodollars: number): string {
  const dollars = nanodollars / 1_000_000_000;
  return new Intl.NumberFormat(undefined, {
    currency: "USD",
    maximumFractionDigits: dollars < 0.01 && dollars !== 0 ? 4 : 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(dollars);
}
