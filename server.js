/* Finappa Server — этап 4а: бэкап данных приложения.
   Хранение: JSON-файлы на диске (Railway Volume, путь из DATA_DIR, по умолчанию ./data).
   Один файл на ключ устройства. Ключ — секрет, знает только владелец. */

const express = require("express");
const fs = require("fs");
const path = require("path");
const webpush = require("web-push");

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

/* ─────────────── Подписки: push-уведомления о списаниях ─────────────── */

const PUSH_DIR = path.join(DATA_DIR, "push");
fs.mkdirSync(PUSH_DIR, { recursive: true });

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:nickyredliss@gmail.com", VAPID_PUBLIC, VAPID_PRIVATE);
}

const pushPath = (key) => path.join(PUSH_DIR, key + ".json");
const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; } };
const writeJson = (p, obj) => { const t = p + ".tmp"; fs.writeFileSync(t, JSON.stringify(obj)); fs.renameSync(t, p); };

/* Зарегистрировать push-подписку браузера для ключа устройства */
app.post("/api/push/subscribe/:key", (req, res) => {
  const { key } = req.params;
  if (!KEY_RE.test(key)) return res.status(400).json({ error: "bad key" });
  const { subscription } = req.body || {};
  if (!subscription || !subscription.endpoint) return res.status(400).json({ error: "subscription required" });
  const rec = readJson(pushPath(key), {});
  rec.subscription = subscription;
  rec.updatedAt = new Date().toISOString();
  rec.notified = rec.notified || {};
  writeJson(pushPath(key), rec);
  res.json({ ok: true });
});

/* Тестовое уведомление — для проверки с телефона */
app.post("/api/push/test/:key", async (req, res) => {
  const { key } = req.params;
  if (!KEY_RE.test(key)) return res.status(400).json({ error: "bad key" });
  const rec = readJson(pushPath(key), null);
  if (!rec || !rec.subscription) return res.status(404).json({ error: "no subscription" });
  try {
    await webpush.sendNotification(rec.subscription, JSON.stringify({
      title: "Finappa",
      body: "Уведомления работают ✓",
    }));
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: "push failed", detail: String(e && e.statusCode) });
  }
});

/* Дата ближайшего списания месячной подписки (день с поджимом к концу месяца) */
function nextChargeDate(day, from) {
  const clamp = (y, m) => Math.min(day, new Date(y, m + 1, 0).getDate());
  let d = new Date(from.getFullYear(), from.getMonth(), clamp(from.getFullYear(), from.getMonth()));
  if (d < new Date(from.getFullYear(), from.getMonth(), from.getDate())) {
    d = new Date(from.getFullYear(), from.getMonth() + 1, clamp(from.getFullYear(), from.getMonth() + 1));
  }
  return d;
}

/* Час и «сегодня» в Бангкоке (UTC+7, без переходов) */
function bangkokNow() {
  const now = new Date(Date.now() + 7 * 3600 * 1000);
  return { hour: now.getUTCHours(), today: new Date(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) };
}

async function checkSubscriptionsAndNotify(force) {
  const { hour, today } = bangkokNow();
  if (!force && hour !== 10) return; // шлём раз в день, в 10-м часу по Бангкоку
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const files = fs.readdirSync(PUSH_DIR).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    const key = f.replace(/\.json$/, "");
    const rec = readJson(pushPath(key), null);
    if (!rec || !rec.subscription) continue;
    const backup = readJson(keyPath(key), null);
    if (!backup) continue;
    let data;
    try { data = JSON.parse(backup.data); } catch { continue; }
    const subs = Array.isArray(data.subscriptions) ? data.subscriptions : [];
    let changed = false;
    for (const s of subs) {
      if (!s || !s.id || !s.day || !s.amount) continue;
      const charge = nextChargeDate(Number(s.day), today);
      if (charge.getTime() !== tomorrow.getTime()) continue;
      const periodKey = `${charge.getFullYear()}-${String(charge.getMonth() + 1).padStart(2, "0")}`;
      if (rec.notified[s.id] === periodKey) continue; // уже уведомляли в этом месяце
      try {
        await webpush.sendNotification(rec.subscription, JSON.stringify({
          title: "Завтра списание",
          body: `${s.name}: ${s.amount} ${s.currency}. Открой Finappa, чтобы добавить расход.`,
        }));
        rec.notified[s.id] = periodKey;
        changed = true;
        console.log(`push sent: ${key.slice(0, 8)}… ${s.name}`);
      } catch (e) {
        console.error("push error", e && e.statusCode);
        if (e && (e.statusCode === 404 || e.statusCode === 410)) { delete rec.subscription; changed = true; break; }
      }
    }
    if (changed) writeJson(pushPath(key), rec);
  }
}

setInterval(() => checkSubscriptionsAndNotify(false).catch(() => {}), 60 * 60 * 1000);
setTimeout(() => checkSubscriptionsAndNotify(false).catch(() => {}), 15 * 1000);

/* Ручной прогон крона (для отладки): не шлёт вне окна, если не передать force */
app.post("/api/push/run-check", async (req, res) => {
  await checkSubscriptionsAndNotify(!!(req.body && req.body.force));
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`finappa-server on :${PORT}, data in ${DATA_DIR}`));
