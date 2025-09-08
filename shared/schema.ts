import { pgTable, text, serial, integer, boolean, decimal, timestamp, varchar } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Users Table
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

// Define the 'investments' table schema
export const investments = pgTable('investments', {
  id: varchar('id').primaryKey(),
  userId: varchar('user_id').notNull(),
  strategyId: varchar('strategy_id').notNull(), // Link to a strategies table
  investmentAmount: decimal('investment_amount').notNull(),
  currentValue: decimal('current_value').notNull(),
  startDate: timestamp('start_date').notNull(), // Store as a proper timestamp or ISO string
  durationDays: integer('duration_days').notNull(), // Crucial for frontend calculation
  status: varchar('status', { enum: ['active', 'completed', 'cancelled'] }).notNull(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Define a 'strategies' table schema if you store strategy details in DB
export const strategies = pgTable('strategies', {
  id: varchar('id').primaryKey(),
  name: varchar('name').notNull(),
  // Add other strategy details like dailyReturn, maxDrawdown, etc. if they are dynamic
  dailyReturn: decimal('daily_return'),
  maxDrawdown: decimal('max_drawdown'),
  duration_days: integer('duration_days').notNull(), // ADDED: duration_days column
});

// Cryptocurrencies Table - CRITICAL CHANGES HERE
export const cryptocurrencies = pgTable("cryptocurrencies", {
  // IMPORTANT: Changed from `serial` (integer) to `text` to match string IDs like 'bitcoin'
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  symbol: text("symbol").notNull(),
  pair: text("pair").notNull().default("USDT"),
  // Numeric fields with specified precision and scale
  price: decimal("price", { precision: 18, scale: 8 }).notNull(),
  change24h: decimal("change24h", { precision: 10, scale: 4 }).notNull(),
  // Renamed for consistency with storage.ts and CoinGecko data
  price_change_24h: decimal("price_change_24h", { precision: 18, scale: 8 }).notNull(),
  volume_24h: decimal("volume_24h", { precision: 18, scale: 2 }).notNull(),
  // Renamed for consistency with storage.ts
  image: text("image"), // Changed from `icon`, made nullable as per SVG usage
  // color: text("color").notNull(), // Uncomment if you intend to use this column
  // Renamed and ensured timezone awareness
  last_updated: timestamp("last_updated", { withTimezone: true }).defaultNow().notNull(),
});

// KYC Verifications Table
export const kycVerifications = pgTable("kyc_verifications", {
  id: serial("id").primaryKey(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  country: text("country").notNull(),
  documentType: text("document_type").notNull(),
  accessCode: text("access_code"),
  email: text("email").notNull(),
  verificationCode: text("verification_code"),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Accounts Table - Minor change for consistency
export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(), // Assuming this is a UUID for the user account
  username: text("username").notNull(), // Changed from 'name' to 'username' for consistency
  balance: decimal("balance", { precision: 20, scale: 2 }).notNull().default("0"),
  country: text("country"),
  documentType: text("document_type"),
  accessCode: text("access_code"),
  email: text("email").notNull().unique(),
  status: text("status").default("pending"),
  uid: varchar("uid", { length: 8 }).unique().notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

// Trades Table - CRITICAL CHANGES HERE
export const trades = pgTable("trades", {
  id: text("id").primaryKey(), // This is a text UUID from client, NOT serial
  user_id: text("user_id").references(() => accounts.id).notNull(),
  // IMPORTANT: Changed from `integer` to `text` to reference `cryptocurrencies.id` correctly
  crypto_id: text("crypto_id").references(() => cryptocurrencies.id).notNull(),
  crypto_name: text("crypto_name").notNull(),
  crypto_symbol: text("crypto_symbol").notNull(),
  type: text("type").notNull(), // 'buy' or 'sell'
  direction: text("direction").notNull(), // 'up' or 'down'
  amount: decimal("amount", { precision: 18, scale: 8 }).notNull(),
  initial_price: decimal("initial_price", { precision: 18, scale: 8 }).notNull(),
  // These are correctly defined as integer for Unix timestamps (milliseconds)
  delivery_time: integer("delivery_time").notNull(),
  status: text("status").notNull().default("pending"),
  timestamp: integer("timestamp").notNull(),
  email: text("email"),

  // Optional fields:
  gain_percentage: decimal("gain_percentage", { precision: 10, scale: 4 }),
  final_amount: decimal("final_amount", { precision: 18, scale: 8 }),
  simulated_final_price: decimal("simulated_final_price", { precision: 18, scale: 8 }),
  current_trade_value: decimal("current_trade_value", { precision: 18, scale: 8 }),
  current_gain_loss_percentage: decimal("current_gain_loss_percentage", { precision: 10, scale: 4 }),
  outcome: text("outcome"), // 'win' or 'loss' or 'draw'
});

// --- NEW NOTIFICATIONS TABLE ---
export const notifications = pgTable("notifications", {
  id: text("id").primaryKey().$defaultFn(() => uuidv4()),
  user_id: text("user_id").references(() => accounts.id).notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  read: boolean("read").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});


// --- REVISED ZOD SCHEMAS ---

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

// Adjusted insertCryptocurrencySchema for consistency with Drizzle schema
export const insertCryptocurrencySchema = createInsertSchema(cryptocurrencies).omit({
  last_updated: true, // Omit auto-generated timestamp
}).extend({
  id: z.string(), // Explicitly include id for inserts/updates as it's provided by client (CoinGecko ID)
  image: z.string().optional().nullable(), // Allow image to be optional/nullable
});

export const insertKycSchema = createInsertSchema(kycVerifications).omit({
  id: true,
  createdAt: true,
  status: true,
  verificationCode: true,
});

// REVISED insertTradeSchema to match updated DB types and client input
export const insertTradeSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  cryptoId: z.string(), // CORRECTED: Changed from z.number() to z.string()
  cryptoName: z.string(),
  cryptoSymbol: z.string(),
  type: z.enum(['buy', 'sell']),
  direction: z.enum(['up', 'down']),
  amount: z.number().min(0),
  entryPrice: z.number().min(0),
  deliveryTime: z.number().int().positive(), // Unix timestamp in milliseconds
  status: z.enum(['pending', 'completed']).optional().default('pending'),
  timestamp: z.number().int().positive(), // Unix timestamp
  email: z.string().email().optional().nullable(),

  gainPercentage: z.number().nullable().optional(),
  finalAmount: z.number().nullable().optional(),
  simulatedFinalPrice: z.number().nullable().optional(),
  currentTradeValue: z.number().nullable().optional(),
  currentGainLossPercentage: z.number().nullable().optional(),
  outcome: z.enum(['win', 'loss', 'draw']).nullable().optional(),
});

export const insertAccountSchema = createInsertSchema(accounts).omit({
  createdAt: true,
  status: true,
}).extend({
  balance: z.union([z.number().min(0), z.string()]).optional(), // Allow number or string for balance input
});

export const insertNotificationSchema = createInsertSchema(notifications).omit({
  id: true,
  read: true,
  createdAt: true,
  updatedAt: true,
});

// Export inferred types for use throughout your application
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
export type InsertCryptocurrency = z.infer<typeof insertCryptocurrencySchema>;
export type Cryptocurrency = typeof cryptocurrencies.$inferSelect;
export type InsertKyc = z.infer<typeof insertKycSchema>;
export type KycVerification = typeof kycVerifications.$inferSelect;
export type InsertTrade = z.infer<typeof insertTradeSchema>;
export type Trade = typeof trades.$inferSelect;
export type InsertAccount = z.infer<typeof insertAccountSchema>;
export type Account = typeof accounts.$inferSelect;
export type InsertNotification = z.infer<typeof insertNotificationSchema>;
export type Notification = typeof notifications.$inferSelect;
