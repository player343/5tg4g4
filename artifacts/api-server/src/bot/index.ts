import {
  ActionRowBuilder,
  Client,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  Partials,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type Interaction,
  type Message,
  type ModalActionRowComponentBuilder,
  type RepliableInteraction,
  type User,
} from "discord.js";
import { logger } from "../lib/logger";
import {
  findItem,
  getDataset,
  isLive,
  lastScrapeAttemptTime,
  listByTier,
  refreshFromScrape,
  searchItems,
  suggestItems,
  tiers,
} from "../lib/values";
import { calculate } from "../lib/calculator";
import {
  adjustItemQuantity,
  clearInventory,
  findOwnersOfItem,
  getInventory,
  removeItem,
  resolveItem,
  setItemQuantity,
} from "../lib/inventory";
import {
  buildCalcEmbed,
  buildHelpComponents,
  buildHelpEmbed,
  buildItemComponents,
  buildItemEmbed,
  buildListComponents,
  buildListEmbed,
  buildNotFoundEmbed,
  buildSearchEmbed,
  buildStatusEmbed,
  LIST_PAGE_SIZE,
} from "./embeds";
import {
  buildClearConfirmComponents,
  buildClearConfirmEmbed,
  buildFindComponents,
  buildFindEmbed,
  buildInventoryComponents,
  buildInventoryEmbed,
  FIND_PAGE_SIZE,
  INVENTORY_PAGE_SIZE,
} from "./embeds-inventory";

const PREFIX = ".";
const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
const REFRESH_COOLDOWN_MS = 5 * 60 * 1000;

let lastUserRefresh = 0;
let botClient: Client | null = null;

// ---------------------------------------------------------------------------
// Per-message owner gate
//
// Every non-ephemeral reply with interactive components (buttons, selects,
// modal triggers) is registered here so that only the user who originally
// invoked the command can drive its controls. A different user clicking a
// button gets a private "this menu belongs to X" notice instead of being
// able to paginate / clear / edit someone else's view.
//
// Older messages (e.g. predating a bot restart, or evicted by GC) are
// unregistered and fall back to public-by-default so we don't strand them.
// ---------------------------------------------------------------------------

interface OwnerEntry {
  ownerId: string;
  expiresAt: number;
}
const OWNER_TTL_MS = 24 * 60 * 60 * 1000;
const OWNER_MAX_ENTRIES = 5000;
const messageOwners = new Map<string, OwnerEntry>();

function gcMessageOwners(): void {
  if (messageOwners.size < OWNER_MAX_ENTRIES) return;
  const now = Date.now();
  for (const [k, v] of messageOwners) {
    if (v.expiresAt < now) messageOwners.delete(k);
  }
  if (messageOwners.size > OWNER_MAX_ENTRIES) {
    const excess = messageOwners.size - OWNER_MAX_ENTRIES;
    let dropped = 0;
    for (const k of messageOwners.keys()) {
      if (dropped++ >= excess) break;
      messageOwners.delete(k);
    }
  }
}

function rememberOwner(messageId: string | null | undefined, ownerId: string): void {
  if (!messageId) return;
  gcMessageOwners();
  messageOwners.set(messageId, {
    ownerId,
    expiresAt: Date.now() + OWNER_TTL_MS,
  });
}

function getMessageOwner(messageId: string): string | null {
  const entry = messageOwners.get(messageId);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    messageOwners.delete(messageId);
    return null;
  }
  return entry.ownerId;
}

/**
 * For component interactions (button click, select-menu choice), verify the
 * clicker matches the owner recorded for the parent message. Returns true if
 * the interaction may proceed. If not, sends an ephemeral notice and returns
 * false.
 */
async function assertComponentOwner(interaction: Interaction): Promise<boolean> {
  if (!interaction.isMessageComponent()) return true;
  const owner = getMessageOwner(interaction.message.id);
  if (!owner) return true; // Public-by-default for unregistered messages.
  if (owner === interaction.user.id) return true;
  await interaction.reply({
    content: `🔒 This menu belongs to <@${owner}>. Run the command yourself to control your own.`,
    flags: 64,
    allowedMentions: { parse: [] },
  });
  return false;
}

/**
 * Send a `message.reply(...)` and record the resulting message as owned by
 * the original message author. Use for any reply that includes components.
 */
async function replyOwned(
  message: Message,
  payload: Parameters<Message["reply"]>[0],
): Promise<Message> {
  const sent = await message.reply(payload);
  rememberOwner(sent.id, message.author.id);
  return sent;
}

/**
 * `interaction.reply(...)` followed by registering the resulting message as
 * owned by the interacting user. Use for non-ephemeral interaction replies
 * that include components.
 */
async function interactionReplyOwned(
  interaction: RepliableInteraction,
  payload: Parameters<RepliableInteraction["reply"]>[0],
): Promise<void> {
  await interaction.reply(payload);
  try {
    const sent = await interaction.fetchReply();
    rememberOwner(sent.id, interaction.user.id);
  } catch (err) {
    logger.warn({ err: String(err) }, "Failed to register owner for interaction reply");
  }
}

/**
 * `interaction.editReply(...)` after a `deferReply()` — register the
 * resulting message as owned by the interacting user.
 */
async function interactionEditReplyOwned(
  interaction: RepliableInteraction,
  payload: Parameters<RepliableInteraction["editReply"]>[0],
): Promise<void> {
  const sent = await interaction.editReply(payload);
  rememberOwner(sent.id, interaction.user.id);
}

function isAdmin(message: Message): boolean {
  if (!message.inGuild()) return false;
  const member = message.member;
  if (!member) return false;
  return member.permissions.has(PermissionFlagsBits.Administrator);
}

async function denyAdmin(message: Message, cmd: string): Promise<void> {
  await message.reply(`🔒 \`.${cmd}\` is restricted to server administrators.`);
}

export function startBot(): void {
  const token = process.env["DISCORD_BOT_TOKEN"];
  if (!token) {
    logger.warn("DISCORD_BOT_TOKEN not set — Discord bot will not start");
    return;
  }

  void initialScrape();
  setInterval(() => {
    void refreshFromScrape().catch((err: unknown) =>
      logger.warn({ err }, "Scheduled refresh failed"),
    );
  }, REFRESH_INTERVAL_MS);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });
  botClient = client;

  client.once(Events.ClientReady, (c) => {
    logger.info({ tag: c.user.tag }, "Discord bot ready");
    c.user.setActivity("MM2 trades • .help", { type: 3 });
  });

  client.on(Events.MessageCreate, async (message: Message) => {
    try {
      if (message.author.bot) return;
      if (!message.content.startsWith(PREFIX)) return;

      const raw = message.content.slice(PREFIX.length).trim();
      if (!raw) return;

      const spaceIdx = raw.indexOf(" ");
      const cmd = (spaceIdx === -1 ? raw : raw.slice(0, spaceIdx)).toLowerCase();
      const args = spaceIdx === -1 ? "" : raw.slice(spaceIdx + 1).trim();

      await handleCommand(message, cmd, args);
    } catch (err) {
      logger.error({ err }, "Error handling message");
    }
  });

  client.on(Events.InteractionCreate, (interaction: Interaction) => {
    void handleInteraction(interaction).catch((err: unknown) =>
      logger.error({ err }, "Error handling interaction"),
    );
  });

  client.on(Events.Error, (err) => {
    logger.error({ err }, "Discord client error");
  });

  client
    .login(token)
    .then(() => logger.info("Discord login OK"))
    .catch((err: unknown) => logger.error({ err }, "Discord login failed"));
}

async function initialScrape(): Promise<void> {
  logger.info("Starting initial scrape of supremevalues.com");
  const result = await refreshFromScrape();
  if (!result.ok) {
    logger.warn(
      { errors: result.errors },
      "Initial scrape failed — using cached fallback dataset",
    );
  }
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

async function handleCommand(
  message: Message,
  cmd: string,
  args: string,
): Promise<void> {
  switch (cmd) {
    case "help":
    case "commands": {
      await replyOwned(message, {
        embeds: [buildHelpEmbed()],
        components: buildHelpComponents(),
      });
      return;
    }

    case "value":
    case "v": {
      if (!args) {
        await message.reply("Usage: `.value <item name>`");
        return;
      }
      const item = findItem(args);
      if (!item) {
        await message.reply({
          embeds: [buildNotFoundEmbed(args, suggestItems(args, 5))],
        });
        return;
      }
      await replyOwned(message, {
        embeds: [buildItemEmbed(item)],
        components: buildItemComponents(item),
      });
      return;
    }

    case "demand":
    case "d": {
      if (!args) {
        await message.reply("Usage: `.demand <item name>`");
        return;
      }
      const item = findItem(args);
      if (!item) {
        await message.reply({
          embeds: [buildNotFoundEmbed(args, suggestItems(args, 5))],
        });
        return;
      }
      await message.reply(
        `**${item.name}** — Demand: \`${item.demand}/10\` • Stability: ${item.stability ?? item.trend}`,
      );
      return;
    }

    case "calc":
    case "calculator": {
      if (!args) {
        await message.reply(
          "Usage: `.calc <items>` to total, or `.calc <items> vs <items>` to compare.\nExample: `.calc Chroma Seer + Eternal` or `.calc Chroma Seer vs Eternal + Corrupt`",
        );
        return;
      }
      const result = calculate(args);
      if (!result) {
        await message.reply(
          "Could not parse input. Use `+` between items, `vs` between sides.",
        );
        return;
      }
      await message.reply({ embeds: [buildCalcEmbed(result)] });
      return;
    }

    case "search":
    case "s": {
      if (!args) {
        await message.reply("Usage: `.search <query>`");
        return;
      }
      const results = searchItems(args, 15);
      await message.reply({ embeds: [buildSearchEmbed(args, results)] });
      return;
    }

    case "list":
    case "l": {
      const all = tiers();
      if (all.length === 0) {
        await message.reply("No tiers loaded yet — try again in a moment.");
        return;
      }
      const tier =
        (args && all.find((t) => t.toLowerCase() === args.toLowerCase())) ||
        all[0]!;
      const items = listByTier(tier);
      const totalPages = Math.max(1, Math.ceil(items.length / LIST_PAGE_SIZE));
      await replyOwned(message, {
        embeds: [buildListEmbed(tier, items, 0)],
        components: buildListComponents(all, tier, 0, totalPages),
      });
      return;
    }

    case "tiers": {
      await message.reply(`Available tiers: **${tiers().join(", ")}**`);
      return;
    }

    case "inventory":
    case "inv": {
      await handleInventoryCommand(message, args);
      return;
    }

    case "find":
    case "f": {
      await handleFindCommand(message, args);
      return;
    }

    case "refresh": {
      if (!isAdmin(message)) {
        await denyAdmin(message, cmd);
        return;
      }
      const since = Date.now() - lastUserRefresh;
      if (since < REFRESH_COOLDOWN_MS) {
        const wait = Math.ceil((REFRESH_COOLDOWN_MS - since) / 1000);
        await message.reply(`Cool down: try again in ${wait}s.`);
        return;
      }
      lastUserRefresh = Date.now();
      await message.reply("Refreshing values…");
      const result = await refreshFromScrape();
      await message.reply(result.ok ? `✅ ${result.message}` : `⚠️ ${result.message}`);
      return;
    }

    case "status": {
      if (!isAdmin(message)) {
        await denyAdmin(message, cmd);
        return;
      }
      const ds = getDataset();
      await message.reply({
        embeds: [
          buildStatusEmbed({
            itemCount: ds.items.length,
            isLive: isLive(),
            lastUpdated: ds.lastUpdated,
            perCategory: ds.perCategory,
            errors: ds.errors,
          }),
        ],
      });
      return;
    }

    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// .inventory
// ---------------------------------------------------------------------------

async function handleInventoryCommand(
  message: Message,
  args: string,
): Promise<void> {
  // Resolve target user: first mention wins, otherwise self.
  const target = message.mentions.users.first() ?? message.author;
  await renderInventoryReply(message, target.id, target.tag, 0);
}

async function renderInventoryReply(
  message: Message,
  ownerId: string,
  ownerTag: string,
  page: number,
): Promise<void> {
  const summary = await getInventory(ownerId);
  const totalPages = Math.max(1, Math.ceil(summary.entries.length / INVENTORY_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const start = safePage * INVENTORY_PAGE_SIZE;
  const slice = summary.entries.slice(start, start + INVENTORY_PAGE_SIZE);

  await replyOwned(message, {
    embeds: [
      buildInventoryEmbed(summary, safePage, {
        ownerTag,
        selfView: ownerId === message.author.id,
      }),
    ],
    components: buildInventoryComponents({
      ownerId,
      viewerId: message.author.id,
      page: safePage,
      totalPages,
      hasItems: summary.entries.length > 0,
      removableEntries: slice,
    }),
    allowedMentions: { parse: [] },
  });
}

async function rerenderInventory(
  interaction: RepliableInteraction,
  ownerId: string,
  page: number,
): Promise<void> {
  const summary = await getInventory(ownerId);
  const totalPages = Math.max(1, Math.ceil(summary.entries.length / INVENTORY_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const start = safePage * INVENTORY_PAGE_SIZE;
  const slice = summary.entries.slice(start, start + INVENTORY_PAGE_SIZE);
  const ownerTag = await fetchUserTag(ownerId);

  const payload = {
    embeds: [
      buildInventoryEmbed(summary, safePage, {
        ownerTag,
        selfView: ownerId === interaction.user.id,
      }),
    ],
    components: buildInventoryComponents({
      ownerId,
      viewerId: interaction.user.id,
      page: safePage,
      totalPages,
      hasItems: summary.entries.length > 0,
      removableEntries: slice,
    }),
  };

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(payload);
    return;
  }
  if (interaction.isMessageComponent()) {
    await interaction.update(payload);
  }
}

async function fetchUserTag(userId: string): Promise<string> {
  if (!botClient) return `<@${userId}>`;
  try {
    const u = await botClient.users.fetch(userId);
    return u.tag;
  } catch {
    return `<@${userId}>`;
  }
}

// ---------------------------------------------------------------------------
// .find
// ---------------------------------------------------------------------------

async function handleFindCommand(message: Message, args: string): Promise<void> {
  if (!args) {
    await message.reply("Usage: `.find <item>`");
    return;
  }
  const item = findItem(args);
  if (!item) {
    await message.reply({
      embeds: [buildNotFoundEmbed(args, suggestItems(args, 5))],
    });
    return;
  }
  const hits = await findOwnersOfItem(item);
  const ownerTags = await resolveOwnerTags(hits.slice(0, FIND_PAGE_SIZE).map((h) => h.userId));
  const totalPages = Math.max(1, Math.ceil(hits.length / FIND_PAGE_SIZE));
  await replyOwned(message, {
    embeds: [buildFindEmbed(item, hits, ownerTags, 0)],
    components: buildFindComponents(item.name.toLowerCase(), 0, totalPages),
    allowedMentions: { parse: [] },
  });
}

async function rerenderFind(
  interaction: RepliableInteraction,
  itemNameLower: string,
  page: number,
): Promise<void> {
  const item = findItem(itemNameLower);
  if (!item) {
    if (interaction.isMessageComponent()) {
      await interaction.update({ content: "Item is no longer available.", embeds: [], components: [] });
    }
    return;
  }
  const hits = await findOwnersOfItem(item);
  const totalPages = Math.max(1, Math.ceil(hits.length / FIND_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const start = safePage * FIND_PAGE_SIZE;
  const slice = hits.slice(start, start + FIND_PAGE_SIZE);
  const ownerTags = await resolveOwnerTags(slice.map((h) => h.userId));

  const payload = {
    embeds: [buildFindEmbed(item, hits, ownerTags, safePage)],
    components: buildFindComponents(item.name.toLowerCase(), safePage, totalPages),
  };

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(payload);
    return;
  }
  if (interaction.isMessageComponent()) {
    await interaction.update(payload);
  }
}

async function resolveOwnerTags(userIds: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!botClient) {
    for (const id of userIds) out[id] = `<@${id}>`;
    return out;
  }
  await Promise.all(
    userIds.map(async (id) => {
      try {
        const u: User = await botClient!.users.fetch(id);
        out[id] = `${u.tag} (<@${id}>)`;
      } catch {
        out[id] = `<@${id}>`;
      }
    }),
  );
  return out;
}

// ---------------------------------------------------------------------------
// Interactions
// ---------------------------------------------------------------------------

interface ListState {
  tier: string;
  page: number;
  query: string;
}

function parseListCustomId(customId: string): { action: string; state: ListState } | null {
  const parts = customId.split(":");
  if (parts[0] !== "list" || parts.length < 2) return null;
  const action = parts[1]!;
  const tier = parts[2] ? decodeURIComponent(parts[2]) : "";
  const page = parts[3] ? Number(parts[3]) : 0;
  const query = parts[4] ? decodeURIComponent(parts[4]) : "";
  return { action, state: { tier, page: Number.isFinite(page) ? page : 0, query } };
}

function itemsForState(state: ListState) {
  const base = listByTier(state.tier);
  if (!state.query) return base;
  const q = state.query.toLowerCase();
  return base.filter((i) => {
    if (i.name.toLowerCase().includes(q)) return true;
    if (i.aliases?.some((a) => a.toLowerCase().includes(q))) return true;
    return false;
  });
}

async function renderList(
  interaction: RepliableInteraction,
  state: ListState,
): Promise<void> {
  const all = tiers();
  const items = itemsForState(state);
  const totalPages = Math.max(1, Math.ceil(items.length / LIST_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, state.page), totalPages - 1);

  const payload = {
    embeds: [buildListEmbed(state.tier, items, safePage, state.query || undefined)],
    components: buildListComponents(
      all,
      state.tier,
      safePage,
      totalPages,
      state.query || undefined,
    ),
  };

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(payload);
    return;
  }
  if (interaction.isMessageComponent()) {
    await interaction.update(payload);
  }
}

async function handleInteraction(interaction: Interaction): Promise<void> {
  // Block component clicks from anyone who isn't the original invoker of
  // the parent menu. Modal submits are intentionally skipped here — they're
  // gated by the button click that opened them, and the per-handler owner
  // checks below already verify the submitter.
  if (!(await assertComponentOwner(interaction))) return;

  // ---------------- list (existing) ----------------
  if (interaction.isStringSelectMenu() && interaction.customId === "list:tier") {
    const tier = interaction.values[0]!;
    await renderList(interaction, { tier, page: 0, query: "" });
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith("list:")) {
    const parsed = parseListCustomId(interaction.customId);
    if (!parsed) return;
    const { action, state } = parsed;

    if (action === "prev") {
      await renderList(interaction, { ...state, page: state.page - 1 });
      return;
    }
    if (action === "next") {
      await renderList(interaction, { ...state, page: state.page + 1 });
      return;
    }
    if (action === "clear") {
      await renderList(interaction, { tier: state.tier, page: 0, query: "" });
      return;
    }
    if (action === "search") {
      const modal = new ModalBuilder()
        .setCustomId(`list:searchSubmit:${encodeURIComponent(state.tier)}`)
        .setTitle(`Search ${state.tier}`)
        .addComponents(
          new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("query")
              .setLabel("Filter items by name or alias")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(64),
          ),
        );
      await interaction.showModal(modal);
      return;
    }
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith("list:searchSubmit:")) {
    const tier = decodeURIComponent(
      interaction.customId.slice("list:searchSubmit:".length),
    );
    const query = interaction.fields.getTextInputValue("query").trim();
    await interaction.deferUpdate();
    await renderList(interaction, { tier, page: 0, query });
    return;
  }

  // ---------------- help quick-action buttons ----------------
  if (interaction.isButton() && interaction.customId.startsWith("help:")) {
    const action = interaction.customId.slice("help:".length);
    if (action === "list") {
      const all = tiers();
      const tier = all[0]!;
      const items = listByTier(tier);
      const totalPages = Math.max(1, Math.ceil(items.length / LIST_PAGE_SIZE));
      await interaction.reply({
        embeds: [buildListEmbed(tier, items, 0)],
        components: buildListComponents(all, tier, 0, totalPages),
        flags: 64, // ephemeral
      });
      return;
    }
    if (action === "inventory") {
      const summary = await getInventory(interaction.user.id);
      const totalPages = Math.max(1, Math.ceil(summary.entries.length / INVENTORY_PAGE_SIZE));
      const slice = summary.entries.slice(0, INVENTORY_PAGE_SIZE);
      await interaction.reply({
        embeds: [
          buildInventoryEmbed(summary, 0, {
            ownerTag: interaction.user.tag,
            selfView: true,
          }),
        ],
        components: buildInventoryComponents({
          ownerId: interaction.user.id,
          viewerId: interaction.user.id,
          page: 0,
          totalPages,
          hasItems: summary.entries.length > 0,
          removableEntries: slice,
        }),
        flags: 64,
      });
      return;
    }
  }

  // ---------------- value-embed quick-action buttons ----------------
  if (interaction.isButton() && interaction.customId.startsWith("item:")) {
    const parts = interaction.customId.split(":");
    const action = parts[1];
    const param = parts[2] ? decodeURIComponent(parts[2]) : "";
    if (action === "find") {
      await interaction.deferReply();
      const item = findItem(param);
      if (!item) {
        await interaction.editReply({ content: "Item not found." });
        return;
      }
      const hits = await findOwnersOfItem(item);
      const slice = hits.slice(0, FIND_PAGE_SIZE);
      const tags = await resolveOwnerTags(slice.map((h) => h.userId));
      const totalPages = Math.max(1, Math.ceil(hits.length / FIND_PAGE_SIZE));
      await interactionEditReplyOwned(interaction, {
        embeds: [buildFindEmbed(item, hits, tags, 0)],
        components: buildFindComponents(item.name.toLowerCase(), 0, totalPages),
        allowedMentions: { parse: [] },
      });
      return;
    }
    if (action === "addInv") {
      // Open the add-modal used by the inventory view, scoped to self. Tag
      // the source as "item" so the submit handler doesn't try to overwrite
      // the value embed with an inventory view.
      const modal = buildAddOrSetModal(interaction.user.id, 0, param, "item");
      await interaction.showModal(modal);
      return;
    }
    if (action === "tier") {
      const all = tiers();
      const tier =
        all.find((t) => t.toLowerCase() === param.toLowerCase()) ?? all[0]!;
      const items = listByTier(tier);
      const totalPages = Math.max(1, Math.ceil(items.length / LIST_PAGE_SIZE));
      await interaction.reply({
        embeds: [buildListEmbed(tier, items, 0)],
        components: buildListComponents(all, tier, 0, totalPages),
        flags: 64,
      });
      return;
    }
  }

  // ---------------- find pagination ----------------
  if (interaction.isButton() && interaction.customId.startsWith("find:")) {
    const parts = interaction.customId.split(":");
    const action = parts[1];
    const itemNameLower = parts[2] ? decodeURIComponent(parts[2]) : "";
    const page = parts[3] ? Number(parts[3]) : 0;
    if (action === "prev") {
      await rerenderFind(interaction, itemNameLower, page - 1);
      return;
    }
    if (action === "next") {
      await rerenderFind(interaction, itemNameLower, page + 1);
      return;
    }
  }

  // ---------------- inventory ----------------
  if (interaction.isButton() && interaction.customId.startsWith("inv:")) {
    const parts = interaction.customId.split(":");
    const action = parts[1];
    const ownerId = parts[2] ?? "";
    const page = parts[3] ? Number(parts[3]) : 0;
    if (!ownerId) return;

    const isOwner = ownerId === interaction.user.id;

    if (action === "prev") {
      await rerenderInventory(interaction, ownerId, page - 1);
      return;
    }
    if (action === "next") {
      await rerenderInventory(interaction, ownerId, page + 1);
      return;
    }
    if (action === "refresh") {
      await rerenderInventory(interaction, ownerId, page);
      return;
    }
    if (action === "add") {
      if (!isOwner) {
        await interaction.reply({ content: "🔒 You can only edit your own inventory.", flags: 64 });
        return;
      }
      await interaction.showModal(buildAddOrSetModal(ownerId, page, "", "inv"));
      return;
    }
    if (action === "clearAsk") {
      if (!isOwner) {
        await interaction.reply({ content: "🔒 You can only edit your own inventory.", flags: 64 });
        return;
      }
      await interaction.reply({
        embeds: [buildClearConfirmEmbed()],
        components: buildClearConfirmComponents(ownerId, page),
        flags: 64,
      });
      return;
    }
    if (action === "clearYes") {
      if (!isOwner) {
        await interaction.reply({ content: "🔒 You can only edit your own inventory.", flags: 64 });
        return;
      }
      const removed = await clearInventory(ownerId);
      await interaction.update({
        content: `🗑 Cleared ${removed} item entr${removed === 1 ? "y" : "ies"}.`,
        embeds: [],
        components: [],
      });
      return;
    }
    if (action === "clearNo") {
      await interaction.update({
        content: "Cancelled.",
        embeds: [],
        components: [],
      });
      return;
    }
  }

  if (
    interaction.isStringSelectMenu() &&
    interaction.customId.startsWith("inv:remove:")
  ) {
    const parts = interaction.customId.split(":");
    const ownerId = parts[2] ?? "";
    const page = parts[3] ? Number(parts[3]) : 0;
    if (ownerId !== interaction.user.id) {
      await interaction.reply({ content: "🔒 You can only edit your own inventory.", flags: 64 });
      return;
    }
    const itemNameLower = interaction.values[0];
    if (itemNameLower) {
      // Look up the canonical name from the dataset (case-preserving).
      const item = findItem(itemNameLower);
      const canonical = item ? item.name : itemNameLower;
      await removeItem(ownerId, canonical);
    }
    await rerenderInventory(interaction, ownerId, page);
    return;
  }

  if (
    interaction.isModalSubmit() &&
    interaction.customId.startsWith("inv:addSubmit:")
  ) {
    // Format: inv:addSubmit:<source>:<ownerId>:<page>
    const parts = interaction.customId.split(":");
    const source = parts[2] ?? "inv";
    const ownerId = parts[3] ?? "";
    const page = parts[4] ? Number(parts[4]) : 0;
    if (ownerId !== interaction.user.id) {
      await interaction.reply({ content: "🔒 You can only edit your own inventory.", flags: 64 });
      return;
    }
    const itemRaw = interaction.fields.getTextInputValue("item").trim();
    const qtyRaw = interaction.fields.getTextInputValue("quantity").trim();
    const modeRaw = interaction.fields.getTextInputValue("mode").trim().toLowerCase();
    const qty = Number.parseInt(qtyRaw, 10);
    if (!itemRaw || !Number.isFinite(qty)) {
      await interaction.reply({
        content: "⚠️ Invalid input. Provide an item name and a number for quantity.",
        flags: 64,
      });
      return;
    }
    const item = resolveItem(itemRaw);
    if (!item) {
      const suggestions = suggestItems(itemRaw, 5);
      const hint =
        suggestions.length > 0
          ? `\nDid you mean: ${suggestions.map((s) => `**${s.name}**`).join(", ")}`
          : "";
      await interaction.reply({
        content: `⚠️ Could not find item **${itemRaw}**.${hint}`,
        flags: 64,
      });
      return;
    }
    const mode = modeRaw === "add" ? "add" : "set";
    let newQty = qty;
    if (mode === "add") {
      newQty = await adjustItemQuantity(ownerId, item.name, qty);
    } else {
      await setItemQuantity(ownerId, item.name, Math.max(0, qty));
      newQty = Math.max(0, qty);
    }

    if (source === "inv") {
      // Launched from the inventory view — re-render the inventory message in
      // place. We MUST `deferUpdate()` first: a fresh modal-submit interaction
      // is neither `deferred` nor a `MessageComponent`, so without this
      // `rerenderInventory` would silently do nothing and Discord would show
      // "interaction failed". `deferUpdate` acknowledges the interaction and
      // marks it as the source-message edit, so the subsequent `editReply`
      // inside `rerenderInventory` updates the original inventory message.
      await interaction.deferUpdate();
      await rerenderInventory(interaction, ownerId, page);
      return;
    }

    // Launched from a non-inventory message (e.g. the .value Add to Inventory
    // button). Confirm ephemerally so we don't replace the unrelated parent
    // message.
    await interaction.reply({
      content:
        newQty > 0
          ? `✅ Set **${item.name}** to × ${newQty} in your inventory.`
          : `🗑 Removed **${item.name}** from your inventory.`,
      flags: 64,
    });
  }
}

function buildAddOrSetModal(
  ownerId: string,
  page: number,
  prefilledItem: string,
  source: "inv" | "item",
): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`inv:addSubmit:${source}:${ownerId}:${page}`)
    .setTitle("Add / Set Inventory Item")
    .addComponents(
      new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("item")
          .setLabel("Item name (e.g. Chroma Seer, Eternal Set)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(80)
          .setValue(prefilledItem.slice(0, 80)),
      ),
      new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("quantity")
          .setLabel("Quantity")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(6)
          .setValue("1"),
      ),
      new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("mode")
          .setLabel("Mode: 'set' to overwrite, 'add' to add")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(3)
          .setValue("set"),
      ),
    );
}

void lastScrapeAttemptTime;
