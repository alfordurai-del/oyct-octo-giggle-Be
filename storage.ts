// server/storage.ts

import {
  accounts,
  cryptocurrencies,
  trades,
  type Cryptocurrency,
  type InsertCryptocurrency,
  type Trade,
  type InsertTrade,
  type Account,
  type InsertAccount
} from "@shared/schema"; // Make sure this path is correct
import { eq, and } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";
import axios from 'axios';

// Helper function to convert number to string for numeric/decimal columns in DB
const numToString = (val: number | string | null | undefined): string | null => {
  if (val === null || val === undefined) return null;
  const numVal = typeof val === 'string' ? parseFloat(val) : val;
  // If after parsing, it's NaN, return null and log a warning
  if (isNaN(numVal)) {
    console.warn(`[numToString] Input '${val}' resulted in NaN after parsing. Returning null for database storage.`);
    return null;
  }
  return numVal.toFixed(8).toString(); // Using 8 decimal places for consistency
};

// Helper function to convert string from DB numeric/decimal columns back to number for frontend
const dbNumToFloat = (val: string | null | undefined): number => {
  if (val === null || val === undefined) return 0; // Default to 0 if null/undefined
  const parsed = parseFloat(val);
  // Default to 0 if parsing results in NaN and log a warning
  if (isNaN(parsed)) {
    console.warn(`[dbNumToFloat] Input string '${val}' resulted in NaN. Returning 0.`);
    return 0;
  }
  return parsed;
};

export interface IStorage {
  getUser(id: string): Promise<Account | undefined>;
  getUserByEmail(email: string): Promise<Account | undefined>;
  createUser(user: InsertAccount): Promise<Account[]>;

  getCryptocurrencies(): Promise<Cryptocurrency[]>;
  getCryptocurrency(id: string): Promise<Cryptocurrency | undefined>;
  updateCryptocurrency(id: string, data: Partial<InsertCryptocurrency>): Promise<Cryptocurrency | undefined>;
  seedCryptocurrencies(): Promise<void>;
  updateAllCryptocurrencies(): Promise<void>;

  createTrade(trade: InsertTrade): Promise<Trade[]>;
  getTrades(email?: string): Promise<Trade[]>;
}

// --- CoinGecko API Configuration ---
const COINGECKO_API_URL = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false';

// Map your crypto names to CoinGecko IDs
const coinGeckoIdsMap: { [key: string]: string } = {
  'Bitcoin': 'bitcoin',
  'Ethereum': 'ethereum',
  'Tron': 'tron',
  'Bitcoin cash': 'bitcoin-cash', // Note the hyphenated ID
  'Dogecoin': 'dogecoin',
};

// Define CoinGecko Asset interface based on the /coins/markets endpoint response
interface CoinGeckoMarketData {
  id: string; // CoinGecko ID is a string
  symbol: string;
  name: string;
  image: string;
  current_price: number;
  market_cap: number;
  market_cap_rank: number;
  fully_diluted_valuation: number | null;
  total_volume: number;
  high_24h: number;
  low_24h: number;
  price_change_24h: number;
  price_change_percentage_24h: number;
  market_cap_change_24h: number;
  market_cap_change_percentage_24h: number;
  circulating_supply: number;
  total_supply: number | null;
  max_supply: number | null;
  ath: number;
  ath_change_percentage: number;
  ath_date: string;
  atl: number;
  atl_change_percentage: number;
  atl_date: string;
  roi: any | null; // Can be null or an object { times, currency, percentage }
  last_updated: string;
}

// Function to fetch crypto prices from CoinGecko API
async function fetchCryptoPricesFromApi(): Promise<Record<string, CoinGeckoMarketData> | null> {
    try {
        console.log(`[CoinGecko] Attempting to fetch from CoinGecko API: ${COINGECKO_API_URL}`);

        const response = await axios.get<CoinGeckoMarketData[]>(COINGECKO_API_URL);

        const assets: CoinGeckoMarketData[] = response.data;
        const pricesMap: Record<string, CoinGeckoMarketData> = {};
        for (const asset of assets) {
            // Only include assets that are in our defined list
            if (Object.values(coinGeckoIdsMap).includes(asset.id)) {
                pricesMap[asset.id] = asset;
            }
        }
        console.log(`[CoinGecko] Successfully fetched data from CoinGecko API. Status: ${response.status}. Fetched ${Object.keys(pricesMap).length} relevant assets.`);
        return pricesMap;
    } catch (error) {
        console.error(`[CoinGecko] Error fetching crypto prices from CoinGecko API:`, error instanceof Error ? error.message : error);
        if (axios.isAxiosError(error) && error.response) {
            console.error('[CoinGecko] Axios Error Response Data:', error.response.data);
            console.error('[CoinGecko] Axios Error Response Status:', error.response.status);
            console.error('[CoinGecko] Axios Error Response Headers:', error.response.headers);
        }
        return null;
    }
}
// --- END CoinGecko API CONFIGURATION ---


export class PgStorage implements IStorage {
  constructor(private db: NodePgDatabase<typeof schema>) {}

  async getUser(id: string): Promise<Account | undefined> {
    const [userAccount] = await this.db.select().from(accounts).where(eq(accounts.id, id));
    if (userAccount) {
      return { ...userAccount, balance: dbNumToFloat(userAccount.balance) };
    }
    return undefined;
  }

  async getUserByEmail(email: string): Promise<Account | undefined> {
    const [userAccount] = await this.db.select().from(accounts).where(eq(accounts.email, email));
    if (userAccount) {
      return { ...userAccount, balance: dbNumToFloat(userAccount.balance) };
    }
    return undefined;
  }

  async createUser(insertAccount: InsertAccount): Promise<Account[]> {
    const accountToInsert = {
      ...insertAccount,
      // Ensure 'username' is set, defaulting to a placeholder if not provided
      username: insertAccount.username || `${insertAccount.firstName} ${insertAccount.lastName}`,
      balance: numToString(insertAccount.balance ?? 0),
    };
    const newAccounts = await this.db.insert(accounts).values(accountToInsert).returning();
    return newAccounts.map(account => ({
      ...account,
      balance: dbNumToFloat(account.balance)
    }));
  }

  async getCryptocurrencies(): Promise<Cryptocurrency[]> {
    const cryptos = await this.db.select().from(cryptocurrencies);
    return cryptos.map(crypto => ({
      ...crypto,
      price: dbNumToFloat(crypto.price),
      change24h: dbNumToFloat(crypto.change_24h),
      price_change_24h: dbNumToFloat(crypto.price_change_24h),
      volume24h: dbNumToFloat(crypto.volume_24h),
    }));
  }

  async getCryptocurrency(id: string): Promise<Cryptocurrency | undefined> {
    console.log(`[DEBUG] getCryptocurrency: Attempting to fetch crypto for ID: '${id}' (type: ${typeof id})`);
    const [crypto] = await this.db.select().from(cryptocurrencies).where(eq(cryptocurrencies.id, id));

    if (!crypto) {
      console.warn(`[DEBUG] getCryptocurrency: No crypto found for ID: '${id}'.`);
      return undefined;
    }

    console.log(`[DEBUG] getCryptocurrency: Raw data from DB for ID '${id}':`, JSON.stringify(crypto, null, 2));

    const processedCrypto = {
      ...crypto,
      price: dbNumToFloat(crypto.price),
      change24h: dbNumToFloat(crypto.change_24h),
      price_change_24h: dbNumToFloat(crypto.price_change_24h),
      volume24h: dbNumToFloat(crypto.volume_24h),
    };

    console.log(`[DEBUG] getCryptocurrency: Processed data before return for ID '${id}':`, JSON.stringify(processedCrypto, null, 2));

    return processedCrypto;
  }

  async updateCryptocurrency(id: string, data: Partial<InsertCryptocurrency>): Promise<Cryptocurrency | undefined> {
    const updateData: Partial<typeof cryptocurrencies.$inferInsert> = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.symbol !== undefined) updateData.symbol = data.symbol;
    if (data.price !== undefined) updateData.price = numToString(data.price); // numToString handles null/undefined internally
    if (data.change24h !== undefined) updateData.change_24h = numToString(data.change24h);
    if (data.price_change_24h !== undefined) updateData.price_change_24h = numToString(data.price_change_24h);
    if (data.volume24h !== undefined) updateData.volume_24h = numToString(data.volume24h);
    if (data.image !== undefined) updateData.image = data.image;

    updateData.last_updated = new Date(); // Update timestamp

    const [updatedCrypto] = await this.db.update(cryptocurrencies).set(updateData).where(eq(cryptocurrencies.id, id)).returning();
    if (!updatedCrypto) {
      console.warn(`[updateCryptocurrency] No cryptocurrency found to update for ID: '${id}'.`);
      return undefined;
    }
    return {
      ...updatedCrypto,
      price: dbNumToFloat(updatedCrypto.price),
      change24h: dbNumToFloat(updatedCrypto.change_24h),
      price_change_24h: dbNumToFloat(updatedCrypto.price_change_24h),
      volume24h: dbNumToFloat(updatedCrypto.volume_24h),
    };
  }

  async seedCryptocurrencies(): Promise<void> {
    const existingCryptos = await this.db.select().from(cryptocurrencies).limit(1);

    if (existingCryptos.length === 0) {
      console.log("[Seeding] Seeding initial cryptocurrency data with live prices from CoinGecko...");

      const livePricesMap = await fetchCryptoPricesFromApi();
      if (!livePricesMap) {
          console.warn("[Seeding] Could not fetch live crypto prices from CoinGecko. Seeding with static data (or default 0s if static not available).");
      }

      const cryptoData = [
        {
          id: 'bitcoin',
          name: 'Bitcoin',
          symbol: 'BTC',
          image: '<svg xmlns="http://www.w3.org/2000/svg" width="2em" height="2em" viewBox="0 0 32 32"><g fill="none" fill-rule="evenodd"><circle cx="16" cy="16" r="16" fill="#f7931a"/><path fill="#fff" fill-rule="nonzero" d="M23.189 14.02c.314-2.096-1.283-3.223-3.465-3.975l.708-2.84l-1.728-.43l-.69 2.765c-.454-.114-.92-.22-1.385-.326l.695-2.783L15.596 6l-.708 2.839q-.565-.127-1.104-.26l.002-.009l-2.384-.595l-.46 1.846s1.283.294 1.256.312c.7.175.826.638.805 1.006l-.806 3.235q.073.017.18.057l-.183-.045l-1.13 4.532c-.086.212-.303.531-.793.41c.018.025-1.256-.313-1.256-.313l-.858 1.978l2.25.561c.418.105.828.215 1.231.318l-.715 2.872l1.727.43l.708-2.84q.707.19 1.378.357l-.706 2.828l1.728.43l.715-2.866c2.948.558 5.164.333 6.097-2.333c.752-2.146-.037-3.385-1.588-4.192c1.13-.26 1.98-1.003 2.207-2.538m-3.95 5.538c-.533 2.147-4.148.986-5.32.695l.95-3.805c1.172.293 4.929.872 4.37 3.11m.535-5.569c-.487 1.953-3.495.96-4.47.717l.86-3.45c.975.243 4.118.696 3.61 2.733"/></g></svg>',
          price: numToString(livePricesMap?.bitcoin?.current_price ?? 117904.00),
          change_24h: numToString(livePricesMap?.bitcoin?.price_change_percentage_24h ?? -0.08),
          price_change_24h: numToString(
            livePricesMap?.bitcoin?.price_change_24h ?? (117904.00 * (-0.08 / 100))
          ),
          volume_24h: numToString(livePricesMap?.bitcoin?.total_volume ?? 45678912.50),
          last_updated: new Date(),
        },
        {
          id: 'ethereum',
          name: 'Ethereum',
          symbol: 'ETH',
          image: '<svg xmlns="http://www.w3.org/2000/svg" width="2em" height="2em" viewBox="0 0 24 24"><g fill="none"><path fill="#8ffcf3" d="M12 3v6.651l5.625 2.516z"/><path fill="#cabcf8" d="m12 3l-5.625 9.166L12 9.653z"/><path fill="#cba7f5" d="M12 16.478V21l5.625-7.784z"/><path fill="#74a0f3" d="M12 21v-4.522l-5.625-3.262z"/><path fill="#cba7f5" d="m12 15.43l5.625-3.263L12 9.652z"/><path fill="#74a0f3" d="M6.375 12.167L12 15.43V9.652z"/><path fill="#202699" fill-rule="evenodd" d="m12 15.43l-5.625-3.263L12 3l5.624 9.166zm-5.252-3.528l5.161-8.41v6.114zm-.077.229l5.238-2.327v5.364zm5.418-2.327v5.364l5.234-3.037zm0-.198l5.161 2.296l-5.161-8.41z" clip-rule="evenodd"/><path fill="#202699" fill-rule="evenodd" d="m12 16.406l-5.625-3.195L12 21l5.624-7.79zm-4.995-2.633l4.904 2.79v4.005zm5.084 2.79v4.005l4.905-6.795z" clip-rule="evenodd"/></g></svg>',
          price: numToString(livePricesMap?.ethereum?.current_price ?? 3594.25),
          change_24h: numToString(livePricesMap?.ethereum?.price_change_percentage_24h ?? 1.29),
          price_change_24h: numToString(
            livePricesMap?.ethereum?.price_change_24h ?? (3594.25 * (1.29 / 100))
          ),
          volume_24h: numToString(livePricesMap?.ethereum?.total_volume ?? 23456789.30),
          last_updated: new Date(),
        },
        {
          id: 'tron',
          name: 'Tron',
          symbol: 'TRX',
          image: '<svg xmlns="http://www.w3.org/2000/svg" width="2em" height="2em" viewBox="0 0 24 24"><path fill="#c4342b" fill-rule="evenodd" d="M4.42 3.186a.57.57 0 0 1 .552-.17L16.876 5.93a.5.5 0 0 1 .197.092l2.422 1.767a.565.565 0 0 1 .133.773l-8.332 12.191a.563.563 0 0 1-.998-.13L4.306 3.753a.57.57 0 0 1 .114-.566M6.383 6.23l4.16 11.712l.684-6.069zm5.958 5.838l-.695 6.175l5.884-8.61zm5.72-3.93l-3.793 1.78l2.542-2.691zm-2.396-1.343L6.41 4.531l5.426 6.318z" clip-rule="evenodd"/></svg>',
          price: numToString(livePricesMap?.tron?.current_price ?? 0.32),
          change_24h: numToString(livePricesMap?.tron?.price_change_percentage_24h ?? -2.44),
          price_change_24h: numToString(
            livePricesMap?.tron?.price_change_24h ?? (0.32 * (-2.44 / 100))
          ),
          volume_24h: numToString(livePricesMap?.tron?.total_volume ?? 8765432.10),
          last_updated: new Date(),
        },
        {
          id: 'bitcoin-cash',
          name: 'Bitcoin cash',
          symbol: 'BCH',
          image: '<svg xmlns="http://www.w3.org/2000/svg" width="2em" height="2em" viewBox="0 0 24 24"><path fill="#262525" d="m10.84 11.22l-.688-2.568c.728-.18 2.839-1.051 3.39.506c.27 1.682-1.978 1.877-2.702 2.062m.289 1.313l.755 2.829c.868-.228 3.496-.46 3.241-2.351c-.433-1.666-3.125-.706-3.996-.478M24 12c0 6.627-5.373 12-12 12S0 18.627 0 12S5.373 0 12 0s12 5.373 12 12m-6.341.661c-.183-1.151-1.441-2.095-2.485-2.202c.643-.57.969-1.401.57-2.488c-.603-1.368-1.989-1.66-3.685-1.377l-.546-2.114l-1.285.332l.536 2.108c-.338.085-.685.158-1.029.256L9.198 5.08l-1.285.332l.545 2.114c-.277.079-2.595.673-2.595.673l.353 1.377s.944-.265.935-.244c.524-.137.771.125.886.372l1.498 5.793c.018.168-.012.454-.372.551c.021.012-.935.241-.935.241l.14 1.605s2.296-.588 2.598-.664l.551 2.138l1.285-.332l-.551-2.153q.53-.123 1.032-.256l.548 2.141l1.285-.332l-.551-2.135c1.982-.482 3.38-1.73 3.094-3.64"/></svg>',
          price: numToString(livePricesMap?.['bitcoin-cash']?.current_price ?? 513.54),
          change_24h: numToString(livePricesMap?.['bitcoin-cash']?.price_change_percentage_24h ?? -0.22),
          price_change_24h: numToString(
            livePricesMap?.['bitcoin-cash']?.price_change_24h ?? (513.54 * (-0.22 / 100))
          ),
          volume_24h: numToString(livePricesMap?.['bitcoin-cash']?.total_volume ?? 5432198.75),
          last_updated: new Date(),
        },
        {
          id: 'dogecoin',
          name: 'Dogecoin',
          symbol: 'DOGE',
          image: '<svg xmlns="http://www.w3.org/2000/svg" width="2em" height="2em" viewBox="0 0 32 32"><g fill="none" fill-rule="evenodd"><circle cx="16" cy="16" r="16" fill="#c3a634"/><path fill="#fff" d="M13.248 14.61h4.314v2.286h-4.314v4.818h2.721q1.615 0 2.644-.437q1.029-.436 1.615-1.21a4.4 4.4 0 0 0 .796-1.815a11.4 11.4 0 0 0 .21-2.252a11.4 11.4 0 0 0-.21-2.252a4.4 4.4 0 0 0-.796-1.815q-.587-.774-1.615-1.21q-1.029-.437-2.644-.437h-2.721v4.325zm-2.766 2.286H9v-2.285h1.482V8h6.549q1.815 0 3.142.627q1.327.628 2.168 1.715q.84 1.086 1.25 2.543T24 16a11.5 11.5 0 0 1-.41 3.115q-.408 1.456-1.25 2.543q-.84 1.087-2.167 1.715q-1.328.627-3.142.627h-6.549z"/></g></svg>',
          price: numToString(livePricesMap?.dogecoin?.current_price ?? 0.24),
          change_24h: numToString(livePricesMap?.dogecoin?.price_change_percentage_24h ?? 2.17),
          price_change_24h: numToString(
            livePricesMap?.dogecoin?.price_change_24h ?? (0.24 * (2.17 / 100))
          ),
          volume_24h: numToString(livePricesMap?.dogecoin?.total_volume ?? 3210987.60),
          last_updated: new Date(),
        },
      ];

      try {
        await this.db.insert(cryptocurrencies).values(cryptoData).onConflictDoNothing({
          target: cryptocurrencies.id,
          constraint: "cryptocurrencies_pkey", // Ensure this constraint name matches your schema if you have one
        });
        console.log("[Seeding] Cryptocurrency seeding complete.");
      } catch (error) {
        console.error("[Seeding] Error during cryptocurrency seeding:", error);
      }
    } else {
      console.log("[Seeding] Cryptocurrencies already exist in DB. Skipping initial seeding.");
    }
  }

  async updateAllCryptocurrencies(): Promise<void> {
    console.log("[Update] Attempting to update all cryptocurrency prices from CoinGecko API...");
    const livePricesMap = await fetchCryptoPricesFromApi();

    if (!livePricesMap) {
      console.warn("[Update] Failed to fetch live prices from CoinGecko. Skipping update.");
      return;
    }

    const existingCryptos = await this.db.select().from(cryptocurrencies);

    for (const crypto of existingCryptos) {
      const coingeckoId = coinGeckoIdsMap[crypto.name];
      if (coingeckoId && livePricesMap[coingeckoId]) {
        const liveData = livePricesMap[coingeckoId];
        const newPrice = liveData.current_price;
        const newChange24h = liveData.price_change_percentage_24h;
        const newPriceChange24hAmount = liveData.price_change_24h;
        const newVolume24h = liveData.total_volume;

        await this.updateCryptocurrency(crypto.id, {
          price: newPrice,
          change24h: newChange24h,
          price_change_24h: newPriceChange24hAmount,
          volume24h: newVolume24h,
        });
        console.log(`[Update] Updated ${crypto.name} (ID: ${crypto.id}): Price=${newPrice?.toFixed(2)}, Change24h=${newChange24h?.toFixed(2)}%`);
      } else {
        console.warn(`[Update] No live data found for ${crypto.name} (${coingeckoId || 'No CoinGecko ID mapped'}). Skipping update for this crypto.`);
      }
    }
    console.log("[Update] All cryptocurrency prices update attempt complete.");
  }

  async createTrade(trade: InsertTrade): Promise<Trade[]> {
    const tradeToInsert: typeof trades.$inferInsert = {
      ...trade,
      id: trade.id,
      user_id: trade.userId,
      crypto_id: trade.cryptoId,
      amount: numToString(trade.amount), // numToString handles null/undefined
      initial_price: numToString(trade.entryPrice), // numToString handles null/undefined
      // delivery_time and timestamp are integer type in schema, so store directly as number
      delivery_time: trade.deliveryTime, 
      status: trade.status ?? 'pending',
      timestamp: trade.timestamp, 
      email: trade.email,
      gain_percentage: numToString(trade.gainPercentage),
      final_amount: numToString(trade.finalAmount),
      simulated_final_price: numToString(trade.simulatedFinalPrice),
      current_trade_value: numToString(trade.currentTradeValue),
      current_gain_loss_percentage: numToString(trade.currentGainLossPercentage),
      outcome: trade.outcome,
      crypto_name: trade.cryptoName,
      crypto_symbol: trade.cryptoSymbol,
      type: trade.type,
      direction: trade.direction
    };

    const newTrades = await this.db.insert(trades).values(tradeToInsert).returning();
    return newTrades.map(t => ({
      ...t,
      // Convert back to number for frontend, defaulting to 0 if null/NaN
      amount: dbNumToFloat(t.amount),
      initialPrice: dbNumToFloat(t.initial_price),
      currentTradeValue: dbNumToFloat(t.current_trade_value),
      currentGainLossPercentage: dbNumToFloat(t.current_gain_loss_percentage),
      gainPercentage: dbNumToFloat(t.gain_percentage),
      finalAmount: dbNumToFloat(t.final_amount),
      simulatedFinalPrice: dbNumToFloat(t.simulated_final_price),
      entryPrice: dbNumToFloat(t.initial_price), // Aliasing initial_price as entryPrice
      // Convert string timestamps back to number
      timestamp: Number(t.timestamp),
      deliveryTime: Number(t.delivery_time),
    }));
  }

  async getTrades(email?: string): Promise<Trade[]> {
    let resultTrades;
    if (email) {
      resultTrades = await this.db.select().from(trades).where(eq(trades.email, email));
    } else {
      resultTrades = await this.db.select().from(trades);
    }
    return resultTrades.map(t => ({
      ...t,
      amount: dbNumToFloat(t.amount),
      initialPrice: dbNumToFloat(t.initial_price),
      currentTradeValue: dbNumToFloat(t.current_trade_value),
      currentGainLossPercentage: dbNumToFloat(t.current_gain_loss_percentage),
      gainPercentage: dbNumToFloat(t.gain_percentage),
      finalAmount: dbNumToFloat(t.final_amount),
      simulatedFinalPrice: dbNumToFloat(t.simulated_final_price),
      entryPrice: dbNumToFloat(t.initial_price), // Aliasing initial_price as entryPrice
      timestamp: Number(t.timestamp),
      deliveryTime: Number(t.delivery_time),
    }));
  }
}

export let storage: IStorage;

export function initializeStorage(databaseInstance: NodePgDatabase<typeof schema>) {
    storage = new PgStorage(databaseInstance);
    console.log("[Storage] Drizzle PgStorage initialized.");
}
