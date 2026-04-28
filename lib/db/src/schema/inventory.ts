import { integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

export const inventoryItems = pgTable(
  "inventory_items",
  {
    userId: text("user_id").notNull(),
    itemName: text("item_name").notNull(),
    itemNameLower: text("item_name_lower").notNull(),
    quantity: integer("quantity").notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.itemNameLower] })],
);

export type InventoryRow = typeof inventoryItems.$inferSelect;
export type InsertInventoryRow = typeof inventoryItems.$inferInsert;
