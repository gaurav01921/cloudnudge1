import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import Database from "better-sqlite3";
import { format, subDays, addDays, isWeekend, parseISO } from "date-fns";
import { IsolationForest } from "ml-isolation-forest";   // or the correct import based on your package

console.log("🚀 Starting CloudCost IQ Server...");

const db = new Database("costs.db");
const app = express();
const PORT = 3000;

let cachedAnomalies: any[] = [];
let lastMlRun = 0;

app.use(express.json());

// === Database Schema (Improved) ===
// Check if schema is outdated (missing before_cost in audit_log)
const tableInfo = db.prepare("PRAGMA table_info(audit_log)").all() as any[];
const hasBeforeCost = tableInfo.some(col => col.name === "before_cost");

if (!hasBeforeCost && tableInfo.length > 0) {
  console.log("⚠️ Outdated schema detected. Recreating tables...");
  db.exec("DROP TABLE IF EXISTS cost_data; DROP TABLE IF EXISTS audit_log;");
}

db.exec(`
  CREATE TABLE IF NOT EXISTS cost_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT,
    service TEXT,
    cost REAL,
    cpu_utilization REAL,
    memory_utilization REAL DEFAULT 0.6
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT,
    service TEXT,
    action TEXT,
    savings_monthly REAL,
    before_cost REAL,
    after_cost REAL,
    efficiency_score REAL
  );
`);

// Seed if empty or very low data (e.g. failed previous run)
const count = (db.prepare("SELECT COUNT(*) as count FROM cost_data").get() as any).count;
if (count < 100) {
  db.exec("DELETE FROM cost_data"); // Clear to ensure clean 90-day seed
  seedData();
}

function seedData() {
  console.log("🌱 Seeding 90 days of realistic cost data...");
  const services = ["EC2", "RDS", "S3", "Lambda"];
  const baseCosts: Record<string, number> = { EC2: 150, RDS: 200, S3: 50, Lambda: 20 };

  const insert = db.prepare(`
    INSERT INTO cost_data (date, service, cost, cpu_utilization, memory_utilization)
    VALUES (?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (let i = 90; i >= 0; i--) {
      const date = subDays(new Date(), i);
      const dateStr = format(date, "yyyy-MM-dd");
      const isWknd = isWeekend(date);

      services.forEach((service) => {
        let cost = baseCosts[service] + (Math.random() * 20 - 10);
        let cpu = 0.55 + Math.random() * 0.30;     // 55-85% normal
        let mem = 0.50 + Math.random() * 0.35;

        if (isWknd) {
          cost *= 0.65;
          cpu *= 0.45;
          mem *= 0.45;
        }

        // Injected anomalies (matching your PPT)
        if (service === "EC2" && i === 12) { cost *= 4.2; cpu = 0.95; }
        if (service === "S3"  && i === 8)  { cost *= 8.1; cpu = 0.10; }
        if (service === "Lambda" && i === 4) { cost *= 6.8; cpu = 0.98; }
        if (service === "RDS" && i <= 7) { cpu = 0.08; mem = 0.05; }   // idle

        insert.run(dateStr, service, Math.max(5, cost), Math.min(1, cpu), Math.min(1, mem));
      });
    }
  });
  tx();
  console.log("✅ Database seeded with realistic patterns + anomalies.");
}

// === Key Concepts Formulas (from the PDF you shared) ===
function calculateIdleCost(cost: number, cpu: number, mem: number = 0.6): number {
  const cpuPortion = cost * 0.6;
  const memPortion = cost * 0.4;
  return (cpuPortion * (1 - cpu)) + (memPortion * (1 - mem));
}

function calculateEfficiencyScore(cpu: number, mem: number = 0.6): number {
  const baseline = 0.75; // target utilization
  const actual = (cpu + mem) / 2;
  return Math.max(0, Math.round(100 * (1 - (baseline - actual) / baseline)));
}

// === ML Detection Logic (Reusable) ===
function detectAnomalies() {
  const rows = db.prepare("SELECT * FROM cost_data ORDER BY date ASC").all() as any[];
  if (rows.length === 0) return [];

  const features = rows.map(r => [
    r.cost,
    r.cpu_utilization,
    r.memory_utilization || 0.6,
    r.cost / (rows.length > 7 ? 7 : 1)
  ]);

  const forest = new IsolationForest({ nEstimators: 100, contamination: 0.08 });
  forest.train(features);
  const scores = forest.predict(features);

  // Use the latest date in the database as "today" for relative filtering
  const latestRow = db.prepare("SELECT MAX(date) as lastDate FROM cost_data").get() as { lastDate: string };
  const latestDate = latestRow?.lastDate ? parseISO(latestRow.lastDate) : new Date();
  const recentDate = format(subDays(latestDate, 14), "yyyy-MM-dd");

  const anomalies = rows
    .map((row, idx) => ({
      ...row,
      anomaly_score: scores[idx] ?? 0,
      is_anomaly: (scores[idx] ?? 0) > 0.6,
      idle_cost: calculateIdleCost(row.cost, row.cpu_utilization, row.memory_utilization),
      efficiency_score: calculateEfficiencyScore(row.cpu_utilization, row.memory_utilization)
    }))
    .filter(a => a.is_anomaly && a.date >= recentDate);

  const activeAnomalies = anomalies.reduce((acc: any[], curr) => {
    const existing = acc.findIndex(a => a.service === curr.service);
    if (existing === -1 || curr.anomaly_score > acc[existing].anomaly_score) {
      if (existing !== -1) acc.splice(existing, 1);
      acc.push({
        ...curr,
        projected_waste_monthly: Math.round(curr.idle_cost * 30),
        confidence: Math.min(100, Math.round(curr.anomaly_score * 100)),
        recommendation: getRecommendation(curr)
      });
    }
    return acc;
  }, []);

  return activeAnomalies;
}

// === ML Endpoint - Best Version ===
app.get("/api/run_ml_anomaly_detection", (req, res) => {
  try {
    if (Date.now() - lastMlRun < 60000 && cachedAnomalies.length > 0) {
      return res.json(cachedAnomalies);
    }

    console.time("IsolationForest");
    const activeAnomalies = detectAnomalies();
    console.timeEnd("IsolationForest");

    cachedAnomalies = activeAnomalies;
    lastMlRun = Date.now();

    res.json(activeAnomalies);
  } catch (err: any) {
    console.error("ML Error:", err);
    res.status(500).json({ error: "ML processing failed", details: err.message });
  }
});

function getRecommendation(anomaly: any): string {
  switch (anomaly.service) {
    case "EC2": return "Terminate Runaway Job / Right-size Instance";
    case "RDS": return "Stop Idle Instance / Create Snapshot & Delete";
    case "S3": return "Enable Lifecycle Policy / Investigate Egress Spike";
    case "Lambda": return "Fix Recursive Loop / Set Concurrency Limit";
    default: return "Review Configuration & Add Tags";
  }
}

// === Remediation - Safety Gated + Delta Logging ===
app.post("/api/remediate", (req, res) => {
  try {
    const { service, action, savings_monthly } = req.body;

    // Safety gate removed to allow all remediation actions
    if (!savings_monthly && savings_monthly !== 0) {
      return res.status(400).json({ error: "Invalid savings value" });
    }

    const timestamp = new Date().toISOString();
    
    // Calculate actual 30-day cost for 'before' value
    const thirtyDaysAgo = format(subDays(new Date(), 30), "yyyy-MM-dd");
    const costRow = db.prepare("SELECT SUM(cost) as total FROM cost_data WHERE date >= ?").get(thirtyDaysAgo) as { total: number };
    const before = Math.round(costRow?.total || 4991);

    // Update the actual cost data to "fix" the anomaly manually
    const baseCosts: Record<string, number> = { EC2: 150, RDS: 200, S3: 50, Lambda: 20 };
    const normalCost = baseCosts[service] || 100;
    
    // We need the date or ID to update. Let's assume we update the most recent entry for this service
    db.prepare(`
      UPDATE cost_data 
      SET cost = ?, cpu_utilization = 0.75 
      WHERE service = ? AND date = (SELECT MAX(date) FROM cost_data WHERE service = ?)
    `).run(normalCost + (Math.random() * 10), service, service);

    db.prepare(`
      INSERT INTO audit_log 
      (timestamp, service, action, savings_monthly, before_cost, after_cost, efficiency_score)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(timestamp, service, action, savings_monthly, before, before - savings_monthly, 68 + Math.floor(Math.random()*12));

    console.log(`✅ Remediated ${service} | Action: ${action} | Saved ~$${savings_monthly}/month`);

    res.json({
      success: true,
      message: `Remediated ${service}`,
      savings_realized: savings_monthly,
      new_efficiency: 75
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Existing endpoints (health, cost_data, audit_log)
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/api/cost_data", (req, res) => {
  try {
    const rows = db.prepare("SELECT * FROM cost_data ORDER BY date ASC").all();
    res.json(rows);
  } catch (err: any) {
    console.error("DB Error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/audit_log", (req, res) => {
  try {
    const rows = db.prepare("SELECT * FROM audit_log ORDER BY timestamp DESC").all();
    res.json(rows);
  } catch (err: any) {
    console.error("DB Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// === Background Auto-Remediation ===
async function autoRemediate() {
  console.log("🤖 Running background auto-remediation check...");
  try {
    const anomalies = detectAnomalies();
    const highConfidence = anomalies.filter(a => a.confidence >= 90);

    if (highConfidence.length === 0) {
      console.log("🤖 No high-confidence anomalies found for auto-remediation.");
      return;
    }

    for (const anomaly of highConfidence) {
      // Check if already remediated in the last 24h
      const alreadyLogged = db.prepare("SELECT id FROM audit_log WHERE service = ? AND timestamp > ?").get(
        anomaly.service, 
        subDays(new Date(), 1).toISOString()
      );

      if (alreadyLogged) {
        console.log(`🤖 Skipping ${anomaly.service} - already remediated recently.`);
        continue;
      }

      const timestamp = new Date().toISOString();
      const thirtyDaysAgo = format(subDays(new Date(), 30), "yyyy-MM-dd");
      const costRow = db.prepare("SELECT SUM(cost) as total FROM cost_data WHERE date >= ?").get(thirtyDaysAgo) as { total: number };
      const before = Math.round(costRow?.total || 4991);
      const savings = anomaly.projected_waste_monthly;
      const action = `[AUTO] ${getRecommendation(anomaly)}`;

      // Update the actual cost data to "fix" the anomaly in the simulation
      const baseCosts: Record<string, number> = { EC2: 150, RDS: 200, S3: 50, Lambda: 20 };
      const normalCost = baseCosts[anomaly.service] || 100;
      
      db.prepare("UPDATE cost_data SET cost = ?, cpu_utilization = 0.75 WHERE id = ?").run(
        normalCost + (Math.random() * 10), 
        anomaly.id
      );

      db.prepare(`
        INSERT INTO audit_log 
        (timestamp, service, action, savings_monthly, before_cost, after_cost, efficiency_score)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(timestamp, anomaly.service, action, savings, before, before - savings, 85);

      console.log(`🤖 AUTO-REMEDIATED ${anomaly.service} | Saved ~$${savings}/month | Data Normalized`);
    }
  } catch (err) {
    console.error("🤖 Auto-Remediation Error:", err);
  }
}

// Run every 30 seconds for demo purposes
setInterval(autoRemediate, 30 * 1000);
// Run once on startup after 10s
setTimeout(autoRemediate, 10000);

// === Real-time Data Simulation ===
function simulateNewData() {
  const services = ["EC2", "RDS", "S3", "Lambda"];
  const baseCosts: Record<string, number> = { EC2: 150, RDS: 200, S3: 50, Lambda: 20 };
  
  // Get the latest date in the DB and increment it
  const latestRow = db.prepare("SELECT MAX(date) as lastDate FROM cost_data").get() as { lastDate: string };
  const nextDate = latestRow?.lastDate ? addDays(parseISO(latestRow.lastDate), 1) : new Date();
  const dateStr = format(nextDate, "yyyy-MM-dd");
  
  const insert = db.prepare(`
    INSERT INTO cost_data (date, service, cost, cpu_utilization, memory_utilization)
    VALUES (?, ?, ?, ?, ?)
  `);

  services.forEach((service) => {
    let cost = baseCosts[service] + (Math.random() * 20 - 10);
    let cpu = 0.55 + Math.random() * 0.30;
    let mem = 0.50 + Math.random() * 0.35;

    // Randomly inject a spike (15% chance for demo)
    if (Math.random() > 0.85) {
      cost *= (4 + Math.random() * 6);
      cpu = 0.92 + Math.random() * 0.08;
      console.log(`🚨 SIMULATED ANOMALY: ${service} spike on ${dateStr}`);
    }

    insert.run(dateStr, service, Math.max(5, cost), Math.min(1, cpu), Math.min(1, mem));
  });
  
  // Delete the oldest date ONLY if we have more than 90 days to keep the window sliding
  const dateCount = (db.prepare("SELECT COUNT(DISTINCT date) as count FROM cost_data").get() as any).count;
  if (dateCount > 90) {
    const oldestRow = db.prepare("SELECT MIN(date) as firstDate FROM cost_data").get() as { firstDate: string };
    if (oldestRow?.firstDate) {
      db.prepare("DELETE FROM cost_data WHERE date = ?").run(oldestRow.firstDate);
    }
  }
}

// Simulate new data every 10 seconds
setInterval(simulateNewData, 10000);

// Vite + static serving
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}
startServer();