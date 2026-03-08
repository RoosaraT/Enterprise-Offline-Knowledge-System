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
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PDF_EXTRACT_SCRIPT = path.join(__dirname, "pdf_extract.py");

console.log("PDF script path:", PDF_EXTRACT_SCRIPT);
console.log("PDF script exists:", fs.existsSync(PDF_EXTRACT_SCRIPT));



// -------------------- Config --------------------
const PORT = 3001;
const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret-in-env";
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5176";
const COOKIE_NAME = "eoks_session";
const CSRF_COOKIE_NAME = "eoks_csrf";
const COOKIE_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const SESSION_RENEW_WINDOW_MS = 60 * 60 * 1000;
const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_RATE_LIMIT_MAX = 10;
const UPLOAD_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const UPLOAD_RATE_LIMIT_MAX = 30;

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
app.use(cors({ origin: FRONTEND_ORIGIN, credentials: true }));

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

db.exec(`
  CREATE TABLE IF NOT EXISTS auth_sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    csrf_token TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    revoked_at TEXT
  );
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id, created_at DESC);`);

db.exec(`
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    metadata_json TEXT,
    ip_address TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_logs_user_time ON audit_logs(user_id, created_at DESC);`);

db.exec(`
  CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    reset_at TEXT NOT NULL
  );
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_rate_limits_reset_at ON rate_limits(reset_at);`);

// -------------------- Auth middleware --------------------
function parseCookies(req) {
  const raw = req.headers.cookie || "";
  return raw
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((acc, part) => {
      const eq = part.indexOf("=");
      if (eq === -1) return acc;
      const key = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      acc[key] = decodeURIComponent(value);
      return acc;
    }, {});
}

function setSessionCookies(res, token, csrfToken) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: IS_PRODUCTION,
    path: "/",
    maxAge: COOKIE_MAX_AGE_MS,
  });
  res.cookie(CSRF_COOKIE_NAME, csrfToken, {
    httpOnly: false,
    sameSite: "lax",
    secure: IS_PRODUCTION,
    path: "/",
    maxAge: COOKIE_MAX_AGE_MS,
  });
}

function clearSessionCookies(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: "lax",
    secure: IS_PRODUCTION,
    path: "/",
  });
  res.clearCookie(CSRF_COOKIE_NAME, {
    httpOnly: false,
    sameSite: "lax",
    secure: IS_PRODUCTION,
    path: "/",
  });
}

function isoFromNow(ms) {
  return new Date(Date.now() + ms).toISOString();
}

function createAuthSession(userId) {
  const sessionId = crypto.randomUUID();
  const csrfToken = crypto.randomBytes(24).toString("hex");
  db.prepare(
    `INSERT INTO auth_sessions (id, user_id, csrf_token, expires_at)
     VALUES (?, ?, ?, ?)`
  ).run(sessionId, userId, csrfToken, isoFromNow(COOKIE_MAX_AGE_MS));
  return { sessionId, csrfToken };
}

function revokeAuthSession(sessionId) {
  if (!sessionId) return;
  db.prepare(`UPDATE auth_sessions SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL`).run(sessionId);
}

function revokeUserSessions(userId) {
  if (!userId) return;
  db.prepare(`UPDATE auth_sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL`).run(userId);
}

function issueSession(res, user) {
  const { sessionId, csrfToken } = createAuthSession(user.id);
  const token = jwt.sign({ sub: user.id, email: user.email, sid: sessionId }, JWT_SECRET, { expiresIn: "8h" });
  setSessionCookies(res, token, csrfToken);
  return { sessionId, csrfToken, token };
}

function maybeRenewSession(req, res, sessionRow) {
  const expiresAtMs = new Date(sessionRow.expires_at).getTime();
  if (!Number.isFinite(expiresAtMs) || expiresAtMs - Date.now() > SESSION_RENEW_WINDOW_MS) return;
  db.prepare(`UPDATE auth_sessions SET expires_at = ?, last_seen_at = datetime('now') WHERE id = ?`).run(
    isoFromNow(COOKIE_MAX_AGE_MS),
    sessionRow.id,
  );
  const token = jwt.sign({ sub: req.user.sub, email: req.user.email, sid: sessionRow.id }, JWT_SECRET, { expiresIn: "8h" });
  setSessionCookies(res, token, sessionRow.csrf_token);
}

function audit(req, action, details = {}) {
  const {
    userId = req.user?.sub || null,
    targetType = null,
    targetId = null,
    metadata = null,
  } = details;
  db.prepare(
    `INSERT INTO audit_logs (user_id, action, target_type, target_id, metadata_json, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    userId,
    action,
    targetType,
    targetId == null ? null : String(targetId),
    metadata ? JSON.stringify(metadata) : null,
    req.ip || null,
    req.headers["user-agent"] || null,
  );
}

function checkRateLimit(bucketKey, windowMs, maxRequests) {
  const now = Date.now();
  const current = db.prepare("SELECT count, reset_at FROM rate_limits WHERE key = ?").get(bucketKey);

  if (!current || new Date(current.reset_at).getTime() <= now) {
    const resetAt = isoFromNow(windowMs);
    db.prepare(
      `INSERT INTO rate_limits (key, count, reset_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET count = excluded.count, reset_at = excluded.reset_at`
    ).run(bucketKey, 1, resetAt);
    return {
      allowed: true,
      remaining: Math.max(0, maxRequests - 1),
      retryAfterMs: windowMs,
    };
  }

  const nextCount = current.count + 1;
  db.prepare("UPDATE rate_limits SET count = ? WHERE key = ?").run(nextCount, bucketKey);
  return {
    allowed: nextCount <= maxRequests,
    remaining: Math.max(0, maxRequests - nextCount),
    retryAfterMs: Math.max(0, new Date(current.reset_at).getTime() - now),
  };
}

function rateLimit({ key, windowMs, maxRequests }) {
  return (req, res, next) => {
    const bucket = `${key}:${req.ip || "unknown"}`;
    const verdict = checkRateLimit(bucket, windowMs, maxRequests);
    res.setHeader("X-RateLimit-Limit", String(maxRequests));
    res.setHeader("X-RateLimit-Remaining", String(verdict.remaining));
    if (!verdict.allowed) {
      res.setHeader("Retry-After", String(Math.ceil(verdict.retryAfterMs / 1000)));
      return res.status(429).json({ error: "Too many requests. Please try again later." });
    }
    return next();
  };
}

function getSessionToken(req) {
  const auth = req.headers.authorization || "";
  const bearerToken = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const cookieToken = parseCookies(req)[COOKIE_NAME] || null;
  return cookieToken || bearerToken;
}

function readAuth(req) {
  const token = getSessionToken(req);
  if (!token) return null;

  const payload = jwt.verify(token, JWT_SECRET);
  const sessionId = payload?.sid || null;
  if (!sessionId) return null;

  const session = db.prepare(
    `SELECT id, user_id, csrf_token, expires_at, revoked_at
     FROM auth_sessions
     WHERE id = ?`
  ).get(sessionId);

  if (!session || session.user_id !== payload.sub || session.revoked_at) return null;
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    revokeAuthSession(session.id);
    return null;
  }

  return { payload, session };
}

function timingSafeEqualText(a, b) {
  const aBuf = Buffer.from(String(a || ""), "utf8");
  const bBuf = Buffer.from(String(b || ""), "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function requireAuth(req, res, next) {
  try {
    const auth = readAuth(req);
    if (!auth) {
      clearSessionCookies(res);
      return res.status(401).json({ error: "Invalid session" });
    }
    req.user = auth.payload;
    req.session = auth.session;
    const currentUser = db.prepare("SELECT id, email, role, status FROM users WHERE id = ?").get(auth.payload.sub);
    if (!currentUser || currentUser.status !== "Active") {
      revokeAuthSession(auth.session.id);
      clearSessionCookies(res);
      return res.status(403).json({ error: "Account is not active" });
    }
    req.currentUser = currentUser;
    db.prepare(`UPDATE auth_sessions SET last_seen_at = datetime('now') WHERE id = ?`).run(auth.session.id);
    maybeRenewSession(req, res, auth.session);
    return next();
  } catch {
    clearSessionCookies(res);
    return res.status(401).json({ error: "Invalid session" });
  }
}

function requireCsrf(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.path === "/api/login" || req.path === "/api/register" || req.path === "/api/health") return next();
  const cookies = parseCookies(req);
  const cookieToken = cookies[CSRF_COOKIE_NAME] || "";
  const headerToken = req.headers["x-csrf-token"] || "";
  const sessionToken = req.session?.csrf_token || "";
  if (!cookieToken || !headerToken || !sessionToken) {
    return res.status(403).json({ error: "CSRF validation failed" });
  }
  if (!timingSafeEqualText(cookieToken, headerToken) || !timingSafeEqualText(cookieToken, sessionToken)) {
    return res.status(403).json({ error: "CSRF validation failed" });
  }
  return next();
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

function runPdfExtractor(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: __dirname }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error("Failed to parse PDF extractor output: " + e.message));
      }
    });
  });
}

async function extractPdfPages(pdfPath) {
  if (!fs.existsSync(PDF_EXTRACT_SCRIPT)) {
    throw new Error(`pdf_extract.py not found at: ${PDF_EXTRACT_SCRIPT}`);
  }

  const configured = process.env.PYTHON_BIN ? [[process.env.PYTHON_BIN, [PDF_EXTRACT_SCRIPT, pdfPath]]] : [];
  const candidates =
    process.platform === "win32"
      ? [
          ...configured,
          ["py", ["-3", PDF_EXTRACT_SCRIPT, pdfPath]],
          ["python", [PDF_EXTRACT_SCRIPT, pdfPath]],
          ["python3", [PDF_EXTRACT_SCRIPT, pdfPath]],
        ]
      : [
          ...configured,
          ["python3", [PDF_EXTRACT_SCRIPT, pdfPath]],
          ["python", [PDF_EXTRACT_SCRIPT, pdfPath]],
        ];

  let lastError = null;
  for (const [command, args] of candidates) {
    try {
      return await runPdfExtractor(command, args);
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(
    `PDF extraction failed. Install Python and required packages, or set PYTHON_BIN. Last error: ${lastError?.message || "unknown"}`
  );
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
     WHEN lower(email) = 'admin@company.com' THEN 'Admin'
     WHEN lower(role) = 'admin' THEN 'Admin'
     ELSE 'User'
   END
   WHERE role IS NOT NULL`
).run();

// Ensure the built-in admin account always keeps admin privileges.
db.prepare(`UPDATE users SET role = 'Admin' WHERE lower(email) = 'admin@company.com'`).run();

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
    const created = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
    audit(req, "auth.register", {
      userId: created?.id || null,
      targetType: "user",
      targetId: created?.id || null,
      metadata: { email },
    });
    return res.json({ ok: true });
  } catch (e) {
    if (String(e).includes("UNIQUE")) return res.status(409).json({ error: "User already exists" });
    return res.status(500).json({ error: "Server error" });
  }
});

// Login
app.post("/api/login", rateLimit({ key: "login", windowMs: LOGIN_RATE_LIMIT_WINDOW_MS, maxRequests: LOGIN_RATE_LIMIT_MAX }), async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });

  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user) {
    audit(req, "auth.login_failed", { metadata: { email, reason: "user_not_found" } });
    return res.status(401).json({ error: "Invalid credentials" });
  }
  if (user.status && user.status !== "Active") {
    audit(req, "auth.login_failed", { userId: user.id, metadata: { email, reason: "suspended" } });
    return res.status(403).json({ error: "User is suspended" });
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    audit(req, "auth.login_failed", { userId: user.id, metadata: { email, reason: "bad_password" } });
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const { sessionId } = issueSession(res, user);
  audit(req, "auth.login", {
    userId: user.id,
    targetType: "session",
    targetId: sessionId,
    metadata: { role: user.role },
  });
  return res.json({
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      username: user.username,
      role: user.role,
      status: user.status,
      created_at: user.created_at,
    },
  });
});

app.post("/api/logout", requireAuth, requireCsrf, (req, res) => {
  revokeAuthSession(req.session?.id);
  audit(req, "auth.logout", {
    targetType: "session",
    targetId: req.session?.id,
  });
  clearSessionCookies(res);
  res.json({ ok: true });
});

// Me
app.get("/api/me", requireAuth, (req, res) => {
  const user = db.prepare("SELECT id, email, name, username, role, status, created_at FROM users WHERE id = ?").get(req.user.sub);
  res.json(user || { id: req.user.sub, email: req.user.email });
});

app.get("/api/audit-logs", requireAuth, requireAdmin, (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 100));
  const actionFilter = String(req.query.action || "").trim();
  const actorFilter = String(req.query.actor || "").trim().toLowerCase();
  const queryFilter = String(req.query.q || "").trim().toLowerCase();
  const rows = db.prepare(`
    SELECT
      audit_logs.id,
      audit_logs.action,
      audit_logs.target_type,
      audit_logs.target_id,
      audit_logs.metadata_json,
      audit_logs.ip_address,
      audit_logs.user_agent,
      audit_logs.created_at,
      users.email AS actor_email
    FROM audit_logs
    LEFT JOIN users ON users.id = audit_logs.user_id
    ORDER BY audit_logs.created_at DESC, audit_logs.id DESC
    LIMIT ?
  `).all(limit);
  const filtered = rows.filter((row) => {
    if (actionFilter && row.action !== actionFilter) return false;
    if (actorFilter && !String(row.actor_email || "").toLowerCase().includes(actorFilter)) return false;
    if (queryFilter) {
      const haystack = [
        row.action,
        row.target_type,
        row.target_id,
        row.actor_email,
        row.ip_address,
        row.metadata_json,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(queryFilter)) return false;
    }
    return true;
  });
  res.json({
    logs: filtered.map((row) => ({
      ...row,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
    })),
  });
});

// Admin users management
app.get("/api/users", requireAuth, requireAdmin, (req, res) => {
  const rows = db
    .prepare("SELECT id, name, username, email, role, status, created_at FROM users ORDER BY created_at DESC")
    .all();
  res.json({ users: rows });
});

app.patch("/api/users/:id", requireAuth, requireCsrf, requireAdmin, (req, res) => {
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
  const finalStatus = nextStatus || current.status;
  if (finalStatus !== "Active") revokeUserSessions(id);
  audit(req, "admin.user_updated", {
    targetType: "user",
    targetId: id,
    metadata: {
      role: nextRole || current.role,
      status: nextStatus || current.status,
      name: nextName || current.name,
    },
  });
  res.json({ ok: true });
});

app.delete("/api/users/:id", requireAuth, requireCsrf, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare("SELECT id FROM users WHERE id = ?").get(id);
  if (!user) return res.status(404).json({ error: "User not found" });
  revokeUserSessions(id);
  db.prepare("DELETE FROM users WHERE id = ?").run(id);
  audit(req, "admin.user_deleted", { targetType: "user", targetId: id });
  res.json({ ok: true });
});

app.post("/api/users/:id/revoke-sessions", requireAuth, requireCsrf, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare("SELECT id, email FROM users WHERE id = ?").get(id);
  if (!user) return res.status(404).json({ error: "User not found" });
  revokeUserSessions(id);
  audit(req, "admin.user_sessions_revoked", {
    targetType: "user",
    targetId: id,
    metadata: { email: user.email },
  });
  res.json({ ok: true });
});

app.post("/api/users", requireAuth, requireCsrf, requireAdmin, async (req, res) => {
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
    audit(req, "admin.user_created", {
      targetType: "user",
      targetId: user?.id || null,
      metadata: { email, role: safeRole, status: safeStatus },
    });
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

app.put("/api/settings", requireAuth, requireCsrf, requireAdmin, (req, res) => {
  const { org_name, default_user_role, allow_registrations } = req.body || {};
  if (org_name) setSetting("org_name", String(org_name).trim());
  if (default_user_role) setSetting("default_user_role", normalizeRole(default_user_role));
  if (allow_registrations !== undefined) setSetting("allow_registrations", String(Boolean(allow_registrations)));
  audit(req, "admin.settings_updated", {
    targetType: "settings",
    metadata: { org_name, default_user_role, allow_registrations },
  });
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

app.put("/api/user-settings", requireAuth, requireCsrf, (req, res) => {
  const { display_name, auto_scroll } = req.body || {};
  const safeName = display_name ? String(display_name).trim() : null;
  const autoScroll = auto_scroll === undefined ? 1 : auto_scroll ? 1 : 0;
  db.prepare(
    "INSERT INTO user_settings (user_id, display_name, auto_scroll) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET display_name = excluded.display_name, auto_scroll = excluded.auto_scroll"
  ).run(req.user.sub, safeName, autoScroll);
  audit(req, "user.settings_updated", {
    targetType: "user_settings",
    targetId: req.user.sub,
    metadata: { display_name: safeName, auto_scroll: !!autoScroll },
  });
  res.json({ ok: true });
});

// Upload + ingest (TXT + PDF)
app.post("/api/upload", requireAuth, requireCsrf, requireAdmin, rateLimit({ key: "upload", windowMs: UPLOAD_RATE_LIMIT_WINDOW_MS, maxRequests: UPLOAD_RATE_LIMIT_MAX }), upload.array("files", 50), async (req, res) => {
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

    audit(req, "admin.files_uploaded", {
      targetType: "file",
      metadata: { count: results.length, files: results.map((r) => ({ id: r.id, name: r.name })) },
    });
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

app.get("/api/files/:id/view", requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare("SELECT * FROM files WHERE id = ?").get(id);
  if (!row) return res.status(404).json({ error: "File not found" });
  audit(req, "admin.file_viewed", {
    targetType: "file",
    targetId: id,
    metadata: { name: row.original_name },
  });

  const fullPath = path.join(uploadDir, row.stored_name);
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: "Stored file missing" });

  if (row.mime_type) res.type(row.mime_type);
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(row.original_name)}"`);
  return res.sendFile(fullPath);
});

app.delete("/api/files/:id", requireAuth, requireCsrf, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare("SELECT * FROM files WHERE id = ?").get(id);
  if (!row) return res.status(404).json({ error: "File not found" });

  db.prepare("DELETE FROM doc_chunks WHERE file_id = ?").run(id);
  db.prepare("DELETE FROM files WHERE id = ?").run(id);

  const fullPath = path.join(uploadDir, row.stored_name);
  if (fs.existsSync(fullPath)) {
    try {
      fs.unlinkSync(fullPath);
    } catch (e) {
      return res.status(500).json({ error: "Failed to delete stored file" });
    }
  }

  audit(req, "admin.file_deleted", {
    targetType: "file",
    targetId: id,
    metadata: { name: row.original_name },
  });
  return res.json({ ok: true });
});

// Exact word/phrase search (fast, offline)
app.post("/api/search", requireAuth, requireCsrf, (req, res) => {
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
app.post("/api/ask", requireAuth, requireCsrf, async (req, res) => {
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
app.post("/api/chat", requireAuth, requireCsrf, async (req, res) => {
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

app.post("/api/chat/sessions", requireAuth, requireCsrf, (req, res) => {
  const sdb = ensureSessionDb(req.user.sub);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  sdb.prepare(`INSERT INTO chat_sessions (id, title) VALUES (?, ?)`).run(id, "New chat");
  const session = sdb.prepare(`SELECT id, title, created_at FROM chat_sessions WHERE id = ?`).get(id);
  audit(req, "user.chat_session_created", { targetType: "chat_session", targetId: id });
  res.json({ session });
});

app.patch("/api/chat/sessions/:id", requireAuth, requireCsrf, (req, res) => {
  const sdb = ensureSessionDb(req.user.sub);
  const { title } = req.body || {};
  const safeTitle = String(title || "").trim();
  if (!safeTitle) return res.status(400).json({ error: "Title required" });
  const session = sdb.prepare(`SELECT id FROM chat_sessions WHERE id = ?`).get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  sdb.prepare(`UPDATE chat_sessions SET title = ? WHERE id = ?`).run(safeTitle.slice(0, 80), req.params.id);
  const updated = sdb.prepare(`SELECT id, title, created_at FROM chat_sessions WHERE id = ?`).get(req.params.id);
  audit(req, "user.chat_session_renamed", {
    targetType: "chat_session",
    targetId: req.params.id,
    metadata: { title: updated?.title || safeTitle.slice(0, 80) },
  });
  res.json({ session: updated });
});

app.delete("/api/chat/sessions/:id", requireAuth, requireCsrf, (req, res) => {
  const sdb = ensureSessionDb(req.user.sub);
  const existing = sdb.prepare(`SELECT id FROM chat_sessions WHERE id = ?`).get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Session not found" });
  sdb.prepare(`DELETE FROM messages WHERE session_id = ?`).run(req.params.id);
  sdb.prepare(`DELETE FROM chat_sessions WHERE id = ?`).run(req.params.id);
  audit(req, "user.chat_session_deleted", { targetType: "chat_session", targetId: req.params.id });
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
app.post("/api/session/clear", requireAuth, requireCsrf, (req, res) => {
  const userId = req.user.sub;
  const dir = sessionDir(userId);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  audit(req, "user.session_cleared", { targetType: "session", targetId: userId });
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
