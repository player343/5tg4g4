import { promises as fs } from "fs";
import path from "path";
import { logger } from "./logger";

const API_URL = "https://murder-mystery-2.fandom.com/api.php";
const USER_AGENT =
  "Mozilla/5.0 (compatible; MM2ValueBot/1.0; Discord bot for community use)";

const CACHE_PATH = path.join(process.cwd(), "data", "fandom-types.json");
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface FandomCache {
  fetchedAt: number;
  guns: string[];
  knives: string[];
}

interface CategoryMember {
  pageid: number;
  ns: number;
  title: string;
}

let memoryLookup: Map<string, "Gun" | "Knife"> | null = null;

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

async function fetchCategory(category: string): Promise<string[]> {
  const titles: string[] = [];
  let cmcontinue: string | undefined;
  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({
      action: "query",
      list: "categorymembers",
      cmtitle: `Category:${category}`,
      cmlimit: "500",
      cmnamespace: "0",
      format: "json",
    });
    if (cmcontinue) params.set("cmcontinue", cmcontinue);
    const res = await fetch(`${API_URL}?${params.toString()}`, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!res.ok) {
      throw new Error(`Fandom API ${category} HTTP ${res.status}`);
    }
    const json = (await res.json()) as {
      query?: { categorymembers?: CategoryMember[] };
      continue?: { cmcontinue?: string };
    };
    const members = json.query?.categorymembers ?? [];
    for (const m of members) titles.push(m.title);
    cmcontinue = json.continue?.cmcontinue;
    if (!cmcontinue) break;
  }
  return titles;
}

async function readCache(): Promise<FandomCache | null> {
  try {
    const buf = await fs.readFile(CACHE_PATH, "utf8");
    return JSON.parse(buf) as FandomCache;
  } catch {
    return null;
  }
}

async function writeCache(cache: FandomCache): Promise<void> {
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await fs.writeFile(CACHE_PATH, JSON.stringify(cache, null, 2), "utf8");
}

function buildLookup(cache: FandomCache): Map<string, "Gun" | "Knife"> {
  const map = new Map<string, "Gun" | "Knife">();
  // Knives first, then guns — guns win on conflicts (rare; e.g. "Ancient
  // Weapons" appears in both, but it's a set on supremevalues anyway).
  for (const t of cache.knives) {
    const k = normalizeName(t);
    if (k) map.set(k, "Knife");
  }
  for (const t of cache.guns) {
    const k = normalizeName(t);
    if (k) map.set(k, "Gun");
  }
  return map;
}

export async function loadFandomTypes(forceRefresh = false): Promise<Map<string, "Gun" | "Knife">> {
  if (memoryLookup && !forceRefresh) return memoryLookup;
  let cache = forceRefresh ? null : await readCache();
  const isStale = !cache || Date.now() - cache.fetchedAt > CACHE_TTL_MS;
  if (!cache || isStale) {
    try {
      logger.info({ msg: "Fetching MM2 fandom gun/knife lists" });
      const [guns, knives] = await Promise.all([
        fetchCategory("Guns"),
        fetchCategory("Knives"),
      ]);
      cache = { fetchedAt: Date.now(), guns, knives };
      await writeCache(cache);
      logger.info({
        msg: "Cached fandom types",
        guns: guns.length,
        knives: knives.length,
      });
    } catch (err) {
      logger.warn({ msg: "Failed to refresh fandom types", err: String(err) });
      if (!cache) return new Map();
    }
  }
  memoryLookup = buildLookup(cache);
  return memoryLookup;
}

export function lookupFandomType(
  lookup: Map<string, "Gun" | "Knife">,
  name: string,
): "Gun" | "Knife" | null {
  const k = normalizeName(name);
  if (!k) return null;
  return lookup.get(k) ?? null;
}
