/* Finappa Server — этап 4а: бэкап данных приложения.
   Хранение: JSON-файлы на диске (Railway Volume, путь из DATA_DIR, по умолчанию ./data).
   Один файл на ключ устройства. Ключ — секрет, знает только владелец. */

const express = require("express");
const fs = require("fs");
const path = require("path");
const webpush = require("web-push");
const https = require("https");

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
/* Быстрая команда с iPhone шлёт тело по-разному в зависимости от версии iOS:
   «Текст» → text/plain, «Форма» → x-www-form-urlencoded, «Файл» → octet-stream.
   Принимаем все три: пусть настройка на телефоне будет какой угодно. */
app.use(express.text({ type: ["text/plain", "text/*"], limit: 16 * 1024 }));
app.use(express.urlencoded({ extended: false, limit: 16 * 1024 }));
app.use(express.raw({ type: ["application/octet-stream"], limit: 16 * 1024 }));

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

app.get("/health", (_req, res) => res.json({ ok: true, service: "finappa-server", rev: "16" }));

/* ── ТЗ-18: курсы валют ──────────────────────────────────────────────────
   Клиент в третьи руки не ходит: провайдеры режут CORS и просят ключей, а
   кэш на сервере один на все устройства. Курс отдаём актуальный — в Сводке
   конвертация это линза, а не запись, поэтому хранить его в записях не надо
   и «правильного курса на дату» здесь не существует.

   Берём https напрямую, а не global fetch: сервер должен работать на любой
   версии Node, а не только на 18+. */

const RATES_PATH = path.join(DATA_DIR, "rates.json");
const RATES_TTL_MS = 60 * 60 * 1000;
const RATES_BASE = "USD";

const readRates = () => {
  try { return JSON.parse(fs.readFileSync(RATES_PATH, "utf8")); } catch (e) { return null; }
};
const writeRates = (v) => {
  try { fs.writeFileSync(RATES_PATH, JSON.stringify(v)); } catch (e) {}
};

const httpsJson = (url) =>
  new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const req = https.get(url, { timeout: 8000, headers: { "User-Agent": "finappa" } }, (r) => {
        if (r.statusCode !== 200) { r.resume(); return finish(null); }
        let body = "";
        r.setEncoding("utf8");
        r.on("data", (c) => { body += c; if (body.length > 400000) req.destroy(); });
        r.on("end", () => { try { finish(JSON.parse(body)); } catch (e) { finish(null); } });
        r.on("error", () => finish(null));
      });
      req.on("timeout", () => req.destroy());
      req.on("error", () => finish(null));
    } catch (e) { finish(null); }
  });

/* Два источника без ключа. Первый знает рубль, второй — запасной на случай,
   когда первый лежит. Проверяем ответ по наличию THB: пустой или урезанный
   ответ хуже отсутствия ответа, потому что молча испортит все цифры. */
const pullRates = async () => {
  const a = await httpsJson("https://open.er-api.com/v6/latest/" + RATES_BASE);
  if (a && a.rates && Number(a.rates.THB) > 0) {
    return { base: RATES_BASE, rates: a.rates, source: "er-api" };
  }
  const b = await httpsJson("https://api.frankfurter.app/latest?from=" + RATES_BASE);
  if (b && b.rates && Number(b.rates.THB) > 0) {
    const rates = Object.assign({}, b.rates);
    rates[RATES_BASE] = 1;
    return { base: RATES_BASE, rates: rates, source: "frankfurter" };
  }
  return null;
};

let ratesInFlight = null;
const pullRatesOnce = () => {
  if (!ratesInFlight) {
    ratesInFlight = pullRates().catch(() => null);
    ratesInFlight.then(
      () => { ratesInFlight = null; },
      () => { ratesInFlight = null; }
    );
  }
  return ratesInFlight;
};

app.get("/api/rates", async (_req, res) => {
  const cached = readRates();
  if (cached && Date.now() - Number(cached.fetchedAt || 0) < RATES_TTL_MS) {
    return res.json(Object.assign({ ok: true }, cached));
  }
  const got = await pullRatesOnce();
  if (got) {
    const out = { base: got.base, rates: got.rates, source: got.source, fetchedAt: Date.now() };
    writeRates(out);
    return res.json(Object.assign({ ok: true }, out));
  }
  /* Провайдер недоступен. Старый курс с честной датой лучше пустоты: человек
     увидит, на какой момент цифры, и сам решит, верить им или нет. */
  if (cached) return res.json(Object.assign({ ok: true, stale: true }, cached));
  res.json({ ok: false, error: "no rates" });
});

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
      if (s.shared) continue; // чужая подписка из общего кошелька — напоминаем только автору
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
const MAX_SUBS = 500;
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

/* ── 5б/5в/10: слияние операций и подписок ──
   Правила (с ТЗ-10): у общего кошелька равные права — любой участник правит
   и удаляет любую запись. Авторство («кто внёс») закрепляется при создании и
   больше не переписывается: подписаться чужим именем нельзя. Побеждает
   больший updatedAt. Удаление — надгробием (deleted:true), а не отсутствием
   в снимке: так одновременная запись двух людей ничего не затирает. Старые
   надгробия подметаются через 90 дней. */
const TOMBSTONE_TTL_MS = 90 * 24 * 3600 * 1000;

function mergeById(list, incoming, me, max) {
  const byId = new Map(list.map((t) => [t.id, t]));
  let changed = false;
  for (const t of incoming) {
    const cur = byId.get(t.id);
    if (!cur) {
      if (byId.size >= max) continue;
      t.authorId = me.userId; // новой записи автор — тот, кто её принёс
      byId.set(t.id, t);
      changed = true;
    } else {
      if ((t.updatedAt || 0) > (cur.updatedAt || 0)) {
        t.authorId = cur.authorId; // авторство — кто создал, оно не переписывается
        byId.set(t.id, t);
        changed = true;
      }
    }
  }
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  const next = [...byId.values()].filter((t) => !(t.deleted && (t.updatedAt || 0) < cutoff));
  if (next.length !== list.length) changed = true;
  return { next, changed };
}

function mergeTxs(rec, incoming, me) {
  const r = mergeById(rec.txs, incoming, me, MAX_TXS);
  if (r.changed) rec.txs = r.next;
  return r.changed;
}

function mergeSubs(rec, incoming, me) {
  const r = mergeById(rec.subs || [], incoming, me, MAX_SUBS);
  if (r.changed) rec.subs = r.next;
  return r.changed;
}

/* 5в/10: подписка общего кошелька. Категория денормализована, как у операций.
   С ТЗ-10 lastHandled путешествует: права равные, отметку «уже списано» видят
   оба участника — иначе одну и ту же подписку внесут дважды. */
function sanitizeSub(s, fallbackAuthor) {
  if (!s || typeof s.id !== "string" || !s.id || s.id.length > 40) return null;
  return {
    id: s.id,
    name: String(s.name || "").slice(0, 60),
    amount: Number(s.amount) || 0,
    currency: String(s.currency || "").slice(0, 5),
    day: Math.min(31, Math.max(1, Number(s.day) || 1)),
    periodicity: s.periodicity === "yearly" ? "yearly" : "monthly",
    month: s.periodicity === "yearly" ? Math.min(12, Math.max(1, Number(s.month) || 1)) : undefined,
    catName: String(s.catName || "").slice(0, 40),
    catEmoji: String(s.catEmoji || "").slice(0, 8),
    lastHandled: typeof s.lastHandled === "string" && s.lastHandled.length <= 12 ? s.lastHandled : null,
    authorId: typeof s.authorId === "string" && s.authorId.length <= 32 ? s.authorId : fallbackAuthor,
    updatedAt: Number(s.updatedAt) || Date.now(),
    deleted: !!s.deleted,
  };
}

const sanitizeSubs = (arr, author) =>
  (Array.isArray(arr) ? arr : []).slice(0, MAX_SUBS).map((s) => sanitizeSub(s, author)).filter(Boolean);

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

/* Синхронизация: каждый участник толкает свои изменения (слияние, не замена),
   обратно все получают полный набор операций кошелька. С ТЗ-10 права равные:
   роли «только просмотр» больше нет, писать может любой участник. */
app.post("/api/shared/wallets/:sid/sync", auth, (req, res) => {
  const rec = loadShared(req.params.sid);
  if (!rec) return res.status(404).json({ error: "not found" });
  const me = rec.members.find((m) => m.userId === req.userId);
  if (!me) return res.status(403).json({ error: "forbidden" });

  const body = req.body || {};
  let changed = false;
  /* 10: старые участники с ролью «view» тихо повышаются до «write» */
  if (me.role === "view") { me.role = "write"; changed = true; }
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
    changed = mergeTxs(rec, sanitizeTxs(body.txs, req.userId), me) || changed;
  }
  if (Array.isArray(body.subs) && body.subs.length) {
    changed = mergeSubs(rec, sanitizeSubs(body.subs, req.userId), me) || changed;
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
    subs: rec.subs || [],
    updatedAt: rec.updatedAt,
  });
});

/* 10: роли «просмотр» больше нет. Ручка оставлена для старых клиентов —
   понижение до «view» она молча превращает в «write». */
app.patch("/api/shared/wallets/:sid/members/:uid", auth, (req, res) => {
  const rec = loadShared(req.params.sid);
  if (!rec) return res.status(404).json({ error: "not found" });
  if (rec.ownerId !== req.userId) return res.status(403).json({ error: "forbidden" });
  const asked = req.body && req.body.role;
  if (asked !== "view" && asked !== "write") return res.status(400).json({ error: "bad role" });
  const role = "write";
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
  const role = "write"; // 10: приглашённый сразу пишет, роли «просмотр» больше нет
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
    subs: rec.subs || [],
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

/* ───────────────────────── Инбокс черновиков (ТЗ-13) ─────────────────────────
   Черновик — просто текст, который приехал снаружи (Быстрая команда, автоматизация
   на входящее SMS). Приложение забирает их и подтверждает приём, после чего
   сервер их не хранит: инбокс — почтовый ящик, а не хранилище.
   Отправка идёт по отдельному токену, НЕ по ключу устройства: токен попадает
   в Быструю команду на телефоне, и утечка токена даёт только право прислать
   черновик, но не читать бэкап. */

const INBOX_DIR = path.join(DATA_DIR, "inbox");
fs.mkdirSync(INBOX_DIR, { recursive: true });

const MAX_INBOX = 200;          // ящик не растёт бесконечно: старое вытесняется
const MAX_DRAFT_LEN = 500;
const TOKEN_RE = /^[a-z0-9]{12}$/;
const inboxPath = (uid) => path.join(INBOX_DIR, uid + ".json");
const TOKENS_PATH = path.join(INBOX_DIR, "_tokens.json");

const newToken = () => {
  const abc = "abcdefghijkmnpqrstuvwxyz23456789"; // без похожих l,o,0,1
  let out = "";
  const buf = crypto.randomBytes(12);
  for (let i = 0; i < 12; i++) out += abc[buf[i] % abc.length];
  return out;
};

/* userId → токен; обратная карта токен → userId лежит рядом одним файлом */
function inboxToken(userId) {
  const map = readJson(TOKENS_PATH, {});
  for (const t of Object.keys(map)) if (map[t] === userId) return t;
  let t = newToken();
  while (map[t]) t = newToken();
  map[t] = userId;
  writeJson(TOKENS_PATH, map);
  return t;
}

const readInbox = (uid) => {
  const r = readJson(inboxPath(uid), null);
  return r && Array.isArray(r.items) ? r.items : [];
};

/* Забрать черновики (и заодно узнать свой токен) */
app.get("/api/inbox", auth, (req, res) => {
  res.json({ token: inboxToken(req.userId), items: readInbox(req.userId) });
});

/* Подтвердить приём: что забрали — сервер удаляет */
app.post("/api/inbox/ack", auth, (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(String) : [];
  const left = readInbox(req.userId).filter((it) => !ids.includes(it.id));
  writeJson(inboxPath(req.userId), { items: left });
  res.json({ ok: true, left: left.length });
});

/* Положить черновик по токену. Без авторизации — токен и есть пропуск.
   GET поддержан нарочно: в «Быстрых командах» это самый короткий путь. */
function pushDraft(req, res) {
  const token = String(req.params.token || "");
  if (!TOKEN_RE.test(token)) return res.status(400).json({ error: "bad token" });
  const map = readJson(TOKENS_PATH, {});
  const uid = map[token];
  if (!uid) return res.status(404).json({ error: "unknown token" });

  const b = req.body;
  /* Имя поля формы задаёт человек на телефоне и легко набирается кириллицей
     («текст» вместо `text`) — поэтому берём text/body, а если их нет, первое
     непустое строковое значение объекта. Настройка на телефоне не должна
     требовать точности. */
  const fromObject = (o) => {
    if (!o || typeof o !== "object") return "";
    if (typeof o.text === "string" && o.text.trim()) return o.text;
    if (typeof o.body === "string" && o.body.trim()) return o.body;
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) return v;
    }
    return "";
  };
  const raw =
    (req.query && req.query.text) ||
    (typeof b === "string" ? b : Buffer.isBuffer(b) ? b.toString("utf8") : fromObject(b)) ||
    "";
  const text = String(raw).replace(/\s+/g, " ").trim().slice(0, MAX_DRAFT_LEN);
  if (!text) return res.status(400).json({ error: "empty text" });

  const items = readInbox(uid);
  items.push({
    id: crypto.randomBytes(8).toString("hex"),
    text,
    at: new Date().toISOString(),
    source: String((req.query && req.query.source) || (req.body && req.body.source) || "shortcut").slice(0, 20),
  });
  writeJson(inboxPath(uid), { items: items.slice(-MAX_INBOX) });
  res.json({ ok: true, queued: Math.min(items.length, MAX_INBOX) });
}

app.post("/api/inbox/t/:token", pushDraft);
app.get("/api/inbox/t/:token", pushDraft);

/* ─────────────── ТЗ-15: живая синхронизация личных данных ───────────────
   Задача не «работать с двух экранов», а «не потерять всё при смене телефона».
   Поэтому сервер тут — тупое место встречи, а не источник правды: он хранит
   слитое состояние и отдаёт его назад. Правила слияния ровно те же, что у
   общих кошельков (ТЗ-5б/10): у каждой записи есть updatedAt, побеждает
   больший; удаление живёт надгробием, а не отсутствием записи в снимке —
   иначе устройство, которое отстало на неделю, воскресит всё удалённое.

   Полей записей сервер НЕ разбирает: данные принадлежат одному человеку,
   валидировать тут нечего, а любая «санитизация» рискует срезать поле,
   про которое сервер ещё не знает (валюты кошелька, флаги операции).
   Ограничиваем только размер и количество. */

const PERSONAL_DIR = path.join(DATA_DIR, "personal");
fs.mkdirSync(PERSONAL_DIR, { recursive: true });

const personalPath = (uid) => path.join(PERSONAL_DIR, uid + ".json");

/* Коллекции и потолки. Потолок — защита от заливки мусора, не от пользователя:
   50k операций это ~30 лет по 5 записей в день. */
const P_COLLS = {
  wallets: 200,
  categories: 500,
  txs: 50000,
  subscriptions: 500,
  drafts: 500,
  goals: 500,
};
const MAX_PTOMB = 20000;
const MAX_PERSONAL_BYTES = 4 * 1024 * 1024;

const emptyPersonal = () => ({
  wallets: [], categories: [], txs: [], subscriptions: [], drafts: [], goals: [],
  settings: { updatedAt: 0 },
  pTomb: [],
  rev: 0,
});

const pNum = (v) => Number(v) || 0;

/* Слияние одной коллекции по id: побеждает больший updatedAt. */
function mergePColl(local, incoming, max) {
  const byId = new Map();
  for (const it of local) if (it && typeof it.id === "string") byId.set(it.id, it);
  for (const it of incoming) {
    if (!it || typeof it.id !== "string" || !it.id || it.id.length > 64) continue;
    const cur = byId.get(it.id);
    if (!cur) {
      if (byId.size >= max) continue;
      byId.set(it.id, it);
    } else if (pNum(it.updatedAt) > pNum(cur.updatedAt)) {
      byId.set(it.id, it);
    }
  }
  return [...byId.values()];
}

/* Слияние надгробий: по паре coll+id, побеждает более позднее. */
function mergePTomb(local, incoming) {
  const byKey = new Map();
  const put = (t) => {
    if (!t || typeof t.id !== "string" || !t.id || !P_COLLS[t.coll]) return;
    const k = t.coll + "|" + t.id;
    const cur = byKey.get(k);
    const rec = { coll: t.coll, id: t.id, updatedAt: pNum(t.updatedAt) };
    if (!cur || rec.updatedAt > cur.updatedAt) byKey.set(k, rec);
  };
  for (const t of local) put(t);
  for (const t of incoming) put(t);
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  return [...byKey.values()].filter((t) => t.updatedAt >= cutoff).slice(-MAX_PTOMB);
}

/* Надгробие убивает запись только если запись не новее его: правка после
   удаления возвращает запись к жизни, и это правильный порядок событий. */
function applyPTomb(state) {
  for (const t of state.pTomb) {
    const coll = state[t.coll];
    if (!Array.isArray(coll)) continue;
    const i = coll.findIndex((x) => x && x.id === t.id);
    if (i >= 0 && pNum(coll[i].updatedAt) <= t.updatedAt) coll.splice(i, 1);
  }
}

/* Настройки (активный кошелёк, имя, последние подставленные значения) —
   один объект целиком, побеждает более свежий: разбирать их по полям смысла
   нет, а конфликт тут безобиден. */
function mergePSettings(local, incoming) {
  const l = local && typeof local === "object" ? local : { updatedAt: 0 };
  const r = incoming && typeof incoming === "object" ? incoming : null;
  if (!r) return l;
  return pNum(r.updatedAt) > pNum(l.updatedAt) ? r : l;
}

function mergePersonal(state, incoming) {
  for (const coll of Object.keys(P_COLLS)) {
    state[coll] = mergePColl(
      Array.isArray(state[coll]) ? state[coll] : [],
      Array.isArray(incoming[coll]) ? incoming[coll] : [],
      P_COLLS[coll]
    );
  }
  state.pTomb = mergePTomb(
    Array.isArray(state.pTomb) ? state.pTomb : [],
    Array.isArray(incoming.pTomb) ? incoming.pTomb : []
  );
  state.settings = mergePSettings(state.settings, incoming.settings);
  applyPTomb(state);
  return state;
}

const readPersonal = (uid) => {
  const r = readJson(personalPath(uid), null);
  if (!r || typeof r !== "object") return emptyPersonal();
  const base = emptyPersonal();
  for (const k of Object.keys(base)) if (r[k] !== undefined) base[k] = r[k];
  return base;
};

/* Обмен состоянием. Клиент шлёт своё, получает слитое — и применяет его
   у себя тем же кодом. Сходимость достигается за один такт в обе стороны. */
app.post("/api/personal/sync", auth, (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  let bytes = 0;
  try { bytes = Buffer.byteLength(JSON.stringify(body)); } catch { bytes = 0; }
  if (bytes > MAX_PERSONAL_BYTES) return res.status(413).json({ error: "too large" });

  const state = readPersonal(req.userId);
  const before = JSON.stringify(state);
  mergePersonal(state, body);
  const after = JSON.stringify(state);
  if (after !== before) {
    state.rev = pNum(state.rev) + 1;
    writeJson(personalPath(req.userId), state);
  }
  res.json({ ok: true, state, rev: state.rev });
});

/* Забрать состояние без отправки своего — новое устройство при подключении. */
app.get("/api/personal/sync", auth, (req, res) => {
  const state = readPersonal(req.userId);
  res.json({ ok: true, state, rev: pNum(state.rev) });
});

/* ── Смена кода восстановления ──
   Раньше код открывал только снимок; с живой синхронизацией он открывает
   актуальные данные, поэтому сменить его должно быть возможно, а утёкший —
   отозвать. Переезжает всё, что привязано к ключу: бэкап, личное состояние,
   ящик черновиков, push-подписка и членство в общих кошельках.
   Токен инбокса намеренно НЕ переезжает: смена кода — действие по безопасности,
   старый токен должен перестать работать. Новый выдаётся при первом же
   обращении к /api/inbox, Быструю команду на телефоне нужно обновить. */
app.post("/api/account/rotate", auth, (req, res) => {
  const oldKey = String(req.headers["x-finappa-key"] || "");
  const newKey = String((req.body && req.body.newKey) || "");
  if (!KEY_RE.test(newKey)) return res.status(400).json({ error: "bad new key" });
  if (newKey === oldKey) return res.status(400).json({ error: "same key" });

  const oldUid = req.userId;
  const newUid = userIdOf(newKey);
  if (fs.existsSync(keyPath(newKey)) || fs.existsSync(personalPath(newUid))) {
    return res.status(409).json({ error: "key taken" });
  }

  /* Сначала общие кошельки: операция идемпотентна, повтор безопасен. */
  const sids = Array.isArray(req.body && req.body.sids) ? req.body.sids.slice(0, 50) : [];
  let sharedMoved = 0;
  for (const sid of sids) {
    const rec = loadShared(sid);
    if (!rec || !Array.isArray(rec.members)) continue;
    const me = rec.members.find((m) => m.userId === oldUid);
    if (!me) continue;
    if (rec.members.some((m) => m.userId === newUid)) continue;
    me.userId = newUid;
    for (const t of rec.txs || []) if (t.authorId === oldUid) t.authorId = newUid;
    for (const t of rec.subs || []) if (t.authorId === oldUid) t.authorId = newUid;
    writeJson(sharedPath(sid), rec);
    sharedMoved++;
  }

  const move = (from, to) => {
    try { if (fs.existsSync(from) && !fs.existsSync(to)) { fs.renameSync(from, to); return true; } } catch {}
    return false;
  };
  const moved = {
    backup: move(keyPath(oldKey), keyPath(newKey)),
    personal: move(personalPath(oldUid), personalPath(newUid)),
    inbox: move(inboxPath(oldUid), inboxPath(newUid)),
    push: move(pushPath(oldKey), pushPath(newKey)),
    shared: sharedMoved,
  };

  /* Отзыв старого токена инбокса */
  const map = readJson(TOKENS_PATH, {});
  let dropped = 0;
  for (const t of Object.keys(map)) if (map[t] === oldUid) { delete map[t]; dropped++; }
  if (dropped) writeJson(TOKENS_PATH, map);

  res.json({ ok: true, moved, inboxTokenRevoked: dropped > 0 });
});

app.listen(PORT, () => console.log(`finappa-server on :${PORT}, data in ${DATA_DIR}`));
