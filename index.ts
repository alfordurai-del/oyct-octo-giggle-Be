import express, { type Request, Response, NextFunction } from "express";
import cors from "cors";
import { createServer, type Server as HttpServer } from "http";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { registerRoutes } from "./routes";
import { initializeStorage, storage } from "./storage";
import path from "path";
import { fileURLToPath } from "url";
import cron from "node-cron"; // Import node-cron

// Fix for __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// --- Database Setup ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});
const db = drizzle(pool);

// --- Global Middleware (Applied to all routes) ---
app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "https://new-hive.netlify.app",
      "https://pi-coin-converter.netlify.app",
      "https://pi-converter.netlify.app",
    ],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Origin",
      "Accept",
      "X-Requested-With",
      "x-secure-request",
      "x-user-email",
    ],
    credentials: true,
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// --- Request Logging Middleware ---
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  const requestPath = req.path;
  let capturedJsonResponse: Record<string, any> | undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson: any, ...args: any[]) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (requestPath.startsWith("/api")) {
      let logLine = `${req.method} ${requestPath} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        const jsonString = JSON.stringify(capturedJsonResponse);
        logLine +=
          " :: " +
          (jsonString.length > 100
            ? jsonString.substring(0, 97) + "..."
            : jsonString);
      }

      if (logLine.length > 120) {
        logLine = logLine.slice(0, 119) + "…";
      }

      console.log(logLine);
    }
  });
  next();
});

// --- Server Startup Logic (inside an async IIFE) ---
(async () => {
  let httpServer: HttpServer;

  try {
    // Initialize DB storage
    initializeStorage(db);

    // Perform initial seeding and update on server start
    console.log("All env vars:", process.env);
    console.log("Database URL:", process.env.DATABASE_URL);
    console.log("Performing initial cryptocurrency data seeding and price update...");
    await storage.seedCryptocurrencies();
    await storage.updateAllCryptocurrencies();
    console.log("Initial cryptocurrency data operations complete.");

    // Schedule hourly cryptocurrency price updates
    cron.schedule("0 * * * *", async () => {
      console.log("Running scheduled crypto price update...");
      try {
        await storage.updateAllCryptocurrencies();
        console.log("Crypto prices updated successfully.");
      } catch (error) {
        console.error("Failed to update crypto prices during scheduled task:", error);
      }
    });
    console.log("Crypto price update scheduled to run every hour.");

    // Register API routes
    await registerRoutes(app);

    // Create HTTP server
    httpServer = createServer(app);

    // Error handling middleware (last)
    app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
      const status = err.status || err.statusCode || 500;
      const message = err.message || "Internal Server Error";
      res.status(status).json({ message });
      console.log(`Error: ${message}, Status Code: ${status}`);
    });

    // Start server with alwaysdata-compatible configuration
    const port = process.env.ALWAYSDATA_HTTPD_PORT || process.env.PORT || 3000;
    const host = process.env.ALWAYSDATA_HTTPD_IP || "0.0.0.0";
    httpServer.listen(port, host, () => {
      console.log(`Server running at http://${host}:${port}`);
      console.log(`Test your API at: http://localhost:${port}/api/cryptocurrencies`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
})();