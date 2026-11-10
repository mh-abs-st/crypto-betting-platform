/** Converts between what a player types ("12.5") and smallest units ("12500000"). */

export const DECIMALS = 6;
export const CURRENCY = "USDT";

export function formatAmount(units: string | bigint | undefined, decimals = DECIMALS): string {
  if (units === undefined) {
    return "0.00";
  }
  const value = BigInt(units);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${whole.toLocaleString("en-US")}.${fraction}`;
}

/** Returns smallest units, or undefined if the text is not a positive amount. */
export function toUnits(text: string, decimals = DECIMALS): string | undefined {
  const match = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!match) {
    return undefined;
  }
  const units = BigInt(match[1]!) * 10n ** BigInt(decimals) + BigInt((match[2] ?? "").padEnd(decimals, "0"));
  return units > 0n ? units.toString() : undefined;
}

export function shortHash(hash: string): string {
  return hash.length > 20 ? `${hash.slice(0, 10)}…${hash.slice(-8)}` : hash;
}

export function percent(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}
