// backend/server.js
import express from "express";
import cors from "cors";
import Database from "better-sqlite3";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import multer from "multer";
import path from "path";
import fs from "fs";
import { execFile } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PDF_EXTRACT_SCRIPT = path.join(__dirname, "pdf_extract.py");

console.log("PDF script path:", PDF_EXTRACT_SCRIPT);
console.log("PDF script exists:", fs.existsSync(PDF_EXTRACT_SCRIPT));



// -------------------- Config --------------------
const PORT = 3001;
const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret-in-env";
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5176";

// Ollama (local, offline after model download)
const OLLAMA_BASE = process.env.OLLAMA_BASE || "http://localhost:11434";
const OLLAMA_LLM_MODEL = process.env.OLLAMA_LLM_MODEL || "llama3.1:8b";
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";

// Uploads + session folders
const uploadDir = path.join(__dirname, "./uploads");
const sessionRoot = path.join(__dirname, "./tmp/sessions");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(sessionRoot)) fs.mkdirSync(sessionRoot, { recursive: true });

// -------------------- Multer --------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${Date.now()}_${safe}`);
  },
});
const upload = multer({ storage });

// -------------------- App --------------------
const app = express();
app.use(express.json());
app.use(cors({ origin: FRONTEND_ORIGIN }));

// -------------------- DB (permanent auth + file metadata) --------------------
const db = new Database(path.join(__dirname, "./auth.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Add user profile columns if missing (SQLite lacks IF NOT EXISTS for columns)
try { db.exec(`ALTER TABLE users ADD COLUMN name TEXT`); } catch {}
try { db.exec(`ALTER TABLE users ADD COLUMN username TEXT`); } catch {}
try { db.exec(`ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'User'`); } catch {}
try { db.exec(`ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'Active'`); } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    mime_type TEXT,
    size_bytes INTEGER,
    uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS doc_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER NOT NULL,
    file_name TEXT NOT NULL,
    location TEXT NOT NULL,
    content TEXT NOT NULL,
    embedding_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER PRIMARY KEY,
    display_name TEXT,
    auto_scroll INTEGER NOT NULL DEFAULT 1
  );
`);

// Per-user learning telemetry used for adaptive content generation and difficulty tuning.
db.exec(`
  CREATE TABLE IF NOT EXISTS learning_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    session_id TEXT,
    message_id INTEGER,
    event_type TEXT NOT NULL,
    topic TEXT,
    learning_style TEXT,
    detected_difficulty REAL,
    target_difficulty REAL,
    confidence REAL,
    engagement_score REAL,
    correctness_score REAL,
    response_time_ms INTEGER,
    hints_used INTEGER DEFAULT 0,
    attempt_count INTEGER DEFAULT 1,
    source_doc_count INTEGER DEFAULT 0,
    model_name TEXT,
    model_temperature REAL,
    metadata_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_learning_events_user_time ON learning_events(user_id, created_at);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_learning_events_session_time ON learning_events(session_id, created_at);`);

// -------------------- Auth middleware --------------------
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });

  try {
    req.user = jwt.verify(token, JWT_SECRET); // { sub, email, ... }
    return next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

function requireAdmin(req, res, next) {
  const user = db.prepare("SELECT role FROM users WHERE id = ?").get(req.user?.sub);
  if (!user || user.role !== "Admin") return res.status(403).json({ error: "Admin only" });
  return next();
}

// -------------------- Offline AI helpers (Ollama) --------------------
async function ollamaEmbed(text) {
  const res = await fetch(`${OLLAMA_BASE}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, prompt: text }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Ollama embeddings failed: ${err}`);
  }

  const data = await res.json();
  if (!data?.embedding) throw new Error("Ollama embeddings: missing embedding");
  return data.embedding;
}

async function ollamaGenerate(prompt) {
  const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: OLLAMA_LLM_MODEL, prompt, stream: false }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Ollama generate failed: ${err}`);
  }

  const data = await res.json();
  return data?.response ?? "";
}

async function expandQueriesForRetrieval(inputQuery) {
  const base = String(inputQuery || "").trim();
  if (!base) return [];

  const prompt = `You are a translation helper.
Return ONLY valid JSON with two keys:
{"english":"...","sinhala":"..."}
Rules:
- Keep meaning exact.
- If input is already English, english should match it naturally.
- If input is already Sinhala, sinhala should match it naturally.
- No markdown, no extra text.

Input:
${base}`;

  try {
    const raw = await ollamaGenerate(prompt);
    const jsonMatch = String(raw).match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    const english = String(parsed?.english || "").trim();
    const sinhala = String(parsed?.sinhala || "").trim();
    const candidates = [base, english, sinhala].filter(Boolean);
    const seen = new Set();
    const unique = [];
    for (const c of candidates) {
      const key = c.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(c);
      }
    }
    return unique;
  } catch {
    return [base];
  }
}

function chunkText(text, maxChars = 1200, overlap = 150) {
  const clean = String(text || "").replace(/\r\n/g, "\n");
  const chunks = [];
  let i = 0;

  while (i < clean.length) {
    const end = Math.min(clean.length, i + maxChars);
    chunks.push(clean.slice(i, end));
    if (end === clean.length) break;
    i = Math.max(0, end - overlap);
  }
  return chunks;
}

function cosineSim(a, b) {
  let dot = 0,
    na = 0,
    nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

function getSetting(key, fallback) {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, String(value));
}

function normalizeRole(role) {
  const r = String(role || "").trim().toLowerCase();
  if (r === "admin") return "Admin";
  return "User";
}

// -------------------- Session DB (temporary per user) --------------------
function sessionDir(userId) {
  return path.resolve(`${sessionRoot}/${userId}`);
}

function sessionDbPath(userId) {
  return path.resolve(`${sessionRoot}/${userId}/index.db`);
}

function extractPdfPages(pdfPath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(PDF_EXTRACT_SCRIPT)) {
      return reject(new Error(`pdf_extract.py not found at: ${PDF_EXTRACT_SCRIPT}`));
    }

    execFile("python3", [PDF_EXTRACT_SCRIPT, pdfPath], { cwd: __dirname }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error("Failed to parse PDF extractor output: " + e.message));
      }
    });
  });
}

function looksLikePdf(filePath) {
  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    return buf.toString("utf8") === "%PDF";
  } catch {
    return false;
  }
}


function ensureSessionDb(userId) {
  const dir = sessionDir(userId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const sdb = new Database(sessionDbPath(userId));

  sdb.exec(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  sdb.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  try { sdb.exec(`ALTER TABLE messages ADD COLUMN session_id TEXT`); } catch {}

  return sdb;
}

// -------------------- Default user (dev) --------------------
const count = db.prepare("SELECT COUNT(*) as c FROM users").get().c;
if (count === 0) {
  const email = "admin@company.com";
  const pass = "admin1234";
  const hash = bcrypt.hashSync(pass, 10);
  db.prepare(
    "INSERT INTO users (email, password_hash, name, username, role, status) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(email, hash, "Admin", "admin", "Admin", "Active");
  console.log("Created default user:", email, "password:", pass);
}

// Normalize legacy roles to User/Admin
db.prepare(
  `UPDATE users
   SET role = CASE
     WHEN lower(role) = 'admin' THEN 'Admin'
     ELSE 'User'
   END
   WHERE role IS NOT NULL`
).run();

// -------------------- Routes --------------------

// Register (optional)
app.post("/api/register", async (req, res) => {
  try {
    let { email, password, name, username } = req.body || {};
    if (!email && username) email = `${String(username).trim()}@local`;
    const allowRegistrations = getSetting("allow_registrations", "true") === "true";
    if (!allowRegistrations) {
      return res.status(403).json({ error: "Registrations are disabled" });
    }
    if (!email || !password || password.length < 6) {
      return res.status(400).json({ error: "Email and password (min 6 chars) required" });
    }
    const safeName = name ? String(name).trim() : null;
    const safeUsername = username ? String(username).trim() : null;
    const defaultRole = normalizeRole(getSetting("default_user_role", "User"));
    const password_hash = await bcrypt.hash(password, 10);
    db.prepare(
      "INSERT INTO users (email, password_hash, name, username, role, status) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(email, password_hash, safeName, safeUsername, defaultRole, "Active");
    return res.json({ ok: true });
  } catch (e) {
    if (String(e).includes("UNIQUE")) return res.status(409).json({ error: "User already exists" });
    return res.status(500).json({ error: "Server error" });
  }
});

// Login
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });

  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user) return res.status(401).json({ error: "Invalid credentials" });
  if (user.status && user.status !== "Active") return res.status(403).json({ error: "User is suspended" });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });

  const token = jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: "8h" });
  return res.json({ token, role: user.role });
});

// Me
app.get("/api/me", requireAuth, (req, res) => {
  const user = db.prepare("SELECT id, email, name, username, role, status, created_at FROM users WHERE id = ?").get(req.user.sub);
  res.json(user || { id: req.user.sub, email: req.user.email });
});

// Admin users management
app.get("/api/users", requireAuth, requireAdmin, (req, res) => {
  const rows = db
    .prepare("SELECT id, name, username, email, role, status, created_at FROM users ORDER BY created_at DESC")
    .all();
  res.json({ users: rows });
});

app.patch("/api/users/:id", requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const { role, status, name } = req.body || {};
  const user = db.prepare("SELECT id FROM users WHERE id = ?").get(id);
  if (!user) return res.status(404).json({ error: "User not found" });

  const nextRole = role ? normalizeRole(role) : null;
  const nextStatus = status ? String(status).trim() : null;
  const nextName = name ? String(name).trim() : null;

  const current = db.prepare("SELECT role, status, name FROM users WHERE id = ?").get(id);
  db.prepare("UPDATE users SET role = ?, status = ?, name = ? WHERE id = ?").run(
    nextRole || current.role,
    nextStatus || current.status,
    nextName || current.name,
    id
  );
  res.json({ ok: true });
});

app.delete("/api/users/:id", requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare("SELECT id FROM users WHERE id = ?").get(id);
  if (!user) return res.status(404).json({ error: "User not found" });
  db.prepare("DELETE FROM users WHERE id = ?").run(id);
  res.json({ ok: true });
});

app.post("/api/users", requireAuth, requireAdmin, async (req, res) => {
  try {
    let { email, password, name, username, role, status } = req.body || {};
    if (!email && username) email = `${String(username).trim()}@local`;
    if (!email || !password || String(password).length < 6) {
      return res.status(400).json({ error: "Email and password (min 6 chars) required" });
    }
    const safeName = name ? String(name).trim() : null;
    const safeUsername = username ? String(username).trim() : null;
    const safeRole = normalizeRole(role || "User");
    const safeStatus = status ? String(status).trim() : "Active";
    const password_hash = await bcrypt.hash(String(password), 10);
    db.prepare(
      "INSERT INTO users (email, password_hash, name, username, role, status) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(email, password_hash, safeName, safeUsername, safeRole, safeStatus);
    const user = db
      .prepare("SELECT id, name, username, email, role, status, created_at FROM users WHERE email = ?")
      .get(email);
    res.json({ user });
  } catch (e) {
    if (String(e).includes("UNIQUE")) return res.status(409).json({ error: "User already exists" });
    return res.status(500).json({ error: "Server error" });
  }
});

// App settings (admin)
app.get("/api/settings", requireAuth, requireAdmin, (req, res) => {
  const settings = {
    org_name: getSetting("org_name", "Enterprise Offline Knowledge System"),
    default_user_role: normalizeRole(getSetting("default_user_role", "User")),
    allow_registrations: getSetting("allow_registrations", "true") === "true",
  };
  res.json(settings);
});

app.put("/api/settings", requireAuth, requireAdmin, (req, res) => {
  const { org_name, default_user_role, allow_registrations } = req.body || {};
  if (org_name) setSetting("org_name", String(org_name).trim());
  if (default_user_role) setSetting("default_user_role", normalizeRole(default_user_role));
  if (allow_registrations !== undefined) setSetting("allow_registrations", String(Boolean(allow_registrations)));
  res.json({ ok: true });
});

// User settings
app.get("/api/user-settings", requireAuth, (req, res) => {
  const row = db
    .prepare("SELECT display_name, auto_scroll FROM user_settings WHERE user_id = ?")
    .get(req.user.sub);
  const displayName = row?.display_name || null;
  const autoScroll = row ? row.auto_scroll === 1 : true;
  res.json({ display_name: displayName, auto_scroll: autoScroll });
});

app.put("/api/user-settings", requireAuth, (req, res) => {
  const { display_name, auto_scroll } = req.body || {};
  const safeName = display_name ? String(display_name).trim() : null;
  const autoScroll = auto_scroll === undefined ? 1 : auto_scroll ? 1 : 0;
  db.prepare(
    "INSERT INTO user_settings (user_id, display_name, auto_scroll) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET display_name = excluded.display_name, auto_scroll = excluded.auto_scroll"
  ).run(req.user.sub, safeName, autoScroll);
  res.json({ ok: true });
});

// Upload + ingest (TXT + PDF)
app.post("/api/upload", requireAuth, requireAdmin, upload.array("files", 50), async (req, res) => {
  try {
    const uploaded = req.files || [];
    const userId = req.user.sub;

    const insertFile = db.prepare(`
      INSERT INTO files (original_name, stored_name, mime_type, size_bytes)
      VALUES (?, ?, ?, ?)
    `);

    const insertChunk = db.prepare(`
      INSERT INTO doc_chunks (file_id, file_name, location, content, embedding_json)
      VALUES (?, ?, ?, ?, ?)
    `);

    const results = [];

    for (const f of uploaded) {
      const info = insertFile.run(f.originalname, f.filename, f.mimetype, f.size);
      const fileId = info.lastInsertRowid;

      // ---- PDF ingest (FIXED: moved inside loop) ----
      const fullPath = path.join(uploadDir, f.filename);
      const nameLower = f.originalname.toLowerCase();
      const isPdf =
        f.mimetype === "application/pdf" ||
        nameLower.endsWith(".pdf") ||
        looksLikePdf(fullPath);

      if (isPdf) {
        const pages = await extractPdfPages(fullPath);
        const nonEmpty = pages.filter(p => (p.text || "").trim().length > 0).length;
        console.log("PDF pages:", pages.length, "nonempty:", nonEmpty);
 // [{page, text}...]

        for (const p of pages) {
          const pageText = (p.text || "").trim();
          if (!pageText) continue;

          const chunks = chunkText(pageText, 1200, 150);

          for (let i = 0; i < chunks.length; i++) {
            const content = chunks[i];
            const location = `Page ${p.page}`;
            const emb = await ollamaEmbed(content);
            insertChunk.run(fileId, f.originalname, location, content, JSON.stringify(emb));
          }
        }
      }

      // ---- TXT ingest (same as before) ----
      const isText =
        (f.mimetype && f.mimetype.startsWith("text/")) ||
        nameLower.endsWith(".txt") ||
        nameLower.endsWith(".md") ||
        nameLower.endsWith(".csv") ||
        nameLower.endsWith(".log") ||
        nameLower.endsWith(".json");

      if (isText) {
        const raw = fs.readFileSync(fullPath, "utf8");
        const chunks = chunkText(raw, 1200, 150);

        for (let i = 0; i < chunks.length; i++) {
          const content = chunks[i];
          const location = `Chunk ${i + 1}`;
          const emb = await ollamaEmbed(content);
          insertChunk.run(fileId, f.originalname, location, content, JSON.stringify(emb));
        }
      }

      results.push({ id: fileId, name: f.originalname, size: f.size, type: f.mimetype });
    }

    res.json({ ok: true, uploaded: results });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// List uploaded file metadata
app.get("/api/files", requireAuth, requireAdmin, (req, res) => {
  const rows = db.prepare("SELECT * FROM files ORDER BY uploaded_at DESC").all();
  res.json({ files: rows });
});

// Exact word/phrase search (fast, offline)
app.post("/api/search", requireAuth, (req, res) => {
  const { query, topK = 20 } = req.body || {};
  if (!query || !query.trim()) return res.status(400).json({ error: "Query required" });

  const q = query.trim().toLowerCase();
  const rows = db.prepare(`SELECT file_name, location, content FROM doc_chunks`).all();

  const results = [];
  for (const r of rows) {
    const textLower = r.content.toLowerCase();
    let idx = textLower.indexOf(q);

    while (idx !== -1 && results.length < topK) {
      const start = Math.max(0, idx - 60);
      const end = Math.min(r.content.length, idx + q.length + 60);

      results.push({
        file: r.file_name,
        location: r.location,
        snippet: r.content.slice(start, end).replace(/\s+/g, " "),
      });

      idx = textLower.indexOf(q, idx + q.length);
    }

    if (results.length >= topK) break;
  }

  res.json({ results });
});

// One-shot AI ask (context Q)
app.post("/api/ask", requireAuth, async (req, res) => {
  try {
    const { question, topK = 6 } = req.body || {};
    if (!question || !question.trim()) return res.status(400).json({ error: "Question required" });

    const rows = db.prepare(`SELECT file_name, location, content, embedding_json FROM doc_chunks`).all();
    if (rows.length === 0) {
      return res.json({ answer: "No content found, try something else.", citations: [] });
    }

    const queryVariants = await expandQueriesForRetrieval(question.trim());
    const queryEmbeddings = await Promise.all(queryVariants.map((q) => ollamaEmbed(q)));

    const scored = rows
      .map((r) => {
        const emb = JSON.parse(r.embedding_json);
        const score = queryEmbeddings.reduce((best, qEmb) => Math.max(best, cosineSim(qEmb, emb)), -Infinity);
        return { file: r.file_name, location: r.location, content: r.content, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(12, topK)));

    const evidence = scored
      .map((p, i) => `SOURCE ${i + 1}\nFILE: ${p.file}\nLOCATION: ${p.location}\nTEXT:\n${p.content}\n`)
      .join("\n---\n");

    const prompt = `You are an offline company document assistant.
Answer ONLY using the SOURCES below.
If the answer is not in the sources, say: "No content found, try something else."
Do NOT include citations, source numbers, filenames, or locations in the answer. If you need to attribute, say: "According to the database," and continue.

User question: ${question.trim()}

SOURCES:
${evidence}

Return:
Answer only (short)
`;

    const answer = await ollamaGenerate(prompt);

    const sources = Array.from(new Set(scored.map((p) => p.file)));

    res.json({
      answer,
      sources,
      citations: scored.map((p, i) => ({
        source: i + 1,
        file: p.file,
        location: p.location,
        snippet: p.content.slice(0, 240).replace(/\s+/g, " ") + (p.content.length > 240 ? "..." : ""),
        score: p.score,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Conversation chat (multi-turn)
app.post("/api/chat", requireAuth, async (req, res) => {
  try {
    const { message, topK = 6, sessionId } = req.body || {};
    if (!message || !message.trim()) return res.status(400).json({ error: "Message required" });

    const userId = req.user.sub;
    const sdb = ensureSessionDb(userId);
    let activeSessionId = sessionId;
    if (!activeSessionId) {
      activeSessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      sdb.prepare(`INSERT INTO chat_sessions (id, title) VALUES (?, ?)`).run(activeSessionId, "New chat");
    }

    // save user message
    sdb.prepare(`INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)`).run(activeSessionId, "user", message.trim());

    // update chat title if it's still default
    const session = sdb.prepare(`SELECT id, title FROM chat_sessions WHERE id = ?`).get(activeSessionId);
    if (session && session.title === "New chat") {
      const nextTitle = message.trim().slice(0, 36) + (message.trim().length > 36 ? "..." : "");
      sdb.prepare(`UPDATE chat_sessions SET title = ? WHERE id = ?`).run(nextTitle, activeSessionId);
    }

    // load last 10 messages
    const historyRows = sdb
      .prepare(`SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 10`)
      .all(activeSessionId)
      .reverse();

    const historyText = historyRows.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n");

    const rows = db.prepare(`SELECT file_name, location, content, embedding_json FROM doc_chunks`).all();
    if (rows.length === 0) {
      const reply = "No content found, try something else.";
      sdb.prepare(`INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)`).run(activeSessionId, "assistant", reply);
      return res.json({ reply, citations: [], sources: [], sessionId: activeSessionId });
    }

    const queryVariants = await expandQueriesForRetrieval(message.trim());
    const queryEmbeddings = await Promise.all(queryVariants.map((q) => ollamaEmbed(q)));

    const scored = rows
      .map((r) => {
        const emb = JSON.parse(r.embedding_json);
        const score = queryEmbeddings.reduce((best, qEmb) => Math.max(best, cosineSim(qEmb, emb)), -Infinity);
        return { file: r.file_name, location: r.location, content: r.content, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(12, topK)));

    const evidence = scored
      .map((p, i) => `SOURCE ${i + 1}\nFILE: ${p.file}\nLOCATION: ${p.location}\nTEXT:\n${p.content}\n`)
      .join("\n---\n");

    const prompt = `You are an offline company document assistant in a conversation.
Rules:
- Answer ONLY using the SOURCES.
- If not found, say: "No content found, try something else."
- Keep it short and clear.
- Do NOT include citations, source numbers, filenames, or locations in the answer. If you need to attribute, say: "According to the database," and continue.

CONVERSATION:
${historyText}

SOURCES:
${evidence}

ASSISTANT:
`;

    const reply = await ollamaGenerate(prompt);

    sdb.prepare(`INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)`).run(activeSessionId, "assistant", reply);

    const sources = Array.from(new Set(scored.map((p) => p.file)));

    res.json({
      reply,
      sources,
      citations: scored.map((p, i) => ({
        source: i + 1,
        file: p.file,
        location: p.location,
        snippet: p.content.slice(0, 240).replace(/\s+/g, " ") + (p.content.length > 240 ? "..." : ""),
      })),
      sessionId: activeSessionId,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Chat sessions
app.get("/api/chat/sessions", requireAuth, (req, res) => {
  const sdb = ensureSessionDb(req.user.sub);
  const sessions = sdb.prepare(`SELECT id, title, created_at FROM chat_sessions ORDER BY created_at DESC`).all();
  res.json({ sessions });
});

app.post("/api/chat/sessions", requireAuth, (req, res) => {
  const sdb = ensureSessionDb(req.user.sub);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  sdb.prepare(`INSERT INTO chat_sessions (id, title) VALUES (?, ?)`).run(id, "New chat");
  const session = sdb.prepare(`SELECT id, title, created_at FROM chat_sessions WHERE id = ?`).get(id);
  res.json({ session });
});

app.patch("/api/chat/sessions/:id", requireAuth, (req, res) => {
  const sdb = ensureSessionDb(req.user.sub);
  const { title } = req.body || {};
  const safeTitle = String(title || "").trim();
  if (!safeTitle) return res.status(400).json({ error: "Title required" });
  const session = sdb.prepare(`SELECT id FROM chat_sessions WHERE id = ?`).get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  sdb.prepare(`UPDATE chat_sessions SET title = ? WHERE id = ?`).run(safeTitle.slice(0, 80), req.params.id);
  const updated = sdb.prepare(`SELECT id, title, created_at FROM chat_sessions WHERE id = ?`).get(req.params.id);
  res.json({ session: updated });
});

app.delete("/api/chat/sessions/:id", requireAuth, (req, res) => {
  const sdb = ensureSessionDb(req.user.sub);
  const existing = sdb.prepare(`SELECT id FROM chat_sessions WHERE id = ?`).get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Session not found" });
  sdb.prepare(`DELETE FROM messages WHERE session_id = ?`).run(req.params.id);
  sdb.prepare(`DELETE FROM chat_sessions WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

app.get("/api/chat/sessions/:id/messages", requireAuth, (req, res) => {
  const sdb = ensureSessionDb(req.user.sub);
  const rows = sdb
    .prepare(`SELECT role, content, created_at FROM messages WHERE session_id = ? ORDER BY id ASC`)
    .all(req.params.id);
  res.json({ messages: rows });
});

app.get("/api/chat/sessions/:id/export", requireAuth, (req, res) => {
  const sdb = ensureSessionDb(req.user.sub);
  const session = sdb.prepare(`SELECT id, title, created_at FROM chat_sessions WHERE id = ?`).get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  const rows = sdb
    .prepare(`SELECT role, content, created_at FROM messages WHERE session_id = ? ORDER BY id ASC`)
    .all(req.params.id);
  const text = rows.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");
  res.json({ session, messages: rows, text });
});

// Clear session (forget everything indexed for this user)
app.post("/api/session/clear", requireAuth, (req, res) => {
  const userId = req.user.sub;
  const dir = sessionDir(userId);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  res.json({ ok: true });
});

// Health
app.get("/api/health", (req, res) => res.json({ ok: true }));

// -------------------- Start --------------------
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`CORS allowed origin: ${FRONTEND_ORIGIN}`);
  console.log(`Ollama base: ${OLLAMA_BASE}`);
});
