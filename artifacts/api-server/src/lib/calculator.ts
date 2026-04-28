import { findItem, type Item } from "./values";

export interface SideTotals {
  items: Item[];
  unknownNames: string[];
  totalValue: number;
  avgDemand: number;
}

export interface TradeResult {
  kind: "trade";
  left: SideTotals;
  right: SideTotals;
  diff: number;
  diffPercent: number;
  verdict: "WIN" | "LOSS" | "FAIR" | "OVERPAY";
  fairnessLabel: string;
}

export interface SumResult {
  kind: "sum";
  side: SideTotals;
}

export type CalcResult = TradeResult | SumResult;

const SEPARATOR_RE = /\s+(?:vs|for|->|=>|=|\|)\s+/i;

function parseSide(raw: string): SideTotals {
  const names = raw
    .split(/\s*\+\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const items: Item[] = [];
  const unknown: string[] = [];

  for (const name of names) {
    const item = findItem(name);
    if (item) items.push(item);
    else unknown.push(name);
  }

  const totalValue = items.reduce((sum, i) => sum + i.value, 0);
  const avgDemand =
    items.length > 0
      ? items.reduce((s, i) => s + i.demand, 0) / items.length
      : 0;

  return { items, unknownNames: unknown, totalValue, avgDemand };
}

export function calculate(input: string): CalcResult | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (SEPARATOR_RE.test(trimmed)) {
    const parts = trimmed.split(SEPARATOR_RE);
    if (parts.length !== 2) return null;

    const left = parseSide(parts[0]!);
    const right = parseSide(parts[1]!);

    if (left.items.length === 0 || right.items.length === 0) {
      return {
        kind: "trade",
        left,
        right,
        diff: 0,
        diffPercent: 0,
        verdict: "FAIR",
        fairnessLabel: "Cannot evaluate",
      };
    }

    const diff = right.totalValue - left.totalValue;
    const diffPercent =
      left.totalValue > 0 ? (diff / left.totalValue) * 100 : 0;

    let verdict: TradeResult["verdict"];
    let fairnessLabel: string;
    const absPct = Math.abs(diffPercent);

    if (absPct < 5) {
      verdict = "FAIR";
      fairnessLabel = "Fair Trade";
    } else if (absPct < 15) {
      verdict = diff > 0 ? "WIN" : "LOSS";
      fairnessLabel = diff > 0 ? "Slight Win" : "Slight Loss";
    } else if (absPct < 35) {
      verdict = diff > 0 ? "WIN" : "LOSS";
      fairnessLabel = diff > 0 ? "Win" : "Loss";
    } else {
      verdict = diff > 0 ? "OVERPAY" : "LOSS";
      fairnessLabel = diff > 0 ? "Overpay (You Win Big)" : "Big Loss";
    }

    return { kind: "trade", left, right, diff, diffPercent, verdict, fairnessLabel };
  }

  const side = parseSide(trimmed);
  if (side.items.length === 0 && side.unknownNames.length === 0) return null;
  return { kind: "sum", side };
}
