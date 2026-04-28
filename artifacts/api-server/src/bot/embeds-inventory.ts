import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  type MessageActionRowComponentBuilder,
} from "discord.js";
import type {
  InventoryEntry,
  InventorySummary,
  OwnerHit,
} from "../lib/inventory";
import type { Item } from "../lib/values";

export const INVENTORY_PAGE_SIZE = 10;
export const FIND_PAGE_SIZE = 10;

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

const TIER_EMOJI: Record<string, string> = {
  Chroma: "💎",
  Ancient: "🟣",
  Vintage: "🟠",
  Unique: "🔷",
  Godly: "✨",
  Legendary: "🔵",
  Pet: "🐾",
  Set: "🎁",
  Rare: "⚪",
  Uncommon: "⚫",
  Common: "🟤",
  Misc: "🔘",
  Evo: "🌀",
};

function tierBadge(item: Item | null): string {
  if (!item) return "❔";
  return TIER_EMOJI[item.tier] ?? "•";
}

export function buildInventoryEmbed(
  summary: InventorySummary,
  page: number,
  options: { ownerTag: string; selfView: boolean },
): EmbedBuilder {
  const totalPages = Math.max(1, Math.ceil(summary.entries.length / INVENTORY_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const start = safePage * INVENTORY_PAGE_SIZE;
  const slice = summary.entries.slice(start, start + INVENTORY_PAGE_SIZE);

  const lines = slice
    .map((e, idx) => {
      const badge = tierBadge(e.item);
      const value = e.item
        ? `\`${fmt(e.totalValue)}\``
        : "`?`";
      const unit = e.item && e.quantity > 1 ? ` _(${fmt(e.unitValue)} ea)_` : "";
      const unknown = e.item ? "" : " _(unknown item)_";
      return `**${start + idx + 1}.** ${badge} **${e.itemName}** × \`${e.quantity}\` — ${value}${unit}${unknown}`;
    })
    .join("\n");

  const title = options.selfView
    ? `🎒 Your Inventory`
    : `🎒 Inventory — ${options.ownerTag}`;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(title)
    .setDescription(lines || "_Empty inventory. Add items with the buttons below._")
    .addFields(
      {
        name: "Total Value",
        value: `\`${fmt(summary.totalValue)}\``,
        inline: true,
      },
      {
        name: "Items",
        value: `${summary.entries.length} entries (× ${summary.totalQuantity})`,
        inline: true,
      },
      {
        name: "Mode",
        value: options.selfView ? "Editing" : "Viewing",
        inline: true,
      },
    )
    .setFooter({
      text: `Page ${safePage + 1} / ${totalPages} • MM2 Value Bot`,
    });
  return embed;
}

interface InventoryComponentOpts {
  ownerId: string;
  viewerId: string;
  page: number;
  totalPages: number;
  hasItems: boolean;
  removableEntries: InventoryEntry[];
}

export function buildInventoryComponents(
  opts: InventoryComponentOpts,
): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  const isOwner = opts.ownerId === opts.viewerId;
  const safePage = Math.min(Math.max(0, opts.page), Math.max(0, opts.totalPages - 1));

  const prev = new ButtonBuilder()
    .setCustomId(`inv:prev:${opts.ownerId}:${safePage}`)
    .setLabel("◀ Prev")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(safePage <= 0);
  const next = new ButtonBuilder()
    .setCustomId(`inv:next:${opts.ownerId}:${safePage}`)
    .setLabel("Next ▶")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(safePage >= opts.totalPages - 1);
  const refresh = new ButtonBuilder()
    .setCustomId(`inv:refresh:${opts.ownerId}:${safePage}`)
    .setLabel("↻ Refresh")
    .setStyle(ButtonStyle.Secondary);

  const navRow = new ActionRowBuilder<MessageActionRowComponentBuilder>()
    .addComponents(prev, next, refresh);

  if (!isOwner) {
    return [navRow];
  }

  const add = new ButtonBuilder()
    .setCustomId(`inv:add:${opts.ownerId}:${safePage}`)
    .setLabel("➕ Add / Set Item")
    .setStyle(ButtonStyle.Success);
  const clear = new ButtonBuilder()
    .setCustomId(`inv:clearAsk:${opts.ownerId}:${safePage}`)
    .setLabel("🗑 Clear All")
    .setStyle(ButtonStyle.Danger)
    .setDisabled(!opts.hasItems);

  const editRow = new ActionRowBuilder<MessageActionRowComponentBuilder>()
    .addComponents(add, clear);

  const rows = [navRow, editRow];

  // Remove dropdown shows up to 25 items from the current page for quick removal.
  if (opts.removableEntries.length > 0) {
    const removeMenu = new StringSelectMenuBuilder()
      .setCustomId(`inv:remove:${opts.ownerId}:${safePage}`)
      .setPlaceholder("Remove an item from this page…")
      .addOptions(
        opts.removableEntries.slice(0, 25).map((e) => ({
          label:
            e.itemName.length > 90
              ? e.itemName.slice(0, 87) + "…"
              : e.itemName,
          value: e.itemNameLower,
          description: `× ${e.quantity}${e.item ? ` • ${fmt(e.totalValue)}` : ""}`,
        })),
      );
    rows.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(removeMenu),
    );
  }

  return rows;
}

export function buildClearConfirmEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle("⚠️ Clear entire inventory?")
    .setDescription("This will permanently delete every item in your inventory. This cannot be undone.");
}

export function buildClearConfirmComponents(
  ownerId: string,
  page: number,
): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  const yes = new ButtonBuilder()
    .setCustomId(`inv:clearYes:${ownerId}:${page}`)
    .setLabel("Yes, clear everything")
    .setStyle(ButtonStyle.Danger);
  const no = new ButtonBuilder()
    .setCustomId(`inv:clearNo:${ownerId}:${page}`)
    .setLabel("Cancel")
    .setStyle(ButtonStyle.Secondary);
  return [
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(yes, no),
  ];
}

export function buildFindEmbed(
  item: Item,
  hits: OwnerHit[],
  ownerTags: Record<string, string>,
  page: number,
): EmbedBuilder {
  const totalPages = Math.max(1, Math.ceil(hits.length / FIND_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const start = safePage * FIND_PAGE_SIZE;
  const slice = hits.slice(start, start + FIND_PAGE_SIZE);

  const lines =
    slice
      .map((h, idx) => {
        const tag = ownerTags[h.userId] ?? `<@${h.userId}>`;
        return `**${start + idx + 1}.** ${tag} — × \`${h.quantity}\` • \`${fmt(h.totalValue)}\``;
      })
      .join("\n") || "_No tracked owners yet._";

  const totalCommunityValue = hits.reduce((s, h) => s + h.totalValue, 0);
  const totalQuantity = hits.reduce((s, h) => s + h.quantity, 0);

  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`🔍 Owners of ${item.name}`)
    .setDescription(lines)
    .addFields(
      {
        name: "Owners",
        value: String(hits.length),
        inline: true,
      },
      {
        name: "Total Held",
        value: `× ${totalQuantity}`,
        inline: true,
      },
      {
        name: "Combined Value",
        value: `\`${fmt(totalCommunityValue)}\``,
        inline: true,
      },
    )
    .setFooter({
      text: `Page ${safePage + 1} / ${totalPages} • Item value: ${fmt(item.value)}`,
    });
}

export function buildFindComponents(
  itemNameLower: string,
  page: number,
  totalPages: number,
): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  const safePage = Math.min(Math.max(0, page), Math.max(0, totalPages - 1));
  const prev = new ButtonBuilder()
    .setCustomId(`find:prev:${encodeURIComponent(itemNameLower)}:${safePage}`)
    .setLabel("◀ Prev")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(safePage <= 0);
  const next = new ButtonBuilder()
    .setCustomId(`find:next:${encodeURIComponent(itemNameLower)}:${safePage}`)
    .setLabel("Next ▶")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(safePage >= totalPages - 1);
  return [
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(prev, next),
  ];
}
