import "dotenv/config"; // Load .env variables first
import express, { type Request, Response, NextFunction } from "express";
import cors from "cors";
import { createServer, type Server as HttpServer } from "http";
import { registerRoutes, db } from "./routes";
import { initializeStorage, storage } from "./storage";
import path from "path";
import { fileURLToPath } from "url";
import cron from "node-cron"; // Import node-cron

// Fix for __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// --- Global Middleware (Applied to all routes) ---
app.use(
  cors({
    origin: [
      "https://new-hive.com",
      "http://localhost:3000",
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
app.use((req, res, next) => {
  const start = Date.now();
  const requestPath = req.path;
  let capturedJsonResponse: Record<string, any> | undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
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

    // Always just create server (no vite/serveStatic)
    httpServer = createServer(app);

    // Error handling middleware (last)
    app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
      const status = err.status || err.statusCode || 500;
      const message = err.message || "Internal Server Error";
      res.status(status).json({ message });
      console.log(`Error: ${message}, Status Code: ${status}`);
    });

    // Start server
    const port = process.env.PORT || 3000;
    const host = process.env.IP || '0.0.0.0'; // Added this line
    httpServer.listen(port, host, () => { // Updated this line
      console.log(`Server running at http://${host}:${port}`);
      console.log(
        `Test your API at: http://localhost:${port}/api/cryptocurrencies`
      );
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
})();