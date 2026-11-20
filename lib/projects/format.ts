export function formatMoney(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(0)}`;
  }
}

export function formatDateKey(value: string | Date | null | undefined) {
  if (!value) return "—";
  const s = typeof value === "string" ? value.slice(0, 10) : value.toISOString().slice(0, 10);
  return s;
}
