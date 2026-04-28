import { promises as fs } from "fs";
import path from "path";
import { logger } from "./logger";

const API_URL = "https://murder-mystery-2.fandom.com/api.php";
const USER_AGENT =
  "Mozilla/5.0 (compatible; MM2ValueBot/1.0; Discord bot for community use)";

const CACHE_PATH = path.join(process.cwd(), "data", "fandom-sets.json");
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface SetEntry {
  imageUrl: string | null;
  components: string[];
}

interface FandomSetsCache {
  fetchedAt: number;
  sets: Record<string, SetEntry>;
}

let memoryCache: FandomSetsCache | null = null;

async function readCache(): Promise<FandomSetsCache> {
  if (memoryCache) return memoryCache;
  try {
    const buf = await fs.readFile(CACHE_PATH, "utf8");
    memoryCache = JSON.parse(buf) as FandomSetsCache;
  } catch {
    memoryCache = { fetchedAt: 0, sets: {} };
  }
  return memoryCache;
}

async function writeCache(cache: FandomSetsCache): Promise<void> {
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await fs.writeFile(CACHE_PATH, JSON.stringify(cache, null, 2), "utf8");
}

/**
 * Build the Wiki-Bot project page title for a set. The fandom community
 * maintains structured per-set pages under
 * `Murder Mystery 2 Wiki:Wiki-Bot/<Set Name>` with an Infobox image and
 * an "Includes:" line listing the component items.
 */
function wikiBotTitle(setName: string): string {
  return `Murder Mystery 2 Wiki:Wiki-Bot/${setName}`;
}

/**
 * Authoritative index of Wiki-Bot subpages, scraped once from
 * https://murder-mystery-2.fandom.com/wiki/Murder_Mystery_2_Wiki:Wiki-Bot
 * (the community-maintained list of every set with a Wiki-Bot subpage).
 * Map key is the display name on the index page; map value is the actual
 * page slug under `Murder Mystery 2 Wiki:Wiki-Bot/<slug>`. We try these
 * exact titles first when looking up a set, before falling back to the
 * fuzzy variants below.
 */
const WIKI_BOT_INDEX: Record<string, string> = {
  "Air Set": "Air Set",
  "Alien Set": "Alien Set",
  "Aurora Set": "Aurora Set",
  "Australis Set": "Australis Set",
  "Bat Set": "Bat Set",
  "Bats Set": "Bats Set",
  "Blizzard Set": "Blizzard Set",
  "Bloom Set": "Bloom Set",
  "Bringer Set": "Bringer Set",
  "Candy Set": "Candy Set",
  "Candy Swirl Set": "Candy Swirl Set",
  "Cane Set (2015)": "Cane Set (2015)",
  "Cane Set (2018)": "Cane Set (2018)",
  "Cavern Set": "Cavern Set",
  "Celestial Set": "Celestial Set",
  "Chroma Alien Set": "Chroma Alien Set",
  "Chroma Blizzard Set": "Chroma Blizzard Set",
  "Chroma Bringer Set": "Chroma Bringer Set",
  "Chroma Evergreen Set": "Chroma Evergreen Set",
  "Chroma Ornament Set": "Chroma Ornament Set",
  "Chroma Slasher Set": "Chroma Slasher Set",
  "Chroma Snow Set": "Chroma Snow Set",
  "Chroma Sun Set": "Chroma Sun Set",
  "Clockwork Set": "Clockwork Set",
  "Corrupt Set": "Corrupt Set",
  "Dark Set": "Dark Set",
  "Easter Set": "Easter Set",
  "Elderwood Set": "Elderwood Set",
  "Elf Set": "Elf Set",
  "Elite Set": "Elite Set",
  "Eternalcane Set": "Eternalcane Set",
  "Evergreen Set": "Evergreen Set",
  "Fire Set": "Fire Set",
  "Flowerwood Set": "Flowerwood Set",
  "Frozen Set": "Frozen Set",
  "Full Colored Seer Set": "Full Colored Seer Set",
  "Full Elderwood Set": "Full Elderwood Set",
  "Full Swirly Set": "Full Swirly Set",
  "Ghost Set": "Ghost Set",
  "Ginger Set (Godly)": "Ginger Set (Godly)",
  "Ginger Set (Legendary)": "Ginger Set (Legendary)",
  "Ginger Set (Rare)": "Ginger Set (Rare)",
  "Grave Set": "Grave Set",
  "Hallow Set": "Hallow Set",
  "Haunted Set": "Haunted Set",
  "Holly Set": "Holly Set",
  "Ice Set": "Ice Set",
  "Iceflake Set": "Iceflake Set",
  "Icicles Set": "Icicles Set",
  "Jack Set": "Jack Set",
  "Latte Set": "Latte Set",
  "Lights Set": "Lights Set",
  "Logchopper Set": "Logchopper Set",
  "Luger Set": "Luger Set",
  "Marble Set": "Marble Set",
  "Nutcracker Set": "Nutcracker Set",
  "Ocean Set": "Ocean Set",
  "Old Glory Set": "Old Glory Set",
  "Ornament Set": "Ornament Set",
  "Ornament1 Set": "Ornament1 Set",
  "Ornament2 Set": "Ornament2 Set",
  "Pals Set": "Pals Set",
  "Pearl Set": "Pearl Set",
  "Plasma Set": "Plasma Set",
  "Potion Set": "Potion Set",
  "Rainbow Set": "Rainbow Set",
  "Sakura Set": "Sakura Set",
  "Santa Set": "Santa Set",
  "Santa's Set": "Santa's Set",
  "Scratch Set": "Scratch Set",
  "Silent Night Set": "Silent Night Set",
  "Skate Set": "Skate Set",
  "Slasher Set": "Slasher Set",
  "Slime Set": "Slime Set",
  "Snakebite Set": "Snakebite Set",
  "Snow Set": "Snow Set",
  "Snowman Set": "Snowman Set",
  "Soul Set": "Soul Set",
  "Sparkle Set": "Sparkle Set",
  "Spectre Set": "Spectre Set",
  "Sun Set": "Sun Set",
  "Swirly Set": "Swirly Set",
  "Toxic Set": "Toxic Set",
  "Traveler's Set": "Traveler Set",
  "Tree Set": "Tree Set",
  "Valentine Set": "Valentine Set",
  "Vampire Set": "Vampire Set",
  "Vampire's Set": "Vampire's Set",
  "Vintage Set": "Vintage Set",
  "Virtual Set": "Virtual Set",
  "Web Set": "Web Set",
  "Wrapped Set": "Wrapped Set",
  "Xeno Set": "Xeno Set",
  "Zombie Set": "Zombie Set",
  "Zombified Set": "Zombified Set",
};

/**
 * supremevalues abbreviates / renames several set names in ways the wiki
 * spells out differently. Apply known transforms so we can find pages like
 * `Wiki-Bot/Chroma Evergreen Set` when supreme calls it `Chroma Ever Set`,
 * or `Wiki-Bot/Ornament Set` when supreme calls it `Bauble Set` (the wiki
 * keeps the older "Ornament" naming as the canonical Wiki-Bot subpage even
 * though the in-game item was renamed to "Bauble" in the 2024 update —
 * confirmed by both Wiki-Bot/Ornament Set and Wiki-Bot/Chroma Ornament Set
 * listing `[[Ornament]]` and `[[Bauble]]` as members).
 */
const TOKEN_EXPANSIONS: Record<string, string[]> = {
  ever: ["Evergreen"],
  evergreen: ["Ever"],
  bauble: ["Ornament"],
  ornament: ["Bauble"],
};

function expandTokens(name: string): string[] {
  const out = new Set<string>([name]);
  const tokens = name.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const lower = tokens[i]!.toLowerCase();
    const expansions = TOKEN_EXPANSIONS[lower];
    if (!expansions) continue;
    for (const exp of expansions) {
      const replaced = [...tokens];
      replaced[i] = exp;
      out.add(replaced.join(" "));
    }
  }
  return [...out];
}

/**
 * Expand a set name into the seed forms we'll consider: the original, a
 * parens-stripped form, and a "Full "-stripped form. Both
 * `setNameVariants` (Wiki-Bot subpage titles) and `fileNameVariants` (direct
 * File: page titles) build on this.
 */
function nameSeeds(setName: string): string[] {
  const seed = new Set<string>([setName]);
  const noParen = setName.replace(/\s*\([^)]*\)\s*$/g, "").trim();
  if (noParen && noParen !== setName) seed.add(noParen);
  for (const s of [...seed]) {
    const noFull = s.replace(/^Full\s+/i, "").trim();
    if (noFull && noFull !== s) seed.add(noFull);
  }
  return [...seed];
}

function setNameVariants(setName: string): string[] {
  // Strip parens and "Full " so e.g. "Pumpkin Set (2019)" tries "Pumpkin Set"
  // and "Full Bringer Set" tries "Bringer Set" against Wiki-Bot titles.
  const variants = new Set<string>();
  // Consult the static Wiki-Bot index first using each name seed (and the
  // expanded versions). When the seed appears in the index we add the exact
  // canonical slug so we hit the right page on the first try, instead of
  // depending on wiki redirects.
  for (const s of nameSeeds(setName)) {
    for (const expanded of expandTokens(s)) {
      const indexed = WIKI_BOT_INDEX[expanded];
      if (indexed) variants.add(indexed);
      const withSet = /\s+set$/i.test(expanded) ? expanded : `${expanded} Set`;
      const indexedWithSet = WIKI_BOT_INDEX[withSet];
      if (indexedWithSet) variants.add(indexedWithSet);
    }
  }
  for (const s of nameSeeds(setName)) {
    for (const expanded of expandTokens(s)) {
      variants.add(expanded);
      // Some sets in our dataset are missing the trailing "Set"; the wiki
      // always appends it on these project pages.
      if (!/\s+set$/i.test(expanded)) variants.add(`${expanded} Set`);
    }
  }
  return [...variants].filter((s) => s.length > 0);
}

/**
 * Build candidate `File:<name>.<ext>` titles for a set so we can look up the
 * canonical image directly when the Wiki-Bot subpage doesn't exist or doesn't
 * have a usable image. Tries spaced ("Borealis Set"), condensed
 * ("ColoredSeerSet"), apostrophe-preserving ("Traveler's Set"), and
 * apostrophe-stripped variants — across both .png and .jpg.
 */
function fileNameVariants(setName: string): string[] {
  const out = new Set<string>();
  for (const s of nameSeeds(setName)) {
    for (const expanded of expandTokens(s)) {
      const withSet = /\s+set$/i.test(expanded) ? expanded : `${expanded} Set`;
      const bases = new Set<string>([
        expanded,
        withSet,
        expanded.replace(/\s+/g, ""),
        withSet.replace(/\s+/g, ""),
        expanded.replace(/'/g, ""),
        withSet.replace(/'/g, ""),
      ]);
      for (const base of bases) {
        if (!base) continue;
        for (const ext of ["png", "jpg"]) {
          out.add(`File:${base}.${ext}`);
        }
      }
    }
  }
  return [...out];
}

interface ParsedSetPage {
  imageFile?: string;
  components: string[];
}

function parseInfobox(wikitext: string): ParsedSetPage {
  // Pull out the Infobox block by greedily reading until the first standalone
  // closing }} at column 0 or after a newline. The structure is forgiving
  // enough that a simple linewise scan works.
  const out: ParsedSetPage = { components: [] };
  const lines = wikitext.split(/\r?\n/);
  let inBox = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!inBox && /^\{\{Infobox\b/i.test(line)) {
      inBox = true;
      continue;
    }
    if (inBox) {
      if (line === "}}") {
        inBox = false;
        continue;
      }
      const m = line.match(/^\|\s*image\s*=\s*(.+?)\s*$/i);
      if (m && m[1] && !out.imageFile) {
        // Strip any trailing wiki-formatting like "File:" prefix.
        const file = m[1].replace(/^\[\[/, "").replace(/\]\]$/, "");
        out.imageFile = file.replace(/^File:/i, "").trim();
      }
    }
  }
  // Find the "Includes:" line, parse [[wikilinks]].
  const includesMatch = wikitext.match(/Includes:?\s*([^\n]+)/i);
  if (includesMatch && includesMatch[1]) {
    const segment = includesMatch[1];
    const linkRe = /\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(segment)) !== null) {
      const name = m[1]?.trim();
      if (name) out.components.push(name);
    }
  }
  return out;
}

interface PageNode {
  pageid?: number;
  ns?: number;
  title?: string;
  // formatversion=2 returns missing as a boolean field; older responses
  // include an empty string property.
  missing?: boolean | string;
  thumbnail?: { source: string };
  pageimage?: string;
  revisions?: {
    slots?: { main?: { content?: string; "*"?: string } };
    content?: string;
    "*"?: string;
  }[];
}

/**
 * Batch-fetch wiki content for a list of titles using a single API call.
 * Returns parsed entries keyed by the requested title.
 */
async function fetchSetPages(
  titles: string[],
): Promise<Map<string, SetEntry>> {
  const result = new Map<string, SetEntry>();
  if (titles.length === 0) return result;
  // Use action=query with prop=revisions+pageimages so we can grab the wikitext
  // (for components / image filename) and the page thumbnail in one round trip.
  const params = new URLSearchParams({
    action: "query",
    titles: titles.join("|"),
    prop: "revisions|pageimages",
    rvprop: "content",
    rvslots: "main",
    pithumbsize: "300",
    redirects: "1",
    format: "json",
    formatversion: "2",
  });
  const res = await fetch(`${API_URL}?${params.toString()}`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`Fandom sets API HTTP ${res.status}`);
  const json = (await res.json()) as {
    query?: {
      pages?: PageNode[];
      normalized?: { from: string; to: string }[];
      redirects?: { from: string; to: string }[];
    };
  };
  const remap = new Map<string, string>();
  for (const n of json.query?.normalized ?? []) remap.set(n.from, n.to);
  for (const r of json.query?.redirects ?? []) {
    const fromKey = remap.get(r.from) ?? r.from;
    remap.set(fromKey, r.to);
  }
  const byTitle = new Map<string, PageNode>();
  for (const p of json.query?.pages ?? []) {
    if (p.title) byTitle.set(p.title, p);
  }
  for (const original of titles) {
    let resolved = original;
    for (let i = 0; i < 3; i++) {
      const next = remap.get(resolved);
      if (!next || next === resolved) break;
      resolved = next;
    }
    const page = byTitle.get(resolved);
    if (!page || page.missing !== undefined) {
      result.set(original, { imageUrl: null, components: [] });
      continue;
    }
    const rev = page.revisions?.[0];
    const wikitext =
      rev?.slots?.main?.content ??
      rev?.slots?.main?.["*"] ??
      rev?.content ??
      rev?.["*"] ??
      "";
    const parsed = parseInfobox(wikitext);
    let imageUrl: string | null = page.thumbnail?.source ?? null;
    if (!imageUrl && parsed.imageFile) {
      // Special:Filepath redirects to the canonical image URL.
      imageUrl = `https://murder-mystery-2.fandom.com/wiki/Special:Filepath/${encodeURIComponent(parsed.imageFile)}`;
    }
    result.set(original, { imageUrl, components: parsed.components });
  }
  return result;
}

/**
 * Batch-resolve `File:<Name>.<ext>` titles to their canonical image URLs via
 * `prop=imageinfo`. Missing files are returned as `null` so callers can cache
 * the negative result.
 */
async function fetchFileImages(
  titles: string[],
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  if (titles.length === 0) return result;
  const params = new URLSearchParams({
    action: "query",
    titles: titles.join("|"),
    prop: "imageinfo",
    iiprop: "url",
    format: "json",
    formatversion: "2",
  });
  const res = await fetch(`${API_URL}?${params.toString()}`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`Fandom file API HTTP ${res.status}`);
  const json = (await res.json()) as {
    query?: {
      pages?: {
        title?: string;
        missing?: boolean;
        imageinfo?: { url?: string }[];
      }[];
      normalized?: { from: string; to: string }[];
    };
  };
  const remap = new Map<string, string>();
  for (const n of json.query?.normalized ?? []) remap.set(n.from, n.to);
  const byTitle = new Map<string, string | null>();
  for (const p of json.query?.pages ?? []) {
    if (!p.title) continue;
    byTitle.set(p.title, p.imageinfo?.[0]?.url ?? null);
  }
  for (const original of titles) {
    const resolved = remap.get(original) ?? original;
    result.set(original, byTitle.get(resolved) ?? null);
  }
  return result;
}

export interface SetEnrichInput {
  name: string;
}

export interface EnrichedSet {
  imageUrl?: string;
  components?: string[];
}

/**
 * For every Set item, look up its Wiki-Bot project page on the MM2 fandom
 * and return any image and components found. Results (including misses) are
 * cached for `CACHE_TTL_MS` so repeat scrapes don't re-query the wiki.
 *
 * Note: this only fetches **info** (image + component list). Item values and
 * demand still come exclusively from supremevalues.com.
 */
export async function enrichSets(
  items: SetEnrichInput[],
): Promise<Map<string, EnrichedSet>> {
  const out = new Map<string, EnrichedSet>();
  const cache = await readCache();
  const stale = Date.now() - cache.fetchedAt > CACHE_TTL_MS;

  // Build (set name → candidate Wiki-Bot titles) and collect titles we need
  // to fetch (cache miss or expired).
  const itemTitles: { name: string; titles: string[] }[] = [];
  const unknownTitles = new Set<string>();
  for (const it of items) {
    const titles = setNameVariants(it.name).map(wikiBotTitle);
    itemTitles.push({ name: it.name, titles });
    for (const t of titles) {
      if (stale || !(t in cache.sets)) unknownTitles.add(t);
    }
  }

  const allUnknown = [...unknownTitles];
  let fetched = 0;
  for (let i = 0; i < allUnknown.length; i += 50) {
    const batch = allUnknown.slice(i, i + 50);
    try {
      const result = await fetchSetPages(batch);
      for (const [title, entry] of result) cache.sets[title] = entry;
      fetched += batch.length;
    } catch (err) {
      logger.warn(
        { err: String(err), batchStart: i },
        "Fandom set batch failed",
      );
    }
    if (i + 50 < allUnknown.length) await new Promise((r) => setTimeout(r, 250));
  }

  // First pass: pick image + components from Wiki-Bot variants.
  const itemImages = new Map<string, string | undefined>();
  const itemComponents = new Map<string, string[] | undefined>();
  for (const { name, titles } of itemTitles) {
    for (const t of titles) {
      const entry = cache.sets[t];
      if (!entry) continue;
      if (!itemImages.get(name) && entry.imageUrl) {
        itemImages.set(name, entry.imageUrl);
      }
      if (!itemComponents.get(name) && entry.components.length > 0) {
        itemComponents.set(name, entry.components);
      }
      if (itemImages.get(name) && itemComponents.get(name)) break;
    }
  }

  // Second pass: for items still missing an image, try direct File: lookups
  // (e.g. File:Borealis Set.jpg) — works even when no Wiki-Bot subpage exists.
  const itemFileTitles: { name: string; titles: string[] }[] = [];
  const unknownFiles = new Set<string>();
  for (const it of items) {
    if (itemImages.get(it.name)) continue;
    const titles = fileNameVariants(it.name);
    itemFileTitles.push({ name: it.name, titles });
    for (const t of titles) {
      if (stale || !(t in cache.sets)) unknownFiles.add(t);
    }
  }

  const allUnknownFiles = [...unknownFiles];
  let fetchedFiles = 0;
  for (let i = 0; i < allUnknownFiles.length; i += 50) {
    const batch = allUnknownFiles.slice(i, i + 50);
    try {
      const result = await fetchFileImages(batch);
      for (const [title, url] of result) {
        cache.sets[title] = { imageUrl: url, components: [] };
      }
      fetchedFiles += batch.length;
    } catch (err) {
      logger.warn(
        { err: String(err), batchStart: i },
        "Fandom file batch failed",
      );
    }
    if (i + 50 < allUnknownFiles.length) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  for (const { name, titles } of itemFileTitles) {
    for (const t of titles) {
      const entry = cache.sets[t];
      if (entry?.imageUrl) {
        itemImages.set(name, entry.imageUrl);
        break;
      }
    }
  }

  if (fetched > 0 || fetchedFiles > 0) {
    cache.fetchedAt = Date.now();
    try {
      await writeCache(cache);
    } catch (err) {
      logger.warn({ err: String(err) }, "Failed to persist fandom-sets cache");
    }
  }

  for (const it of items) {
    const imageUrl = itemImages.get(it.name);
    const components = itemComponents.get(it.name);
    if (!imageUrl && !components) continue;
    const chosen: EnrichedSet = {};
    if (imageUrl) chosen.imageUrl = imageUrl;
    if (components && components.length > 0) chosen.components = components;
    out.set(it.name, chosen);
  }

  if (fetched > 0 || fetchedFiles > 0) {
    logger.info(
      { fetched, fetchedFiles, matched: out.size, total: items.length },
      "Enriched set info from fandom wiki",
    );
  }
  return out;
}
