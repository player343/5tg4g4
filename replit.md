# Workspace

## Overview

MM2 Value Discord Bot — `artifacts/api-server` runs both an Express HTTP API and a Discord.js bot in one Node process. The bot answers MM2 (Roblox Murder Mystery 2) value, demand and trade-calculator queries with the `.` command prefix.

## Discord Bot

- Token: `DISCORD_BOT_TOKEN` secret (set via Replit Secrets).
- Required Discord intents: `Guilds`, `GuildMessages`, `MessageContent` (must be enabled in the Discord Developer Portal).
- Commands: `.help`, `.value <item>`, `.demand <item>`, `.calc <items>` (sum) / `.calc <a + b> vs <c + d>` (compare), `.search <query>`, `.list [tier]` (interactive: dropdown + paging + search modal), `.tiers`, `.inventory [@user]`, `.find <item>`. Admin-only (not advertised in `.help`): `.refresh`, `.status`.
- Tier-prefix abbreviations on lookups: `c seer` → "Chroma Seer" (also `ch`, `chr`, `chrom`; same for `v`/vintage, `a`/ancient, `u`/unique, `g`/godly). No-space prefixes like `cseer` → "Chroma Seer" also work for ≥2-char prefixes (`ch`, `chr`, `chrom`, `vint`, `anc`, `uni`, `god`, `leg`, `unc`, `com`). When a tier prefix is present the search is constrained to that tier first, so `c seer` won't match "Time Seer Set".
- Quick-action buttons attached to common embeds: `.help` → Browse Tiers / My Inventory / Status; `.value` → Find Owners / Add to Inventory / Browse Tier.

## Inventory & Find

- Persistent per-user inventory backed by Postgres (`inventory_items` table, see `lib/db/src/schema/inventory.ts`).
- `.inventory` (or `.inv`) shows your inventory with paging, an "Add / Set Item" button (modal: item name + quantity + mode `set`/`add`), a "Clear All" confirm flow, and a per-page "Remove" dropdown.
- `.inventory @user` opens another user's inventory in view-only mode (no edit buttons).
- Inventory rows use the canonical dataset name plus a lowercase key for joins; total value is computed live from the current dataset (`unitValue × quantity`).
- `.find <item>` (or `.f`) lists every tracked owner of that item, paginated 10 at a time, showing tag, quantity, and per-user total value, plus combined community totals.
- Bot logic in `artifacts/api-server/src/bot/index.ts`; embeds in `bot/embeds.ts` (lookups/list/help) and `bot/embeds-inventory.ts` (inventory/find).
- `.refresh` and `.status` require Discord `Administrator` permission.
- **Per-message owner gate** (`messageOwners` map + `assertComponentOwner` in `bot/index.ts`): every non-ephemeral reply with interactive components is recorded with the invoking user's ID. At the top of `handleInteraction`, any component click (button or select) that doesn't match the recorded owner is blocked with an ephemeral "🔒 This menu belongs to <@owner>" notice — including pagination, search, dropdowns, and `.inventory @user` view buttons. Modal submits are gated by the button click that opened them. Use the `replyOwned` / `interactionReplyOwned` / `interactionEditReplyOwned` helpers (instead of raw `message.reply` / `interaction.reply` / `interaction.editReply`) for any new non-ephemeral reply that includes components, so its owner is registered. Ephemeral replies (`flags: 64`) are private to the user by Discord and skip registration. Owner registry is in-memory with a 24h TTL and 5000-entry cap (LRU-style eviction); messages predating a bot restart fall back to public-by-default to avoid stranding old controls.
- **Live data**: `lib/scraper.ts` scrapes 12 categories from `https://supremevalues.com/mm2/<slug>` (chromas, ancients, vintages, godlies, uniques, sets, legendaries, rares, uncommons, commons, pets, misc) — ~506 items including value, demand, stability, origin, last change, image URL, and aliases. Initial scrape runs on bot startup; auto-refresh every 4 hours; `.refresh` command for on-demand reload (5-min cooldown).
- **Gun vs Knife typing**: supremevalues doesn't expose this, so `lib/fandom-types.ts` fetches `Category:Guns` and `Category:Knives` from `murder-mystery-2.fandom.com` (MediaWiki API) and caches the lists in `data/fandom-types.json` (7-day TTL). The scraper consults this lookup first, falling back to a name-suffix heuristic for unknown items.
- **Image enrichment**: `lib/fandom-images.ts` backfills any item missing an image (notably sets — supremevalues only has component images) by querying `prop=pageimages` on the MM2 fandom wiki in batches of 50 with normalize/redirect resolution. For sets, we also try the base name without the " Set" suffix. Results (including misses) are cached in `data/fandom-images.json` so repeat scrapes don't re-query.
- **Set info enrichment**: `lib/fandom-sets.ts` queries the community-maintained `Murder Mystery 2 Wiki:Wiki-Bot/<Set Name>` project pages on the MM2 fandom (per [the Wiki-Bot reference page](https://murder-mystery-2.fandom.com/wiki/Murder_Mystery_2_Wiki:Wiki-Bot)) using `action=query&prop=revisions|pageimages&formatversion=2`. We parse the Infobox `image=` field and the `'''Includes:''' [[link1]] and [[link2]]` line to populate `imageUrl` (fallback to `Special:Filepath`) and `contains` on Set items. Cached for 7 days in `data/fandom-sets.json`. **Values and demand are never sourced from the wiki** — those still come exclusively from supremevalues.com.
- **Set name variant generation** (`setNameVariants` in `lib/fandom-sets.ts`): supremevalues abbreviates several set names differently from the wiki, so we try multiple candidate page titles per set. Transforms applied: token swaps (`Ever ↔ Evergreen`); strip `Full ` prefix (`Full Bringer Set` → `Bringer Set`); strip parenthetical qualifiers (`Vampire Set (Legend.)` → `Vampire Set`, `Pumpkin Set (2019)` → `Pumpkin Set`, `Santa's Set (Legendary)` → `Santa's Set`); auto-append ` Set` suffix when missing.
- **Direct File: image fallback** (`fileNameVariants` + `fetchFileImages` in `lib/fandom-sets.ts`): for sets where no Wiki-Bot subpage exists, we fall back to looking up `File:<Set Name>.png|jpg` directly via `prop=imageinfo`. Variants tried per set: spaced/condensed names (`Borealis Set`/`BorealisSet`), apostrophe-preserving and apostrophe-stripped, with the Set-suffix and stripped-suffix forms — all combined with both `.png` and `.jpg`. This recovered images for sets like `Traveler's Set`, `Borealis Set`, and `Colored Seer Set` whose Wiki-Bot subpage doesn't exist. Negative results are cached as `null` to avoid re-querying.
- **Set components**: parsed from supremevalues "Contains - X, Y" row data (split on `,` and ` + ` for combined sets like "Chroma Bringer Set + Bringer Set") and shown in an `Includes` embed field. The wiki Wiki-Bot subpage components are only used as a fallback when supremevalues doesn't list any.
- **Set images**: supremevalues' per-set image is just a representative component (e.g. "Full Bringer Set" → Lightbringer.png), so for `tier === "Set"` we drop it from the primary slot and instead resolve the image in this priority order: (1) Wiki-Bot subpage image, (2) `prop=pageimages` thumbnail of the underlying wiki article, (3) direct `File:<Set Name>.png|jpg` lookup, (4) supremevalues' single-component image as a last-resort fallback (used only for sets the wiki has no page for at all). Each Set scrape preserves the supremevalues URL aside in `supremeSetImages` so the fallback is available without re-scraping.
- **Static Wiki-Bot index** (`WIKI_BOT_INDEX` in `lib/fandom-sets.ts`): baked-in 95-entry mapping derived from [the Wiki-Bot index page](https://murder-mystery-2.fandom.com/wiki/Murder_Mystery_2_Wiki:Wiki-Bot). When generating candidate page titles for a set, we consult this index first using each name seed (and after `setNameVariants` transforms) so we hit the canonical Wiki-Bot subpage on the first request without depending on wiki redirects.
- **Set name aliasing** (`TOKEN_EXPANSIONS` in `lib/fandom-sets.ts`): supremevalues sometimes uses different names than the wiki Wiki-Bot subpages. Token-level expansions translate between them so we still hit the canonical Wiki-Bot composite image. Currently mapped: `ever`↔`evergreen` (supreme `Chroma Ever Set` → wiki `Chroma Evergreen Set`) and `bauble`↔`ornament` (supreme `Bauble Set` / `Chroma Bauble Set` → wiki `Ornament Set` / `Chroma Ornament Set`, since the wiki kept the original "Ornament" naming on its Wiki-Bot subpages even after the in-game 2024 rename to "Bauble"). New aliases go in this map.
- **Set image enrichment ordering** (`lib/scraper.ts`): `enrichSets` runs **before** `enrichImages` for set items. The order matters: `enrichImages` queries `prop=pageimages` on the bare item name, which for sets returns a single-component knife/gun thumbnail rather than the proper composite (e.g. `prop=pageimages` on "Bauble" returns `2024Bauble.png`, just the knife, not the `Ornament_Set.png` composite). By running `enrichSets` first and only falling back to `enrichImages` when no Wiki-Bot subpage exists, we always prefer the proper composite. `enrichImages.candidateTitles` also no longer strips the trailing " Set" for Set tier items, for the same reason — that strip used to grab single-component articles.
- **Smart search**: `findItem` and `suggestItems` in `lib/values.ts` apply (1) tier-prefix expansion (`c seer` → "Chroma Seer", plus l/r/un/com/p prefixes), (2) common-typo correction (`legenday` → "legendary", `plazma` → "plasma", etc.), (3) repeated-character collapsing, (4) filler-word stripping (`set`, `knife`, `gun`, `the`...), (5) shortest-substring preference, and (6) fuzzy fallback with length-adapted thresholds. When `.value` doesn't find a match, the not-found embed shows up to 5 "Did you mean…" suggestions.
- **Fallback**: `src/data/mm2-values.json` (~80 curated items) used only if a scrape returns 0 items.
- Item search uses both display names and supremevalues' `data-aliases` for fuzzy matching.

## HTTP API (mounted at `/api`)

- `GET /api/healthz` — health check
- `GET /api/values` — full dataset
- `GET /api/values/search?q=<query>` — fuzzy search
- `GET /api/values/tier/:tier` — items in a tier
- `GET /api/values/:name` — single item by name (fuzzy)

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
