/* Finappa Server — этап 4а: бэкап данных приложения.
   Хранение: JSON-файлы на диске (Railway Volume, путь из DATA_DIR, по умолчанию ./data).
   Один файл на ключ устройства. Ключ — секрет, знает только владелец. */

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const MAX_BYTES = 2 * 1024 * 1024; // 2 МБ на бэкап — с запасом на годы записей

const ALLOWED_ORIGINS = new Set([
  "https://nickyredliss.github.io",
  "http://localhost:8099", // локальные тесты
]);

fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(express.json({ limit: MAX_BYTES }));

/* CORS */
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const KEY_RE = /^[a-z0-9][a-z0-9-]{7,63}$/;
const keyPath = (key) => path.join(DATA_DIR, key + ".json");

app.get("/health", (_req, res) => res.json({ ok: true, service: "finappa-server" }));

/* Сохранить бэкап */
app.put("/api/backup/:key", (req, res) => {
  const { key } = req.params;
  if (!KEY_RE.test(key)) return res.status(400).json({ error: "bad key" });
  const { data } = req.body || {};
  if (typeof data !== "string" || data.length === 0) {
    return res.status(400).json({ error: "data (string) required" });
  }
  if (data.length > MAX_BYTES) return res.status(413).json({ error: "too large" });
  /* data должен быть валидным JSON приложения */
  try {
    const parsed = JSON.parse(data);
    if (!parsed || !parsed.wallets || !parsed.categories) throw new Error("shape");
  } catch {
    return res.status(400).json({ error: "data must be valid Finappa JSON" });
  }
  const record = { data, updatedAt: new Date().toISOString(), bytes: data.length };
  const tmp = keyPath(key) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(record));
  fs.renameSync(tmp, keyPath(key)); // атомарная запись
  res.json({ ok: true, updatedAt: record.updatedAt, bytes: record.bytes });
});

/* Забрать бэкап */
app.get("/api/backup/:key", (req, res) => {
  const { key } = req.params;
  if (!KEY_RE.test(key)) return res.status(400).json({ error: "bad key" });
  const p = keyPath(key);
  if (!fs.existsSync(p)) return res.status(404).json({ error: "not found" });
  const record = JSON.parse(fs.readFileSync(p, "utf8"));
  res.json(record);
});

/* Только мета (без данных) — для индикатора «последний бэкап» */
app.get("/api/backup/:key/meta", (req, res) => {
  const { key } = req.params;
  if (!KEY_RE.test(key)) return res.status(400).json({ error: "bad key" });
  const p = keyPath(key);
  if (!fs.existsSync(p)) return res.status(404).json({ error: "not found" });
  const record = JSON.parse(fs.readFileSync(p, "utf8"));
  res.json({ updatedAt: record.updatedAt, bytes: record.bytes });
});

app.listen(PORT, () => console.log(`finappa-server on :${PORT}, data in ${DATA_DIR}`));
