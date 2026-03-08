import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
const targetRoot = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(repoRoot, "backups", `backup-${timestamp}`);

const sources = [
  { from: path.join(repoRoot, "backend", "auth.db"), to: path.join(targetRoot, "auth.db") },
  { from: path.join(repoRoot, "backend", "uploads"), to: path.join(targetRoot, "uploads") },
  { from: path.join(repoRoot, "backend", "tmp", "sessions"), to: path.join(targetRoot, "sessions") },
];

fs.mkdirSync(targetRoot, { recursive: true });

for (const entry of sources) {
  if (!fs.existsSync(entry.from)) {
    console.warn(`Skipping missing path: ${entry.from}`);
    continue;
  }

  const stat = fs.statSync(entry.from);
  if (stat.isDirectory()) {
    fs.cpSync(entry.from, entry.to, { recursive: true, force: true });
  } else {
    fs.copyFileSync(entry.from, entry.to);
  }
}

console.log(`Backup completed: ${targetRoot}`);
