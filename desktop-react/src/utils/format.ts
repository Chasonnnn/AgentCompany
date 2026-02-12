export function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

export function formatPercent(value: number): string {
  return `${Math.round(value * 10) / 10}%`;
}

export function formatUsd(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
}

export function formatDateTime(value?: string): string {
  if (!value) return "N/A";
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return "N/A";
  return new Date(ts).toLocaleString();
}

export function displayRole(role: string): string {
  if (!role) return "Unknown";
  return role[0].toUpperCase() + role.slice(1);
}

