import { logger } from "./logger";
import type { Item, Trend } from "./values";
import { loadFandomTypes, lookupFandomType } from "./fandom-types";
import { enrichImages } from "./fandom-images";
import { enrichSets } from "./fandom-sets";

const BASE_URL = "https://supremevalues.com";
const USER_AGENT =
  "Mozilla/5.0 (compatible; MM2ValueBot/1.0; Discord bot for community use)";

interface CategoryConfig {
  slug: string;
  tier: string;
  defaultType: "Knife" | "Gun" | "Pet" | "Mixed" | "Set" | "Misc";
  rarityLabel: string;
}

const CATEGORIES: CategoryConfig[] = [
  { slug: "chromas", tier: "Chroma", defaultType: "Mixed", rarityLabel: "Chroma" },
  { slug: "ancients", tier: "Ancient", defaultType: "Mixed", rarityLabel: "Ancient" },
  { slug: "vintages", tier: "Vintage", defaultType: "Mixed", rarityLabel: "Vintage" },
  { slug: "godlies", tier: "Godly", defaultType: "Mixed", rarityLabel: "Godly" },
  { slug: "uniques", tier: "Unique", defaultType: "Mixed", rarityLabel: "Unique" },
  // "evos" page on supremevalues lists EXP requirements, not values — skipped intentionally.
  { slug: "sets", tier: "Set", defaultType: "Set", rarityLabel: "Set" },
  { slug: "legendaries", tier: "Legendary", defaultType: "Mixed", rarityLabel: "Legendary" },
  { slug: "rares", tier: "Rare", defaultType: "Mixed", rarityLabel: "Rare" },
  { slug: "uncommons", tier: "Uncommon", defaultType: "Mixed", rarityLabel: "Uncommon" },
  { slug: "commons", tier: "Common", defaultType: "Mixed", rarityLabel: "Common" },
  { slug: "pets", tier: "Pet", defaultType: "Pet", rarityLabel: "Pet" },
  { slug: "misc", tier: "Misc", defaultType: "Misc", rarityLabel: "Miscellaneous" },
];

function decode(s: string): string {
  return s
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function normalize(rowHtml: string): string {
  let t = rowHtml.replace(/<[^>]+>/g, "|").replace(/\s+/g, " ");
  let prev: string;
  do {
    prev = t;
    t = t.replace(/\|\s*\|/g, "|");
  } while (t !== prev);
  return decode(t.trim());
}

function num(s: string | null | undefined): number | null {
  if (!s || s === "N/A") return null;
  const n = Number(String(s).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

// Heuristic gun detection. The website doesn't categorize gun vs knife so
// this is best-effort and intentionally not shown in the user-facing embed.
// 1) Match common weapon suffixes anywhere in the name (e.g. "Plasmabeam",
//    "Sharkblaster", "Skeletonblaster", "Pumpcannon").
// 2) Match a curated list of known MM2 gun names as whole words.
const GUN_SUFFIX_RE = /(gun|blaster|cannon|launcher|rifle|pistol|shotgun|flamethrower|raygun|beamer)$/i;
const GUN_NAME_RE =
  /\b(luger|lugar|tides|splitter|patriot|bioblaster|sanic|photon|pixel|pearl|laser|bow|saber|sharkblaster|spider|ginger|fang|festive|slasher|riddlebox|chocopop|plasmaray|plasmaspark|plasmablast)\b/i;

function inferType(
  name: string,
  imageUrl: string | null,
  defaultType: CategoryConfig["defaultType"],
  fandomLookup: Map<string, "Gun" | "Knife">,
): string {
  if (defaultType === "Pet") return "Pet";
  if (defaultType === "Set") return "Set";
  if (defaultType === "Misc") return "Misc";
  // Authoritative source: MM2 fandom wiki categories.
  const fandom = lookupFandomType(fandomLookup, name);
  if (fandom) return fandom;
  // Fallback heuristic for items missing from fandom (e.g. brand-new drops).
  const haystack = `${name} ${imageUrl ?? ""}`.toLowerCase();
  if (GUN_SUFFIX_RE.test(name) || GUN_NAME_RE.test(haystack)) return "Gun";
  return "Knife";
}

function stabilityToTrend(stability: string | null): Trend {
  if (!stability) return "stable";
  const s = stability.toLowerCase();
  if (
    s.includes("rising") ||
    s.includes("doing well") ||
    s.includes("climbing") ||
    s.includes("growing")
  )
    return "rising";
  if (
    s.includes("falling") ||
    s.includes("dropping") ||
    s.includes("declining") ||
    s.includes("crashing") ||
    s.includes("over") ||
    s.includes("dying")
  )
    return "falling";
  return "stable";
}

interface ParsedRow {
  name: string;
  value: number;
  rangeLow: number | null;
  rangeHigh: number | null;
  demand: number | null;
  rarity: number | null;
  stability: string | null;
  origin: string | null;
  lastChange: string | null;
  imageUrl: string | null;
  aliases: string[];
  flippability: string | null;
  contains: string[];
}

function parseRow(rowHtml: string): ParsedRow | null {
  const text = normalize(rowHtml);
  // Pets/sets/evos rows have `Class - |X|` between the name pipe and `Value -`,
  // and the godlies row has just a space — so allow any chars (incl. pipes) up to 500.
  const nameM = text.match(
    /^\|([^|]{2,60}?)\s*\|.{0,500}?Value\s*-\s*\|([0-9,.]+|N\/A)/,
  );
  if (!nameM) return null;

  const value = num(nameM[2]!);
  if (value == null) return null;
  // skip header / banner rows that have no real name
  if (/^socials/i.test(nameM[1]!.trim())) return null;

  const demM = text.match(/Demand\s*-\s*\|([0-9.]+|N\/A)/i);
  const rarM = text.match(/Rarity\s*-\s*\|([0-9]+|N\/A)/);
  const stabM = text.match(/Stability\s*-\s*\|([^|]+)\|/);
  const origM = text.match(/Origin\s*-\s*\|([^|]+)\|/);
  const rangeM = text.match(
    /Ranged Value\s*-\s*\[\|([0-9,.]+|N\/A)(?:\s*-\s*([0-9,.]+))?\|\]/,
  );
  const lcvM = text.match(/Last Change in Value\s*-\s*\(\|([+\-][0-9,.]+|N\/A)\|\)/);
  // supremevalues markup for sets puts "Contains - X, Y" as raw text inside a
  // div with no tag boundary between the dash and the values, so the leading
  // pipe (which `normalize` adds for tag transitions) may or may not be there.
  // Accept both, and also accept "+" as a separator for combined sets like
  // "Chroma Bringer Set + Bringer Set".
  const containsM = text.match(/Contains\s*-\s*\|?\s*([^|]+?)\s*\|/i);

  const imgM =
    rowHtml.match(/<img[^>]+class="itemimage"[^>]+src="([^"]+)"/) ??
    rowHtml.match(/<img[^>]+src="([^"]+)"[^>]*class="itemimage"/) ??
    rowHtml.match(/<img[^>]+src="([^"]+)"/);
  const aliasM = rowHtml.match(/data-aliases='([^']*)'/);
  const flipM = rowHtml.match(/data-flippability='([^']*)'/);

  return {
    name: nameM[1]!.trim(),
    value,
    rangeLow: rangeM ? num(rangeM[1]!) : null,
    rangeHigh: rangeM && rangeM[2] ? num(rangeM[2]) : null,
    demand: demM ? num(demM[1]!) : null,
    rarity: rarM ? num(rarM[1]!) : null,
    stability: stabM ? decode(stabM[1]!).trim() : null,
    origin: origM ? decode(origM[1]!).trim() : null,
    lastChange: lcvM ? lcvM[1]! : null,
    imageUrl: imgM
      ? new URL(imgM[1]!.replace(/^\.\.\//, "/"), BASE_URL).toString()
      : null,
    aliases: aliasM
      ? decode(aliasM[1]!)
          .split(/[,;|]/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0 && s.toUpperCase() !== "N/A")
      : [],
    flippability: flipM ? decode(flipM[1]!) : null,
    contains: containsM
      ? decode(containsM[1]!)
          .split(/\s*(?:,|\s\+\s)\s*/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0 && s.toUpperCase() !== "N/A")
      : [],
  };
}

interface FetchCategoryResult {
  items: Item[];
  // For Set tier only: the per-set image URL from supremevalues, kept aside
  // so it can be used as a last-resort fallback after wiki enrichment fails.
  supremeSetImages: Map<string, string>;
}

async function fetchCategory(
  cat: CategoryConfig,
  fandomLookup: Map<string, "Gun" | "Knife">,
): Promise<FetchCategoryResult> {
  const url = `${BASE_URL}/mm2/${cat.slug}`;
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  const html = await res.text();
  const trs = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]!);

  const items: Item[] = [];
  const supremeSetImages = new Map<string, string>();
  for (const tr of trs) {
    const r = parseRow(tr);
    if (!r) continue;
    // For sets, supremevalues' image is just one of the components (e.g.
    // "Full Bringer Set" → Lightbringer.png), which is misleading. Drop it
    // from the primary slot so the wiki enrichment in `scrapeAll` can
    // supply the proper composite set image from the MM2 fandom Wiki-Bot
    // subpage. We stash the supremevalues URL in `supremeSetImages` so it
    // can act as a last-resort fallback for sets the wiki has no page for
    // (e.g. Bauble Set, Borealis Set, Eternal Set). For all other tiers
    // supremevalues' per-item image is correct, so use it directly.
    const imageUrl = cat.tier === "Set" ? undefined : r.imageUrl ?? undefined;
    if (cat.tier === "Set" && r.imageUrl) {
      supremeSetImages.set(r.name, r.imageUrl);
    }
    items.push({
      name: r.name,
      type: inferType(r.name, r.imageUrl, cat.defaultType, fandomLookup),
      tier: cat.tier,
      value: r.value,
      demand: r.demand ?? 0,
      trend: stabilityToTrend(r.stability),
      rarity: cat.rarityLabel,
      imageUrl,
      aliases: r.aliases,
      stability: r.stability ?? undefined,
      origin: r.origin ?? undefined,
      lastChange: r.lastChange ?? undefined,
      rangeLow: r.rangeLow ?? undefined,
      rangeHigh: r.rangeHigh ?? undefined,
      flippability: r.flippability ?? undefined,
      sourceUrl: url,
      contains: r.contains.length > 0 ? r.contains : undefined,
    });
  }
  return { items, supremeSetImages };
}

export interface ScrapeResult {
  items: Item[];
  scrapedAt: string;
  sourceBase: string;
  perCategory: Record<string, number>;
  errors: { slug: string; error: string }[];
}

export async function scrapeAll(): Promise<ScrapeResult> {
  const all: Item[] = [];
  const perCategory: Record<string, number> = {};
  const errors: { slug: string; error: string }[] = [];

  const fandomLookup = await loadFandomTypes();

  // Aggregated supremevalues image URLs for Set tier across all categories,
  // used as a last-resort fallback after wiki enrichment.
  const supremeSetImages = new Map<string, string>();

  for (const cat of CATEGORIES) {
    try {
      const { items, supremeSetImages: catSupremeImages } =
        await fetchCategory(cat, fandomLookup);
      all.push(...items);
      perCategory[cat.slug] = items.length;
      for (const [name, url] of catSupremeImages) supremeSetImages.set(name, url);
      logger.info(
        { slug: cat.slug, count: items.length },
        "Scraped category",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ slug: cat.slug, error: msg });
      perCategory[cat.slug] = 0;
      logger.warn({ slug: cat.slug, err: msg }, "Failed to scrape category");
    }
    // be polite — small delay between requests
    await new Promise((r) => setTimeout(r, 250));
  }

  // Enrich Set items FIRST with proper composite images and components from
  // the MM2 fandom Wiki-Bot subpages. This must run before `enrichImages`
  // (which queries `prop=pageimages` on the item name) — for sets, that
  // generic pageimages lookup tends to return a single-component thumbnail
  // (e.g. "Bauble" article → 2024Bauble.png is just the knife) instead of
  // the proper Wiki-Bot composite (Wiki-Bot/Ornament Set → Ornament_Set.png).
  // Values/demand are NOT touched here — those come from supremevalues.com only.
  try {
    const setItems = all.filter((it) => it.tier === "Set");
    if (setItems.length > 0) {
      const enriched = await enrichSets(setItems.map((it) => ({ name: it.name })));
      for (const it of setItems) {
        const info = enriched.get(it.name);
        if (!info) continue;
        if (!it.imageUrl && info.imageUrl) it.imageUrl = info.imageUrl;
        if ((!it.contains || it.contains.length === 0) && info.components && info.components.length > 0) {
          it.contains = info.components;
        }
      }
    }
  } catch (err) {
    logger.warn({ err: String(err) }, "Set enrichment failed");
  }

  // Backfill any still-missing images (sets that have no Wiki-Bot subpage,
  // plus any non-set items missing images) from generic wiki pageimages.
  try {
    const needs = all
      .filter((it) => !it.imageUrl)
      .map((it) => ({ name: it.name, tier: it.tier }));
    if (needs.length > 0) {
      const enriched = await enrichImages(needs);
      for (const it of all) {
        if (!it.imageUrl) {
          const url = enriched.get(it.name);
          if (url) it.imageUrl = url;
        }
      }
    }
  } catch (err) {
    logger.warn({ err: String(err) }, "Image enrichment failed");
  }

  // Last-resort image fallback for sets the wiki has no page for at all
  // (e.g. Bauble Set, Borealis Set, Eternal Set, Pumpkin Set 2019/2020/2021,
  // Wrapping Paper Set, Godly Pet Set). For these, supremevalues' single
  // representative-component image is better than no image at all.
  for (const it of all) {
    if (it.tier !== "Set" || it.imageUrl) continue;
    const fallback = supremeSetImages.get(it.name);
    if (fallback) it.imageUrl = fallback;
  }

  return {
    items: all,
    scrapedAt: new Date().toISOString(),
    sourceBase: BASE_URL,
    perCategory,
    errors,
  };
}
