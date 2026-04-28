import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  type ColorResolvable,
  type MessageActionRowComponentBuilder,
} from "discord.js";
import type { Item } from "../lib/values";
import type { CalcResult, SideTotals, SumResult, TradeResult } from "../lib/calculator";

const TIER_COLORS: Record<string, ColorResolvable> = {
  Chroma: 0xff4dd2,
  Ancient: 0x9b59b6,
  Vintage: 0xe67e22,
  Unique: 0x1abc9c,
  Legendary: 0x3498db,
  Pet: 0x2ecc71,
  Set: 0xe91e63,
  Evo: 0x00bcd4,
  Rare: 0x607d8b,
  Uncommon: 0x9e9e9e,
  Common: 0x795548,
  Misc: 0x95a5a6,
};

const TREND_ICON = {
  rising: "▲",
  falling: "▼",
  stable: "▬",
} as const;

export const LIST_PAGE_SIZE = 10;

function demandBar(demand: number): string {
  const filled = Math.max(0, Math.min(10, Math.round(demand)));
  return "█".repeat(filled) + "░".repeat(10 - filled) + ` ${filled}/10`;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

export function buildItemEmbed(item: Item): EmbedBuilder {
  const color = TIER_COLORS[item.tier];
  const valueStr =
    item.rangeLow != null && item.rangeHigh != null && item.rangeHigh !== item.rangeLow
      ? `\`${fmt(item.value)}\`  _(range ${fmt(item.rangeLow)} – ${fmt(item.rangeHigh)})_`
      : `\`${fmt(item.value)}\``;

  const trendStr = item.stability
    ? `${TREND_ICON[item.trend]} ${item.stability}`
    : `${TREND_ICON[item.trend]} ${item.trend}`;

  // Show the type label when it adds info beyond the rarity (avoids
  // duplicates like "Set • Set" or "Pet • Pet"). Gun/Knife data is sourced
  // from the MM2 fandom wiki, with a heuristic fallback for new items.
  const showType = item.type.toLowerCase() !== item.rarity.toLowerCase();
  const description = showType
    ? `**${item.rarity}** • ${item.type}`
    : `**${item.rarity}**`;

  const embed = new EmbedBuilder().setTitle(item.name).setDescription(description);
  if (color !== undefined) embed.setColor(color);
  embed
    .addFields(
      { name: "Value", value: valueStr, inline: true },
      { name: "Trend", value: trendStr, inline: true },
      {
        name: "Last Change",
        value: item.lastChange ? `\`${item.lastChange}\`` : "—",
        inline: true,
      },
      { name: "Demand", value: `\`${demandBar(item.demand)}\`` },
    );

  if (item.contains && item.contains.length > 0) {
    embed.addFields({
      name: "Includes",
      value: item.contains.map((c) => `• ${c}`).join("\n"),
    });
  }

  const meta: string[] = [];
  if (item.origin) meta.push(`**Origin:** ${item.origin}`);
  if (item.flippability) meta.push(`**Flippability:** ${item.flippability}`);
  if (meta.length) embed.addFields({ name: "Details", value: meta.join("\n") });

  if (item.imageUrl) embed.setThumbnail(item.imageUrl);

  embed.setFooter({ text: "MM2 Value Bot" }).setTimestamp(new Date());

  return embed;
}

export function buildNotFoundEmbed(query: string, suggestions: Item[] = []): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle("Item not found")
    .setDescription(`Could not find an item matching **${query}**.`);
  if (suggestions.length > 0) {
    embed.addFields({
      name: "Did you mean…",
      value: suggestions
        .map((s) => `• **${s.name}** — ${s.rarity} (\`${fmt(s.value)}\`)`)
        .join("\n"),
    });
  }
  embed.addFields({
    name: "Tips",
    value: `Try \`.search ${query}\` for a wider list, or \`.list ${suggestions[0]?.tier.toLowerCase() ?? "godly"}\` to browse a tier.`,
  });
  return embed;
}

function sideField(label: string, side: SideTotals): { name: string; value: string; inline: boolean } {
  const itemList =
    side.items
      .map((i) => `• ${i.name} — \`${fmt(i.value)}\` (D ${i.demand}/10)`)
      .join("\n") || "—";
  const unknown =
    side.unknownNames.length > 0
      ? `\n_Unknown: ${side.unknownNames.join(", ")}_`
      : "";
  return {
    name: `${label} • Total \`${fmt(side.totalValue)}\` • Avg Demand ${side.avgDemand.toFixed(1)}/10`,
    value: itemList + unknown,
    inline: false,
  };
}

export function buildCalcEmbed(result: CalcResult): EmbedBuilder {
  if (result.kind === "sum") return buildSumEmbed(result);
  return buildTradeEmbed(result);
}

function buildTradeEmbed(result: TradeResult): EmbedBuilder {
  const verdictColor: Record<TradeResult["verdict"], number> = {
    WIN: 0x2ecc71,
    OVERPAY: 0x27ae60,
    FAIR: 0xf1c40f,
    LOSS: 0xe74c3c,
  };

  const arrow = result.diff > 0 ? "▲" : result.diff < 0 ? "▼" : "▬";
  const diffStr = `${arrow} ${fmt(Math.abs(result.diff))} (${result.diffPercent.toFixed(1)}%)`;

  return new EmbedBuilder()
    .setColor(verdictColor[result.verdict])
    .setTitle(`Trade Calculator — ${result.fairnessLabel}`)
    .addFields(
      sideField("Your Side", result.left),
      sideField("Their Side", result.right),
      {
        name: "Difference",
        value: `\`${diffStr}\` in favor of **${result.diff >= 0 ? "you" : "them"}**`,
        inline: false,
      },
    )
    .setFooter({ text: "Format: item1 + item2 vs item3 + item4" })
    .setTimestamp(new Date());
}

function buildSumEmbed(result: SumResult): EmbedBuilder {
  const { side } = result;
  const itemList =
    side.items
      .map((i) => `• ${i.name} — \`${fmt(i.value)}\` (D ${i.demand}/10)`)
      .join("\n") || "—";
  const unknown =
    side.unknownNames.length > 0
      ? `\n_Unknown: ${side.unknownNames.join(", ")}_`
      : "";

  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("Calculator — Total")
    .addFields(
      { name: "Items", value: itemList + unknown, inline: false },
      { name: "Total Value", value: `\`${fmt(side.totalValue)}\``, inline: true },
      {
        name: "Avg Demand",
        value: `${side.avgDemand.toFixed(1)}/10`,
        inline: true,
      },
      {
        name: "Item Count",
        value: String(side.items.length),
        inline: true,
      },
    )
    .setFooter({ text: "Tip: add `vs <items>` to compare two sides" })
    .setTimestamp(new Date());
}

export function buildListEmbed(
  tier: string,
  items: Item[],
  page: number,
  query?: string,
): EmbedBuilder {
  const color = TIER_COLORS[tier];
  const totalPages = Math.max(1, Math.ceil(items.length / LIST_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const start = safePage * LIST_PAGE_SIZE;
  const slice = items.slice(start, start + LIST_PAGE_SIZE);

  const lines = slice
    .map(
      (i, idx) =>
        `**${start + idx + 1}.** ${i.name} — \`${fmt(i.value)}\` ${TREND_ICON[i.trend]} D${i.demand}`,
    )
    .join("\n");

  const titleSuffix = query ? ` — search "${query}"` : "";
  const embed = new EmbedBuilder()
    .setTitle(`${tier}${titleSuffix} — ${items.length} items`)
    .setDescription(lines || "_no items_")
    .setFooter({
      text: `Page ${safePage + 1} / ${totalPages} • MM2 Value Bot`,
    });
  if (color !== undefined) embed.setColor(color);
  return embed;
}

export function buildListComponents(
  tiers: string[],
  selectedTier: string,
  page: number,
  totalPages: number,
  query?: string,
): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  const select = new StringSelectMenuBuilder()
    .setCustomId("list:tier")
    .setPlaceholder("Select a tier…")
    .addOptions(
      tiers.slice(0, 25).map((t) => ({
        label: t,
        value: t,
        default: t === selectedTier,
      })),
    );

  const safePage = Math.min(Math.max(0, page), Math.max(0, totalPages - 1));
  const queryEnc = query ? encodeURIComponent(query) : "";

  const prev = new ButtonBuilder()
    .setCustomId(`list:prev:${encodeURIComponent(selectedTier)}:${safePage}:${queryEnc}`)
    .setLabel("◀ Prev")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(safePage <= 0);

  const next = new ButtonBuilder()
    .setCustomId(`list:next:${encodeURIComponent(selectedTier)}:${safePage}:${queryEnc}`)
    .setLabel("Next ▶")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(safePage >= totalPages - 1);

  const search = new ButtonBuilder()
    .setCustomId(`list:search:${encodeURIComponent(selectedTier)}`)
    .setLabel(query ? `🔎 Search: "${query}"` : "🔎 Search")
    .setStyle(ButtonStyle.Primary);

  const clear = new ButtonBuilder()
    .setCustomId(`list:clear:${encodeURIComponent(selectedTier)}`)
    .setLabel("✖ Clear search")
    .setStyle(ButtonStyle.Danger)
    .setDisabled(!query);

  const selectRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(select);
  const buttonRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    prev,
    next,
    search,
    clear,
  );

  return [selectRow, buttonRow];
}

export function buildSearchEmbed(query: string, items: Item[]): EmbedBuilder {
  const lines = items
    .map(
      (i) =>
        `• **${i.name}** (${i.tier}) — \`${fmt(i.value)}\` ${TREND_ICON[i.trend]} D${i.demand}`,
    )
    .join("\n");
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`Search: "${query}"`)
    .setDescription(lines || "_no matches_")
    .setFooter({ text: `${items.length} result(s)` });
}

export function buildHelpEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("MM2 Value Bot — Commands")
    .setDescription(
      [
        "**Lookups**",
        "• **`.value <item>`** — value, demand, trend, image, origin",
        "• **`.demand <item>`** — quick demand lookup",
        "• **`.search <query>`** — find items by partial name or alias",
        "• **`.list [tier]`** — interactive list with dropdown, paging, and search",
        "• **`.tiers`** — list all tiers",
        "",
        "**Calculator**",
        "• **`.calc <a + b>`** — total value & avg demand",
        "• **`.calc <a + b> vs <c + d>`** — trade win/loss",
        "",
        "**Inventory**",
        "• **`.inventory`** — view & edit your inventory (buttons + dropdowns)",
        "• **`.inventory @user`** — view someone else's inventory",
        "• **`.find <item>`** — list users who own that item",
        "",
        "_Tip: short prefixes work — `c seer` and even `cseer` find **Chroma Seer**._",
      ].join("\n"),
    )
    .setFooter({ text: "Tip: try `.calc Chroma Seer + Eternal vs Corrupt`" });
}

export function buildHelpComponents(): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  const list = new ButtonBuilder()
    .setCustomId("help:list")
    .setLabel("📋 Browse Tiers")
    .setStyle(ButtonStyle.Primary);
  const inv = new ButtonBuilder()
    .setCustomId("help:inventory")
    .setLabel("🎒 My Inventory")
    .setStyle(ButtonStyle.Success);
  return [
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(list, inv),
  ];
}

export function buildItemComponents(
  item: Item,
): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  const find = new ButtonBuilder()
    .setCustomId(`item:find:${encodeURIComponent(item.name.toLowerCase())}`)
    .setLabel("🔍 Find Owners")
    .setStyle(ButtonStyle.Primary);
  const addToInv = new ButtonBuilder()
    .setCustomId(`item:addInv:${encodeURIComponent(item.name)}`)
    .setLabel("➕ Add to Inventory")
    .setStyle(ButtonStyle.Success);
  const browseTier = new ButtonBuilder()
    .setCustomId(`item:tier:${encodeURIComponent(item.tier)}`)
    .setLabel(`📋 Browse ${item.tier}`)
    .setStyle(ButtonStyle.Secondary);
  return [
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      find,
      addToInv,
      browseTier,
    ),
  ];
}

export function buildStatusEmbed(opts: {
  itemCount: number;
  isLive: boolean;
  lastUpdated: string;
  perCategory?: Record<string, number>;
  errors?: { slug: string; error: string }[];
}): EmbedBuilder {
  const cats = opts.perCategory
    ? Object.entries(opts.perCategory)
        .map(([k, v]) => `${k}: ${v}`)
        .join(" • ")
    : "—";
  const errLine =
    opts.errors && opts.errors.length > 0
      ? opts.errors.map((e) => `${e.slug}: ${e.error}`).join("\n")
      : "none";

  return new EmbedBuilder()
    .setColor(opts.isLive ? 0x2ecc71 : 0xf39c12)
    .setTitle("Dataset Status")
    .addFields(
      { name: "Items", value: String(opts.itemCount), inline: true },
      { name: "Mode", value: opts.isLive ? "🟢 Live (scraped)" : "🟡 Cached fallback", inline: true },
      { name: "Last Updated", value: opts.lastUpdated, inline: true },
      { name: "Per Category", value: cats || "—", inline: false },
      { name: "Errors", value: errLine, inline: false },
    );
}
