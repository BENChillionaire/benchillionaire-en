/** Classic US 15-question ladder (1999–2008 format). */
export const USD_LADDER = [
  100, 200, 300, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 125_000, 250_000, 500_000, 1_000_000,
];

/**
 * Guaranteed ("safe") positions, 1-based. Classic 15-rung ladders guarantee rungs 5 and 10.
 * The wiki does not record other formats' safe levels, so other lengths use the same
 * one-third / two-thirds placement as an approximation.
 */
export function guaranteedPositions(length: number): number[] {
  return length === 15 ? [5, 10] : [Math.round(length / 3), Math.round((2 * length) / 3)];
}

/**
 * Parses an aired prize label such as "£75,000 (8 of 12) - Not Timed", "KR 1.000.000 (15 of 15)",
 * "200 лв. (2 out of 15)" or "Rs. 1,250,000 (12 of 17)". Returns null when no amount is present.
 */
export function parsePrize(value: string): { amount: number; currency: string } | null {
  const label = value.split("(")[0].split(" - ")[0].trim();
  const match = label.match(/\d[\d.,\s\u00a0']*\d|\d/);
  if (!match) return null;
  let digits = match[0].replace(/[\s\u00a0']/g, "");
  const hasDot = digits.includes(".");
  const hasComma = digits.includes(",");
  if (hasDot && hasComma) {
    // The separator that appears last is the decimal mark.
    const decimal = digits.lastIndexOf(".") > digits.lastIndexOf(",") ? "." : ",";
    digits = digits.replaceAll(decimal === "." ? "," : ".", "").replace(decimal, ".");
  } else if (hasDot || hasComma) {
    const sep = hasDot ? "." : ",";
    const groups = digits.split(sep);
    // "1.000.000" / "64,000": every group after the first has three digits → thousands separators.
    digits = groups.slice(1).every((g) => g.length === 3) ? groups.join("") : groups.join(".");
  }
  const amount = Number(digits);
  if (!Number.isFinite(amount)) return null;
  const currency = label.replace(match[0], "").replace(/\s+/g, " ").trim();
  return { amount, currency };
}
