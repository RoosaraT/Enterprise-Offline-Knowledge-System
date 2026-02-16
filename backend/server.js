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


function ensureSessionDb(userId) {
  const dir = sessionDir(userId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const sdb = new Database(sessionDbPath(userId));

  sdb.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_name TEXT NOT NULL,
      location TEXT NOT NULL,
      content TEXT NOT NULL,
      embedding_json TEXT NOT NULL
    );
  `);

  sdb.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  return sdb;
}

// -------------------- Default user (dev) --------------------
const count = db.prepare("SELECT COUNT(*) as c FROM users").get().c;
if (count === 0) {
  const email = "admin@company.com";
  const pass = "admin1234";
  const hash = bcrypt.hashSync(pass, 10);
  db.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)").run(email, hash);
  console.log("Created default user:", email, "password:", pass);
}

// -------------------- Routes --------------------

// Register (optional)
app.post("/api/register", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password || password.length < 6) {
      return res.status(400).json({ error: "Email and password (min 6 chars) required" });
    }
    const password_hash = await bcrypt.hash(password, 10);
    db.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)").run(email, password_hash);
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

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });

  const token = jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: "8h" });
  return res.json({ token });
});

// Me
app.get("/api/me", requireAuth, (req, res) => {
  res.json({ id: req.user.sub, email: req.user.email });
});

// Upload + ingest (TXT + PDF)
app.post("/api/upload", requireAuth, upload.array("files", 50), async (req, res) => {
  try {
    const uploaded = req.files || [];
    const userId = req.user.sub;

    const insertFile = db.prepare(`
      INSERT INTO files (original_name, stored_name, mime_type, size_bytes)
      VALUES (?, ?, ?, ?)
    `);

    const sdb = ensureSessionDb(userId);
    const insertChunk = sdb.prepare(`
      INSERT INTO chunks (file_name, location, content, embedding_json)
      VALUES (?, ?, ?, ?)
    `);

    const results = [];

    for (const f of uploaded) {
      const info = insertFile.run(f.originalname, f.filename, f.mimetype, f.size);
      const fileId = info.lastInsertRowid;

      // ---- PDF ingest (FIXED: moved inside loop) ----
      const isPdf =
        f.mimetype === "application/pdf" ||
        f.originalname.toLowerCase().endsWith(".pdf");

      if (isPdf) {
        const fullPath = path.join(uploadDir, f.filename);

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
            insertChunk.run(f.originalname, location, content, JSON.stringify(emb));
          }
        }
      }

      // ---- TXT ingest (same as before) ----
      const isText =
        (f.mimetype && f.mimetype.startsWith("text/")) ||
        f.originalname.toLowerCase().endsWith(".txt");

      if (isText) {
        const fullPath = path.join(uploadDir, f.filename);
        const raw = fs.readFileSync(fullPath, "utf8");
        const chunks = chunkText(raw, 1200, 150);

        for (let i = 0; i < chunks.length; i++) {
          const content = chunks[i];
          const location = `Chunk ${i + 1}`;
          const emb = await ollamaEmbed(content);
          insertChunk.run(f.originalname, location, content, JSON.stringify(emb));
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
app.get("/api/files", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT * FROM files ORDER BY uploaded_at DESC").all();
  res.json({ files: rows });
});

// Exact word/phrase search (fast, offline)
app.post("/api/search", requireAuth, (req, res) => {
  const { query, topK = 20 } = req.body || {};
  if (!query || !query.trim()) return res.status(400).json({ error: "Query required" });

  const q = query.trim().toLowerCase();
  const userId = req.user.sub;
  const sdb = ensureSessionDb(userId);

  const rows = sdb.prepare(`SELECT file_name, location, content FROM chunks`).all();

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

    const userId = req.user.sub;
    const sdb = ensureSessionDb(userId);

    const rows = sdb.prepare(`SELECT file_name, location, content, embedding_json FROM chunks`).all();
    if (rows.length === 0) {
      return res.json({ answer: "No documents indexed in this session yet. Upload text files first.", citations: [] });
    }

    const qEmb = await ollamaEmbed(question.trim());

    const scored = rows
      .map((r) => {
        const emb = JSON.parse(r.embedding_json);
        return { file: r.file_name, location: r.location, content: r.content, score: cosineSim(qEmb, emb) };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(12, topK)));

    const evidence = scored
      .map((p, i) => `SOURCE ${i + 1}\nFILE: ${p.file}\nLOCATION: ${p.location}\nTEXT:\n${p.content}\n`)
      .join("\n---\n");

    const prompt = `You are an offline company document assistant.
Answer ONLY using the SOURCES below.
If the answer is not in the sources, say: "Not found in the uploaded documents."
Cite like: (FILE - LOCATION - SOURCE #)

User question: ${question.trim()}

SOURCES:
${evidence}

Return:
1) Answer (short)
2) Citations (bullet list)
`;

    const answer = await ollamaGenerate(prompt);

    res.json({
      answer,
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
    const { message, topK = 6 } = req.body || {};
    if (!message || !message.trim()) return res.status(400).json({ error: "Message required" });

    const userId = req.user.sub;
    const sdb = ensureSessionDb(userId);

    // save user message
    sdb.prepare(`INSERT INTO messages (role, content) VALUES (?, ?)`).run("user", message.trim());

    // load last 10 messages
    const historyRows = sdb
      .prepare(`SELECT role, content FROM messages ORDER BY id DESC LIMIT 10`)
      .all()
      .reverse();

    const historyText = historyRows.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n");

    const rows = sdb.prepare(`SELECT file_name, location, content, embedding_json FROM chunks`).all();
    if (rows.length === 0) {
      const reply = "No documents indexed in this session yet. Upload text files first.";
      sdb.prepare(`INSERT INTO messages (role, content) VALUES (?, ?)`).run("assistant", reply);
      return res.json({ reply, citations: [] });
    }

    const qEmb = await ollamaEmbed(message.trim());

    const scored = rows
      .map((r) => {
        const emb = JSON.parse(r.embedding_json);
        return { file: r.file_name, location: r.location, content: r.content, score: cosineSim(qEmb, emb) };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(12, topK)));

    const evidence = scored
      .map((p, i) => `SOURCE ${i + 1}\nFILE: ${p.file}\nLOCATION: ${p.location}\nTEXT:\n${p.content}\n`)
      .join("\n---\n");

    const prompt = `You are an offline company document assistant in a conversation.
Rules:
- Answer ONLY using the SOURCES.
- If not found, say: "Not found in the uploaded documents."
- Keep it short and clear.
- Cite like: (FILE - LOCATION - SOURCE #)

CONVERSATION:
${historyText}

SOURCES:
${evidence}

ASSISTANT:
`;

    const reply = await ollamaGenerate(prompt);

    sdb.prepare(`INSERT INTO messages (role, content) VALUES (?, ?)`).run("assistant", reply);

    res.json({
      reply,
      citations: scored.map((p, i) => ({
        source: i + 1,
        file: p.file,
        location: p.location,
        snippet: p.content.slice(0, 240).replace(/\s+/g, " ") + (p.content.length > 240 ? "..." : ""),
      })),
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
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
