import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use absolute path for database to ensure stability in different environments
const dbPath = path.join(__dirname, "running.db");
const db = new Database(dbPath);

console.log(`Database initialized at: ${dbPath}`);

// Initialize database
db.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    distance REAL,
    duration INTEGER,
    steps INTEGER,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors()); // Enable CORS for all origins to support various Webview environments
  app.use(express.json());

  // Request Logging Middleware
  app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
    next();
  });

  // API Routes
  const API_BASE = (process.env.APP_URL || "").replace(/\/$/, "");

  app.post(["/api/runs", "/api/runs/"], (req, res) => {
    try {
      const { distance, duration, steps } = req.body;
      console.log("Saving run:", { distance, duration, steps });
      
      const stmt = db.prepare("INSERT INTO runs (distance, duration, steps) VALUES (?, ?, ?)");
      const info = stmt.run(distance, duration, steps);
      
      res.json({ id: info.lastInsertRowid, success: true });
    } catch (error: any) {
      console.error("Error saving run:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get(["/api/runs", "/api/runs/"], (req, res) => {
    try {
      const runs = db.prepare("SELECT * FROM runs ORDER BY timestamp DESC").all();
      res.json(runs);
    } catch (error: any) {
      console.error("Error fetching runs:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get(["/api/stats", "/api/stats/"], (req, res) => {
    try {
      const stats = {
        daily: db.prepare("SELECT date(timestamp) as date, SUM(distance) as distance, SUM(steps) as steps FROM runs GROUP BY date(timestamp) ORDER BY date DESC LIMIT 7").all(),
        weekly: db.prepare("SELECT strftime('%Y-%W', timestamp) as week, SUM(distance) as distance, SUM(steps) as steps FROM runs GROUP BY week ORDER BY week DESC LIMIT 4").all(),
        monthly: db.prepare("SELECT strftime('%Y-%m', timestamp) as month, SUM(distance) as distance, SUM(steps) as steps FROM runs GROUP BY month ORDER BY month DESC LIMIT 12").all(),
        yearly: db.prepare("SELECT strftime('%Y', timestamp) as year, SUM(distance) as distance, SUM(steps) as steps FROM runs GROUP BY year ORDER BY year DESC").all()
      };
      res.json(stats);
    } catch (error: any) {
      console.error("Error fetching stats:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch(err => {
  console.error("Failed to start server:", err);
});
