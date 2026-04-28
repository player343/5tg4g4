import dataset from "../data/mm2-values.json" with { type: "json" };
import { logger } from "./logger";
import { scrapeAll, type ScrapeResult } from "./scraper";

export type Trend = "rising" | "falling" | "stable";

export interface Item {
  name: string;
  type: string;
  tier: string;
  value: number;
  demand: number;
  trend: Trend;
  rarity: string;
  imageUrl?: string;
  aliases?: string[];
  stability?: string;
  origin?: string;
  lastChange?: string;
  rangeLow?: number;
  rangeHigh?: number;
  flippability?: string;
  sourceUrl?: string;
  contains?: string[];
}

export interface Dataset {
  lastUpdated: string;
  source: string;
  currencyUnit: string;
  items: Item[];
  perCategory?: Record<string, number>;
  errors?: { slug: string; error: string }[];
  isLive?: boolean;
}

let current: Dataset = {
  ...(dataset as unknown as Dataset),
  isLive: false,
};

let lastScrapeAttempt = 0;

export function getDataset(): Dataset {
  return current;
}

export function getAllItems(): Item[] {
  return current.items;
}

export function isLive(): boolean {
  return current.isLive === true;
}

export function lastScrapeAttemptTime(): number {
  return lastScrapeAttempt;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// Light de-noising: strip filler words, fix common misspellings, collapse
// repeated chars (e.g. "plasaaaaa" → "plasa"). Does not change the original
// query — only used to generate extra search variants.
const COMMON_TYPOS: Record<string, string> = {
  plazma: "plasma",
  plassma: "plasma",
  plasama: "plasma",
  cromatic: "chroma",
  chromatic: "chroma",
  chrome: "chroma",
  godley: "godly",
  godley1: "godly",
  vintge: "vintage",
  vintaje: "vintage",
  anciant: "ancient",
  anchient: "ancient",
  uniqe: "unique",
  uniqu: "unique",
  legendry: "legendary",
  legenday: "legendary",
  legandry: "legendary",
  comon: "common",
  uncomon: "uncommon",
  rare1: "rare",
  rae: "rare",
};
const FILLER_WORDS = new Set([
  "a",
  "an",
  "the",
  "knife",
  "knives",
  "gun",
  "guns",
  "weapon",
  "item",
  "set",
  "pet",
  "the",
  "of",
]);

function deNoise(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => COMMON_TYPOS[w] ?? w)
    .map((w) => w.replace(/(.)\1{2,}/g, "$1$1"))
    .join(" ")
    .trim();
}

function searchTokens(item: Item): string[] {
  const tokens = [normalize(item.name)];
  if (item.aliases) {
    for (const a of item.aliases) tokens.push(normalize(a));
  }
  return tokens.filter((t) => t.length > 0);
}

const TIER_PREFIX_ALIASES: Record<string, string> = {
  c: "chroma",
  ch: "chroma",
  chr: "chroma",
  chrom: "chroma",
  chroma: "chroma",
  v: "vintage",
  vint: "vintage",
  vintage: "vintage",
  a: "ancient",
  anc: "ancient",
  ancient: "ancient",
  u: "unique",
  uni: "unique",
  unique: "unique",
  g: "godly",
  god: "godly",
  godly: "godly",
  l: "legendary",
  leg: "legendary",
  legendary: "legendary",
  r: "rare",
  rare: "rare",
  un: "uncommon",
  unc: "uncommon",
  uncommon: "uncommon",
  com: "common",
  common: "common",
  p: "pet",
  pet: "pet",
};

/**
 * Tier prefixes that are safe to split off the front of a single token (no
 * space). Single-letter prefixes like "c" are excluded from the no-space split
 * because almost every word starts with letters that overlap. We only do the
 * no-space split for prefixes that are at least 2 chars OR are followed by a
 * delimiter when typed normally.
 */
const NOSPACE_TIER_PREFIXES: { prefix: string; expanded: string }[] = [
  { prefix: "chroma", expanded: "chroma" },
  { prefix: "chrom", expanded: "chroma" },
  { prefix: "chr", expanded: "chroma" },
  { prefix: "ch", expanded: "chroma" },
  { prefix: "vintage", expanded: "vintage" },
  { prefix: "vint", expanded: "vintage" },
  { prefix: "ancient", expanded: "ancient" },
  { prefix: "anc", expanded: "ancient" },
  { prefix: "unique", expanded: "unique" },
  { prefix: "uni", expanded: "unique" },
  { prefix: "godly", expanded: "godly" },
  { prefix: "god", expanded: "godly" },
  { prefix: "legendary", expanded: "legendary" },
  { prefix: "leg", expanded: "legendary" },
  { prefix: "uncommon", expanded: "uncommon" },
  { prefix: "unc", expanded: "uncommon" },
  { prefix: "common", expanded: "common" },
  { prefix: "com", expanded: "common" },
];

function expandQueries(query: string): string[] {
  const variants: string[] = [];
  const seen = new Set<string>();
  const push = (s: string) => {
    const k = s.trim();
    if (k && !seen.has(k.toLowerCase())) {
      seen.add(k.toLowerCase());
      variants.push(k);
    }
  };

  const original = query.trim();
  if (!original) return [];

  push(original);

  // 1) Tier-prefix expansion on the FIRST token (e.g. "c seer" → "chroma seer").
  const expandFirstToken = (q: string): string | null => {
    const sp = q.search(/\s/);
    if (sp > 0) {
      const head = q.slice(0, sp).toLowerCase();
      const rest = q.slice(sp + 1).trim();
      const expanded = TIER_PREFIX_ALIASES[head];
      if (expanded && rest) return `${expanded} ${rest}`;
    } else {
      const expanded = TIER_PREFIX_ALIASES[q.toLowerCase()];
      if (expanded) return expanded;
    }
    return null;
  };
  const tierExpanded = expandFirstToken(original);
  if (tierExpanded) push(tierExpanded);

  // 1b) No-space tier prefix split (e.g. "cseer" → "chroma seer", "ghell" → "godly hell").
  const splitNoSpacePrefix = (q: string): string[] => {
    if (q.includes(" ")) return [];
    const lower = q.toLowerCase();
    const out: string[] = [];
    for (const { prefix, expanded } of NOSPACE_TIER_PREFIXES) {
      if (lower.length > prefix.length && lower.startsWith(prefix)) {
        const rest = lower.slice(prefix.length);
        if (rest.length >= 2) out.push(`${expanded} ${rest}`);
      }
    }
    return out;
  };
  for (const v of splitNoSpacePrefix(original)) push(v);

  // 2) De-noised typo-fixed variant.
  const cleaned = deNoise(original);
  if (cleaned !== original.toLowerCase()) push(cleaned);

  // 3) Tier-prefix on the cleaned variant.
  const cleanedExpanded = expandFirstToken(cleaned);
  if (cleanedExpanded) push(cleanedExpanded);
  for (const v of splitNoSpacePrefix(cleaned)) push(v);

  // 4) Drop filler words ("set", "knife", "the"...). Helps "chroma seer knife"
  // match "Chroma Seer".
  const stripped = (cleaned || original.toLowerCase())
    .split(/\s+/)
    .filter((w) => !FILLER_WORDS.has(w))
    .join(" ")
    .trim();
  if (stripped && stripped !== cleaned && stripped !== original.toLowerCase()) {
    push(stripped);
    const strExp = expandFirstToken(stripped);
    if (strExp) push(strExp);
  }

  return variants;
}

/**
 * Detect an explicit tier signal in the query and return the matching tier
 * name (capitalized, e.g. "Chroma", "Set"). Two signals are recognized:
 *   1. The FIRST token is a tier prefix — e.g. "c seer" → Chroma.
 *   2. The LAST token is the literal word "set" — e.g. "plasma set",
 *      "chroma bauble set" → Set. This keeps `.value chroma bauble set`
 *      from collapsing into the gun "Chroma Bauble" via shortest-substring
 *      preference, and prevents bogus fuzzy matches like `heat set` → "<3".
 */
function detectTierConstraint(query: string): string | null {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  // The "set" suffix is the most specific signal — even something like
  // "chroma bauble set" should resolve to the Set ("Chroma Bauble Set"),
  // NOT to the Chroma gun "Chroma Bauble". So check the suffix first.
  if (
    tokens.length >= 2 &&
    tokens[tokens.length - 1]!.toLowerCase() === "set"
  ) {
    return "Set";
  }
  const first = tokens[0]!.toLowerCase();
  const expanded = TIER_PREFIX_ALIASES[first];
  if (expanded) return cap(expanded);
  return null;
}

function tokenContains(item: Item, q: string): boolean {
  return searchTokens(item).some((t) => t.includes(q));
}

function findItemInternal(
  query: string,
  tierFilter?: string | null,
  options?: { skipFuzzy?: boolean },
): Item | null {
  const q = normalize(query);
  if (!q) return null;
  const all = current.items;
  const items = tierFilter
    ? all.filter((i) => i.tier.toLowerCase() === tierFilter.toLowerCase())
    : all;
  if (items.length === 0) return null;

  for (const item of items) {
    if (searchTokens(item).some((t) => t === q)) return item;
  }
  for (const item of items) {
    if (searchTokens(item).some((t) => t.startsWith(q))) return item;
  }
  // Substring match: prefer the SHORTEST match (so "seer" matches "Seer"
  // instead of "Time Seer Set"). Stable preference for higher-value tiers
  // when length is tied.
  let shortest: Item | null = null;
  let shortestLen = Infinity;
  for (const item of items) {
    if (!tokenContains(item, q)) continue;
    const tok = searchTokens(item).find((t) => t.includes(q))!;
    if (tok.length < shortestLen) {
      shortest = item;
      shortestLen = tok.length;
    }
  }
  if (shortest) return shortest;

  if (options?.skipFuzzy) return null;

  // Fuzzy fallback. Adapt threshold to query length: very short queries need
  // higher similarity to avoid wild guesses.
  const threshold = q.length <= 4 ? 0.75 : q.length <= 6 ? 0.65 : 0.55;
  let best: { item: Item; score: number } | null = null;
  for (const item of items) {
    for (const tok of searchTokens(item)) {
      const score = similarity(q, tok);
      if (score >= threshold && (!best || score > best.score)) {
        best = { item, score };
      }
    }
  }
  return best ? best.item : null;
}

export function findItem(query: string): Item | null {
  if (!query) return null;
  const variants = expandQueries(query);
  const tierFilter = detectTierConstraint(query);
  // When the user explicitly indicates a tier (via prefix like "c seer" or
  // suffix like "plasma set"), search STRICTLY within that tier. We don't
  // fall back to the full dataset — that would let bogus fuzzy matches win
  // (e.g. `heat set` → "<3" pet via the "Heart" alias), which is worse than
  // returning nothing and letting the not-found embed surface "did you mean"
  // suggestions.
  if (tierFilter) {
    // Within a tier-constrained pass we ONLY accept exact / prefix / substring
    // matches. Fuzzy matches inside a small tier are too eager — e.g. a query
    // of "heat set" inside the Set tier would otherwise fuzzy-match "Bat Set"
    // (1-char difference). Returning null here lets the not-found embed show
    // proper "did you mean" suggestions instead.
    for (const variant of variants) {
      const found = findItemInternal(variant, tierFilter, { skipFuzzy: true });
      if (found) return found;
    }
    return null;
  }
  for (const variant of variants) {
    const found = findItemInternal(variant);
    if (found) return found;
  }
  return null;
}

/**
 * Return up to `limit` closest matches for a query, useful for "did you mean"
 * suggestions when an exact lookup fails. Considers all expanded variants.
 */
export function suggestItems(query: string, limit = 5): Item[] {
  if (!query) return [];
  const tierFilter = detectTierConstraint(query);
  const items = tierFilter
    ? current.items.filter((i) => i.tier.toLowerCase() === tierFilter.toLowerCase())
    : current.items;
  const scored = new Map<string, { item: Item; score: number }>();
  for (const variant of expandQueries(query)) {
    const q = normalize(variant);
    if (!q) continue;
    for (const item of items) {
      for (const tok of searchTokens(item)) {
        let score = 0;
        if (tok === q) score = 1;
        else if (tok.startsWith(q)) score = 0.95;
        else if (tok.includes(q)) score = 0.85 - Math.min(0.2, (tok.length - q.length) / 100);
        else score = similarity(q, tok);
        if (score < 0.45) continue;
        const prev = scored.get(item.name);
        if (!prev || score > prev.score) scored.set(item.name, { item, score });
      }
    }
  }
  return [...scored.values()]
    .sort((a, b) => b.score - a.score || b.item.value - a.item.value)
    .slice(0, limit)
    .map((s) => s.item);
}

export function searchItems(query: string, limit = 10): Item[] {
  if (!query) return current.items.slice(0, limit);
  const seen = new Set<string>();
  const results: Item[] = [];
  for (const variant of expandQueries(query)) {
    const q = normalize(variant);
    if (!q) continue;
    for (const item of current.items) {
      if (seen.has(item.name)) continue;
      if (searchTokens(item).some((t) => t.includes(q))) {
        seen.add(item.name);
        results.push(item);
      }
    }
  }
  results.sort((a, b) => b.value - a.value);
  return results.slice(0, limit);
}

export function listByTier(tier: string): Item[] {
  const t = tier.toLowerCase();
  return current.items
    .filter((i) => i.tier.toLowerCase() === t)
    .sort((a, b) => b.value - a.value);
}

export function tiers(): string[] {
  return Array.from(new Set(current.items.map((i) => i.tier)));
}

function similarity(a: string, b: string): number {
  const longer = a.length >= b.length ? a : b;
  const shorter = a.length >= b.length ? b : a;
  if (longer.length === 0) return 1.0;
  const distance = editDistance(longer, shorter);
  return (longer.length - distance) / longer.length;
}

function editDistance(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = 0; i <= a.length; i++) dp[i]![0] = i;
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost,
      );
    }
  }
  return dp[a.length]![b.length]!;
}

export interface RefreshOutcome {
  ok: boolean;
  itemCount: number;
  errors: { slug: string; error: string }[];
  perCategory: Record<string, number>;
  message: string;
}

let refreshInFlight: Promise<RefreshOutcome> | null = null;

export async function refreshFromScrape(): Promise<RefreshOutcome> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async (): Promise<RefreshOutcome> => {
    lastScrapeAttempt = Date.now();
    try {
      const result: ScrapeResult = await scrapeAll();
      if (result.items.length === 0) {
        return {
          ok: false,
          itemCount: 0,
          errors: result.errors,
          perCategory: result.perCategory,
          message: "Scrape returned 0 items — keeping previous dataset.",
        };
      }
      current = {
        lastUpdated: result.scrapedAt,
        source: `Scraped from ${result.sourceBase}`,
        currencyUnit: "value",
        items: result.items,
        perCategory: result.perCategory,
        errors: result.errors,
        isLive: true,
      };
      logger.info(
        {
          itemCount: result.items.length,
          categories: Object.keys(result.perCategory).length,
          errors: result.errors.length,
        },
        "Live dataset refreshed",
      );
      return {
        ok: true,
        itemCount: result.items.length,
        errors: result.errors,
        perCategory: result.perCategory,
        message: `Updated to ${result.items.length} items from supremevalues.com`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, "Refresh failed");
      return {
        ok: false,
        itemCount: current.items.length,
        errors: [{ slug: "all", error: msg }],
        perCategory: {},
        message: `Refresh failed: ${msg}`,
      };
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

export async function refreshFromUrl(url: string): Promise<Dataset> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch dataset: HTTP ${res.status}`);
  const json = (await res.json()) as Dataset;
  if (!json.items || !Array.isArray(json.items)) {
    throw new Error("Invalid dataset shape: missing items[]");
  }
  current = { ...json, isLive: true };
  logger.info({ itemCount: json.items.length, url }, "Refreshed from URL");
  return current;
}
