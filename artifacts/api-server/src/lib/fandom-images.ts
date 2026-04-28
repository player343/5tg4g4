import { promises as fs } from "fs";
import path from "path";
import { logger } from "./logger";

const API_URL = "https://murder-mystery-2.fandom.com/api.php";
const USER_AGENT =
  "Mozilla/5.0 (compatible; MM2ValueBot/1.0; Discord bot for community use)";

const CACHE_PATH = path.join(process.cwd(), "data", "fandom-images.json");

interface FandomImagesCache {
  fetchedAt: number;
  images: Record<string, string | null>;
}

let memoryCache: FandomImagesCache | null = null;

async function readCache(): Promise<FandomImagesCache> {
  if (memoryCache) return memoryCache;
  try {
    const buf = await fs.readFile(CACHE_PATH, "utf8");
    memoryCache = JSON.parse(buf) as FandomImagesCache;
  } catch {
    memoryCache = { fetchedAt: 0, images: {} };
  }
  return memoryCache;
}

async function writeCache(cache: FandomImagesCache): Promise<void> {
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await fs.writeFile(CACHE_PATH, JSON.stringify(cache, null, 2), "utf8");
}

interface PageInfo {
  title: string;
  thumbnail?: { source: string };
  missing?: string;
}

async function queryPageImages(titles: string[]): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  if (titles.length === 0) return result;
  const params = new URLSearchParams({
    action: "query",
    titles: titles.join("|"),
    prop: "pageimages",
    pithumbsize: "300",
    redirects: "1",
    format: "json",
  });
  const res = await fetch(`${API_URL}?${params.toString()}`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`Fandom API HTTP ${res.status}`);
  const json = (await res.json()) as {
    query?: {
      pages?: Record<string, PageInfo>;
      normalized?: { from: string; to: string }[];
      redirects?: { from: string; to: string }[];
    };
  };
  // Build a from→to chain so we can map original titles back to result titles.
  const remap = new Map<string, string>();
  for (const n of json.query?.normalized ?? []) remap.set(n.from, n.to);
  for (const r of json.query?.redirects ?? []) {
    const fromKey = remap.get(r.from) ?? r.from;
    remap.set(fromKey, r.to);
  }
  const pages = json.query?.pages ?? {};
  const titleToThumb = new Map<string, string | null>();
  for (const p of Object.values(pages)) {
    titleToThumb.set(p.title, p.thumbnail?.source ?? null);
  }
  for (const original of titles) {
    let resolved = original;
    // Follow normalize/redirect chain (max 3 hops).
    for (let i = 0; i < 3; i++) {
      const next = remap.get(resolved);
      if (!next || next === resolved) break;
      resolved = next;
    }
    result.set(original, titleToThumb.get(resolved) ?? null);
  }
  return result;
}

function candidateTitles(itemName: string, tier: string): string[] {
  const titles = new Set<string>();
  titles.add(itemName);
  // Note: previously this stripped a trailing " Set" for Set tier (e.g.
  // "Bauble Set" → "Bauble") because some wiki articles drop the suffix.
  // That backfired badly: those bare-name articles are usually the
  // single-component knife/gun page (e.g. "Bauble" → 2024Bauble.png), so
  // we'd end up showing one component as the whole-set image. Composite
  // set images come from the Wiki-Bot subpages (handled by `enrichSets`),
  // not from `prop=pageimages` on the bare component name. Leave Sets
  // alone here so `enrichSets` can supply the proper composite, and only
  // fall back to this pageimages lookup when no Wiki-Bot subpage exists.
  void tier;
  return [...titles].filter((t) => t.length > 0);
}

interface ImageEnrichInput {
  name: string;
  tier: string;
}

/**
 * For every item without a usable image, look up a thumbnail on the MM2
 * fandom wiki. Returns a map of itemName → image URL. Hits the cache first
 * and only batches API calls for unknown candidate titles. Failures are
 * cached as `null` so we don't re-query missing pages on every refresh.
 */
export async function enrichImages(
  items: ImageEnrichInput[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const cache = await readCache();

  // Collect every (item → candidate titles) pair, dedupe titles.
  const itemCandidates: { name: string; titles: string[] }[] = [];
  const unknownTitles = new Set<string>();
  for (const it of items) {
    const titles = candidateTitles(it.name, it.tier);
    itemCandidates.push({ name: it.name, titles });
    for (const t of titles) {
      if (!(t in cache.images)) unknownTitles.add(t);
    }
  }

  // Fetch unknowns in batches of 50 (MediaWiki cap).
  const allUnknown = [...unknownTitles];
  let fetched = 0;
  for (let i = 0; i < allUnknown.length; i += 50) {
    const batch = allUnknown.slice(i, i + 50);
    try {
      const result = await queryPageImages(batch);
      for (const [title, url] of result) cache.images[title] = url;
      fetched += batch.length;
    } catch (err) {
      logger.warn(
        { err: String(err), batchStart: i },
        "Fandom image batch failed",
      );
    }
    // Be polite.
    if (i + 50 < allUnknown.length) await new Promise((r) => setTimeout(r, 250));
  }

  if (fetched > 0) {
    cache.fetchedAt = Date.now();
    try {
      await writeCache(cache);
    } catch (err) {
      logger.warn({ err: String(err) }, "Failed to persist fandom-images cache");
    }
  }

  for (const { name, titles } of itemCandidates) {
    for (const t of titles) {
      const url = cache.images[t];
      if (url) {
        out.set(name, url);
        break;
      }
    }
  }

  if (fetched > 0) {
    logger.info(
      { fetched, matched: out.size, total: items.length },
      "Enriched item images from fandom wiki",
    );
  }
  return out;
}
