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
    res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Finappa-Key");
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

/* ─────────────── Этап 5а: общие кошельки ───────────────
   Кошелёк, которым владелец поделился, живёт отдельной записью на сервере.
   Личность отделена от секрета: userId = sha256(deviceKey). Ключ передаётся
   заголовком X-Finappa-Key и наружу (другим участникам) никогда не уходит. */

const crypto = require("crypto");

const SHARED_DIR = path.join(DATA_DIR, "shared");
const INVITE_DIR = path.join(DATA_DIR, "invites");
fs.mkdirSync(SHARED_DIR, { recursive: true });
fs.mkdirSync(INVITE_DIR, { recursive: true });

const SID_RE = /^sw-[a-f0-9]{16}$/;
const MAX_MEMBERS = 5;
const MAX_TXS = 20000;
const INVITE_TTL_MS = 48 * 3600 * 1000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // без похожих I,O,0,1

const userIdOf = (deviceKey) =>
  crypto.createHash("sha256").update(String(deviceKey)).digest("hex").slice(0, 16);

const sharedPath = (sid) => path.join(SHARED_DIR, sid + ".json");
const codePath = (code) => path.join(INVITE_DIR, code + ".json");

function auth(req, res, next) {
  const key = req.headers["x-finappa-key"];
  if (!key || !KEY_RE.test(String(key))) return res.status(401).json({ error: "auth required" });
  req.userId = userIdOf(key);
  next();
}

function loadShared(sid) {
  if (!SID_RE.test(String(sid))) return null;
  return readJson(sharedPath(sid), null);
}

const money = (o) =>
  o && typeof o === "object"
    ? { amount: Number(o.amount) || 0, currency: String(o.currency || "").slice(0, 5) }
    : null;

/* Нормализация операции: с клиента приходит только то, что нужно для баланса
   и показа. Категории денормализованы (имя+эмодзи), чтобы гостю не нужен был
   справочник владельца. */
function sanitizeTx(t, fallbackAuthor) {
  if (!t || typeof t.id !== "string" || !t.id || t.id.length > 40) return null;
  const kind = t.kind === "transfer" ? "transfer" : t.kind === "income" ? "income" : "expense";
  const out = {
    id: t.id,
    kind,
    date: typeof t.date === "string" ? t.date.slice(0, 10) : "",
    comment: typeof t.comment === "string" ? t.comment.slice(0, 200) : "",
    authorId: typeof t.authorId === "string" && t.authorId.length <= 32 ? t.authorId : fallbackAuthor,
    updatedAt: Number(t.updatedAt) || Date.now(),
    deleted: !!t.deleted,
  };
  if (kind === "transfer") {
    out.out = money(t.out);
    out.in = money(t.in);
    if (!out.out && !out.in) return null;
  } else {
    out.amount = Number(t.amount) || 0;
    out.currency = String(t.currency || "").slice(0, 5);
    out.catName = String(t.catName || "").slice(0, 40);
    out.catEmoji = String(t.catEmoji || "").slice(0, 8);
  }
  return out;
}

const sanitizeTxs = (arr, author) =>
  (Array.isArray(arr) ? arr : []).slice(0, MAX_TXS).map((t) => sanitizeTx(t, author)).filter(Boolean);

const publicMembers = (rec) =>
  rec.members.map((m) => ({ userId: m.userId, name: m.name, role: m.role }));

/* ── 5б: слияние операций ──
   Правила: запись принадлежит автору навсегда; гость касается только своих,
   владелец — любых. Побеждает больший updatedAt. Удаление — надгробием
   (deleted:true), а не отсутствием в снимке: так одновременная запись двух
   людей ничего не затирает. Старые надгробия подметаются через 90 дней. */
const TOMBSTONE_TTL_MS = 90 * 24 * 3600 * 1000;

function mergeTxs(rec, incoming, me) {
  const isOwner = me.role === "owner";
  const byId = new Map(rec.txs.map((t) => [t.id, t]));
  let changed = false;
  for (const t of incoming) {
    if (!isOwner) t.authorId = me.userId; // гость не подпишется чужим именем
    const cur = byId.get(t.id);
    if (!cur) {
      if (byId.size >= MAX_TXS) continue;
      byId.set(t.id, t);
      changed = true;
    } else {
      if (!isOwner && cur.authorId !== me.userId) continue; // чужое гость не трогает
      if ((t.updatedAt || 0) > (cur.updatedAt || 0)) {
        t.authorId = cur.authorId; // авторство — кто создал, оно не переписывается
        byId.set(t.id, t);
        changed = true;
      }
    }
  }
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  const next = [...byId.values()].filter((t) => !(t.deleted && (t.updatedAt || 0) < cutoff));
  if (next.length !== rec.txs.length) changed = true;
  if (changed) rec.txs = next;
  return changed;
}

function newCode() {
  const b = crypto.randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  return s;
}

/* Подмести протухшие приглашения (дёшево, вызывается при выдаче нового) */
function sweepInvites() {
  try {
    for (const f of fs.readdirSync(INVITE_DIR)) {
      if (!f.endsWith(".json")) continue;
      const inv = readJson(path.join(INVITE_DIR, f), null);
      if (!inv || inv.used || Date.now() > inv.expiresAt) {
        if (!inv || Date.now() > inv.expiresAt + INVITE_TTL_MS) fs.unlinkSync(path.join(INVITE_DIR, f));
      }
    }
  } catch { /* не критично */ }
}

/* Открыть кошелёк для совместного доступа (первичная выгрузка снимка) */
app.post("/api/shared/wallets", auth, (req, res) => {
  const { name, currencies, ownerName, txs } = req.body || {};
  if (typeof name !== "string" || !name.trim()) return res.status(400).json({ error: "name required" });
  if (!Array.isArray(currencies) || !currencies.length) return res.status(400).json({ error: "currencies required" });
  const sid = "sw-" + crypto.randomBytes(8).toString("hex");
  const rec = {
    id: sid,
    ownerId: req.userId,
    name: name.trim().slice(0, 60),
    currencies: currencies.slice(0, 12).map((c) => String(c).slice(0, 5)),
    members: [{
      userId: req.userId,
      name: String(ownerName || "Владелец").slice(0, 40),
      role: "owner",
      joinedAt: new Date().toISOString(),
    }],
    txs: sanitizeTxs(txs, req.userId),
    updatedAt: new Date().toISOString(),
  };
  writeJson(sharedPath(sid), rec);
  res.json({ sharedId: sid, members: publicMembers(rec), you: { userId: req.userId, role: "owner" }, updatedAt: rec.updatedAt });
});

/* Синхронизация: каждый пишущий участник толкает СВОИ изменения (слияние,
   не замена), обратно все получают полный набор операций кошелька. */
app.post("/api/shared/wallets/:sid/sync", auth, (req, res) => {
  const rec = loadShared(req.params.sid);
  if (!rec) return res.status(404).json({ error: "not found" });
  const me = rec.members.find((m) => m.userId === req.userId);
  if (!me) return res.status(403).json({ error: "forbidden" });

  const body = req.body || {};
  let changed = false;
  if (me.role === "owner") {
    if (typeof body.name === "string" && body.name.trim() && body.name.trim() !== rec.name) {
      rec.name = body.name.trim().slice(0, 60);
      changed = true;
    }
    if (Array.isArray(body.currencies) && body.currencies.length) {
      const next = body.currencies.slice(0, 12).map((c) => String(c).slice(0, 5));
      if (next.join(",") !== rec.currencies.join(",")) { rec.currencies = next; changed = true; }
    }
  }
  if (Array.isArray(body.txs) && body.txs.length) {
    if (me.role === "view") return res.status(403).json({ error: "read only" });
    changed = mergeTxs(rec, sanitizeTxs(body.txs, req.userId), me) || changed;
  }
  if (changed) {
    rec.updatedAt = new Date().toISOString();
    writeJson(sharedPath(rec.id), rec);
  }

  const owner = rec.members.find((m) => m.role === "owner") || { name: "" };
  res.json({
    name: rec.name,
    currencies: rec.currencies,
    members: publicMembers(rec),
    ownerName: owner.name,
    you: { userId: req.userId, name: me.name, role: me.role },
    txs: rec.txs,
    updatedAt: rec.updatedAt,
  });
});

/* Сменить право участника «смотреть» ↔ «записывать» (только владелец) */
app.patch("/api/shared/wallets/:sid/members/:uid", auth, (req, res) => {
  const rec = loadShared(req.params.sid);
  if (!rec) return res.status(404).json({ error: "not found" });
  if (rec.ownerId !== req.userId) return res.status(403).json({ error: "forbidden" });
  const role = req.body && req.body.role;
  if (role !== "view" && role !== "write") return res.status(400).json({ error: "bad role" });
  const m = rec.members.find((x) => x.userId === String(req.params.uid));
  if (!m) return res.status(404).json({ error: "no such member" });
  if (m.role === "owner") return res.status(400).json({ error: "owner role is fixed" });
  if (m.role !== role) {
    m.role = role;
    rec.updatedAt = new Date().toISOString();
    writeJson(sharedPath(rec.id), rec);
  }
  res.json({ ok: true, members: publicMembers(rec) });
});

/* Выдать одноразовый код приглашения (только владелец) */
app.post("/api/shared/wallets/:sid/invites", auth, (req, res) => {
  const rec = loadShared(req.params.sid);
  if (!rec) return res.status(404).json({ error: "not found" });
  if (rec.ownerId !== req.userId) return res.status(403).json({ error: "forbidden" });
  if (rec.members.length >= MAX_MEMBERS) return res.status(409).json({ error: "too many members" });
  sweepInvites();
  const role = req.body && req.body.role === "write" ? "write" : "view";
  const code = newCode();
  const expiresAt = Date.now() + INVITE_TTL_MS;
  writeJson(codePath(code), { code, sharedId: rec.id, role, createdBy: req.userId, expiresAt, used: false });
  res.json({ code, role, expiresAt });
});

/* Присоединиться по коду */
const acceptAttempts = new Map();
app.post("/api/shared/invites/:code/accept", auth, (req, res) => {
  const who = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?").split(",")[0];
  const a = acceptAttempts.get(who) || { n: 0, ts: Date.now() };
  if (Date.now() - a.ts > 3600 * 1000) { a.n = 0; a.ts = Date.now(); }
  a.n += 1;
  acceptAttempts.set(who, a);
  if (a.n > 20) return res.status(429).json({ error: "too many attempts" });

  const code = String(req.params.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== 8) return res.status(400).json({ error: "bad code" });
  const inv = readJson(codePath(code), null);
  if (!inv) return res.status(404).json({ error: "bad code" });
  if (Date.now() > inv.expiresAt) return res.status(410).json({ error: "expired" });

  const rec = loadShared(inv.sharedId);
  if (!rec) return res.status(404).json({ error: "wallet gone" });
  if (rec.ownerId === req.userId) return res.status(409).json({ error: "own wallet" });

  let me = rec.members.find((m) => m.userId === req.userId);
  if (!me) {
    if (inv.used) return res.status(409).json({ error: "code used" });
    if (rec.members.length >= MAX_MEMBERS) return res.status(409).json({ error: "too many members" });
    me = {
      userId: req.userId,
      name: String((req.body && req.body.name) || "Гость").slice(0, 40),
      role: inv.role,
      joinedAt: new Date().toISOString(),
    };
    rec.members.push(me);
    rec.updatedAt = new Date().toISOString();
    writeJson(sharedPath(rec.id), rec);
    inv.used = true;
    inv.usedBy = req.userId;
    writeJson(codePath(code), inv);
  }

  const owner = rec.members.find((m) => m.role === "owner") || { name: "" };
  res.json({
    sharedId: rec.id,
    name: rec.name,
    currencies: rec.currencies,
    members: publicMembers(rec),
    ownerName: owner.name,
    you: { userId: req.userId, name: me.name, role: me.role },
    txs: rec.txs,
    updatedAt: rec.updatedAt,
  });
});

/* Список участников */
app.get("/api/shared/wallets/:sid/members", auth, (req, res) => {
  const rec = loadShared(req.params.sid);
  if (!rec) return res.status(404).json({ error: "not found" });
  if (!rec.members.some((m) => m.userId === req.userId)) return res.status(403).json({ error: "forbidden" });
  res.json({ members: publicMembers(rec) });
});

/* Отключить участника (владелец — любого; участник — только себя) */
app.delete("/api/shared/wallets/:sid/members/:uid", auth, (req, res) => {
  const rec = loadShared(req.params.sid);
  if (!rec) return res.status(404).json({ error: "not found" });
  const target = String(req.params.uid);
  const isOwner = rec.ownerId === req.userId;
  if (!isOwner && target !== req.userId) return res.status(403).json({ error: "forbidden" });
  if (target === rec.ownerId) return res.status(400).json({ error: "owner cannot be removed" });
  rec.members = rec.members.filter((m) => m.userId !== target);
  rec.updatedAt = new Date().toISOString();
  writeJson(sharedPath(rec.id), rec);
  res.json({ ok: true, members: publicMembers(rec) });
});

/* Полностью закрыть общий доступ (только владелец) */
app.delete("/api/shared/wallets/:sid", auth, (req, res) => {
  const rec = loadShared(req.params.sid);
  if (!rec) return res.json({ ok: true });
  if (rec.ownerId !== req.userId) return res.status(403).json({ error: "forbidden" });
  try { fs.unlinkSync(sharedPath(rec.id)); } catch { /* уже нет */ }
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`finappa-server on :${PORT}, data in ${DATA_DIR}`));
