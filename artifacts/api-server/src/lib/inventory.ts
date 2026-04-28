import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, inventoryItems, type InventoryRow } from "@workspace/db";
import { findItem, getAllItems, type Item } from "./values";

export interface InventoryEntry {
  itemName: string;
  itemNameLower: string;
  quantity: number;
  item: Item | null;
  unitValue: number;
  totalValue: number;
  unitDemand: number;
}

export interface InventorySummary {
  userId: string;
  entries: InventoryEntry[];
  totalValue: number;
  totalQuantity: number;
  knownCount: number;
  unknownCount: number;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Resolve a user-supplied name to a canonical dataset item. Returns:
 *  - { item } if a unique match was found
 *  - null if there is no match at all
 */
export function resolveItem(name: string): Item | null {
  return findItem(name);
}

export async function setItemQuantity(
  userId: string,
  canonicalName: string,
  quantity: number,
): Promise<void> {
  const itemNameLower = normalizeName(canonicalName);
  if (quantity <= 0) {
    await db
      .delete(inventoryItems)
      .where(
        and(
          eq(inventoryItems.userId, userId),
          eq(inventoryItems.itemNameLower, itemNameLower),
        ),
      );
    return;
  }
  await db
    .insert(inventoryItems)
    .values({
      userId,
      itemName: canonicalName,
      itemNameLower,
      quantity,
    })
    .onConflictDoUpdate({
      target: [inventoryItems.userId, inventoryItems.itemNameLower],
      set: {
        quantity,
        itemName: canonicalName,
        updatedAt: new Date(),
      },
    });
}

export async function adjustItemQuantity(
  userId: string,
  canonicalName: string,
  delta: number,
): Promise<number> {
  const itemNameLower = normalizeName(canonicalName);
  const existing = await db
    .select()
    .from(inventoryItems)
    .where(
      and(
        eq(inventoryItems.userId, userId),
        eq(inventoryItems.itemNameLower, itemNameLower),
      ),
    );
  const currentQty = existing[0]?.quantity ?? 0;
  const next = Math.max(0, currentQty + delta);
  await setItemQuantity(userId, canonicalName, next);
  return next;
}

export async function removeItem(
  userId: string,
  canonicalName: string,
): Promise<void> {
  await setItemQuantity(userId, canonicalName, 0);
}

export async function clearInventory(userId: string): Promise<number> {
  const rows = await db
    .delete(inventoryItems)
    .where(eq(inventoryItems.userId, userId))
    .returning();
  return rows.length;
}

export async function getInventory(userId: string): Promise<InventorySummary> {
  const rows = await db
    .select()
    .from(inventoryItems)
    .where(eq(inventoryItems.userId, userId))
    .orderBy(desc(inventoryItems.updatedAt));
  return summarize(userId, rows);
}

function summarize(userId: string, rows: InventoryRow[]): InventorySummary {
  const entries: InventoryEntry[] = rows.map((r) => {
    const item = findItem(r.itemName);
    const unitValue = item?.value ?? 0;
    const unitDemand = item?.demand ?? 0;
    return {
      itemName: item?.name ?? r.itemName,
      itemNameLower: r.itemNameLower,
      quantity: r.quantity,
      item,
      unitValue,
      unitDemand,
      totalValue: unitValue * r.quantity,
    };
  });
  // Sort by total value desc, putting known items first, then by quantity
  entries.sort((a, b) => {
    if ((b.item ? 1 : 0) !== (a.item ? 1 : 0)) return (b.item ? 1 : 0) - (a.item ? 1 : 0);
    if (b.totalValue !== a.totalValue) return b.totalValue - a.totalValue;
    return b.quantity - a.quantity;
  });
  const totalValue = entries.reduce((s, e) => s + e.totalValue, 0);
  const totalQuantity = entries.reduce((s, e) => s + e.quantity, 0);
  const knownCount = entries.filter((e) => e.item).length;
  const unknownCount = entries.length - knownCount;
  return { userId, entries, totalValue, totalQuantity, knownCount, unknownCount };
}

export interface OwnerHit {
  userId: string;
  quantity: number;
  totalValue: number;
}

/**
 * Find all users who own a specific item directly. Returns sorted by quantity desc.
 * If `includeSetMembership` is true and the queried item is a set, also include
 * users who own the set's component items.
 */
export async function findOwnersOfItem(item: Item): Promise<OwnerHit[]> {
  const itemNameLower = normalizeName(item.name);
  const rows = await db
    .select({
      userId: inventoryItems.userId,
      quantity: inventoryItems.quantity,
    })
    .from(inventoryItems)
    .where(eq(inventoryItems.itemNameLower, itemNameLower));

  const hits: OwnerHit[] = rows.map((r) => ({
    userId: r.userId,
    quantity: r.quantity,
    totalValue: r.quantity * item.value,
  }));
  hits.sort((a, b) => b.quantity - a.quantity || b.totalValue - a.totalValue);
  return hits;
}

/**
 * Optional: find owners that have any of a set's component items. Returns a map
 * keyed by userId with the components they own.
 */
export async function findComponentOwners(
  set: Item,
): Promise<Map<string, { quantities: Record<string, number>; totalValue: number }>> {
  if (!set.contains || set.contains.length === 0) return new Map();
  const componentItems = set.contains
    .map((name) => findItem(name))
    .filter((i): i is Item => i !== null);
  if (componentItems.length === 0) return new Map();
  const lowers = componentItems.map((i) => normalizeName(i.name));
  const rows = await db
    .select({
      userId: inventoryItems.userId,
      itemName: inventoryItems.itemName,
      itemNameLower: inventoryItems.itemNameLower,
      quantity: inventoryItems.quantity,
    })
    .from(inventoryItems)
    .where(inArray(inventoryItems.itemNameLower, lowers));

  const out = new Map<
    string,
    { quantities: Record<string, number>; totalValue: number }
  >();
  for (const r of rows) {
    const item = componentItems.find((i) => normalizeName(i.name) === r.itemNameLower);
    if (!item) continue;
    const cur = out.get(r.userId) ?? { quantities: {}, totalValue: 0 };
    cur.quantities[item.name] = r.quantity;
    cur.totalValue += r.quantity * item.value;
    out.set(r.userId, cur);
  }
  return out;
}

/** Total inventory size for a user (count of distinct entries). */
export async function inventoryEntryCount(userId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(inventoryItems)
    .where(eq(inventoryItems.userId, userId));
  return Number(rows[0]?.count ?? 0);
}

/** Quick suggestion list for autocomplete-ish behavior in modals. */
export function suggestCanonicalNames(query: string, limit = 25): string[] {
  const q = normalizeName(query);
  if (!q) return getAllItems().slice(0, limit).map((i) => i.name);
  const items = getAllItems();
  const matches = items.filter((i) => i.name.toLowerCase().includes(q));
  return matches.slice(0, limit).map((i) => i.name);
}
