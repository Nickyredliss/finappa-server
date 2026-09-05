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

app.get("/health", (_req, res) => res.json({ ok: true, service: "finappa-server", rev: "29", advisor: !!process.env.ANTHROPIC_API_KEY }));

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
/* Провайдер лежит — не долбимся в него на каждый запрос. Две попытки по 8
   секунд на каждое открытие Сводки превратили бы недоступность провайдера в
   зависающее приложение; старый курс с честной датой отдаётся мгновенно. */
let ratesFailedAt = 0;
const FAIL_COOLDOWN_MS = 5 * 60 * 1000;
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
  if (cached && Date.now() - ratesFailedAt < FAIL_COOLDOWN_MS) {
    return res.json(Object.assign({ ok: true, stale: true }, cached));
  }
  const got = await pullRatesOnce();
  if (!got) ratesFailedAt = Date.now();
  if (got) {
    ratesFailedAt = 0;
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
const writeJson = (p, obj) => { const t = p + ".tmp"; try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch {} fs.writeFileSync(t, JSON.stringify(obj)); fs.renameSync(t, p); };

/* Зарегистрировать push-подписку браузера для ключа устройства */
/* Подписок на аккаунт может быть несколько: у одного человека телефон, мак
   и рабочий браузер, а код восстановления один. Раньше поле было одно, и
   каждое новое устройство затирало предыдущее — пуши уходили в никуда.
   Старую запись читаем как список из одного элемента. */
const PUSH_MAX_DEVICES = 5;
function pushList(rec) {
  if (!rec) return [];
  const out = Array.isArray(rec.subscriptions) ? rec.subscriptions.filter((x) => x && x.endpoint) : [];
  if (rec.subscription && rec.subscription.endpoint && !out.some((x) => x.endpoint === rec.subscription.endpoint)) {
    out.unshift(rec.subscription);
  }
  return out;
}

/* Отправка всем устройствам. Возвращает, сколько доставлено и сколько
   отвалилось: молчаливая неудача — то, из-за чего человек неделю думает,
   что уведомления просто «не работают». */
async function pushAll(key, rec, payload) {
  const list = pushList(rec);
  let sent = 0;
  const dead = [];
  for (const sub of list) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload));
      sent++;
    } catch (e) {
      const code = e && e.statusCode;
      console.error("push error", code, String(sub.endpoint || "").slice(0, 40));
      if (code === 404 || code === 410) dead.push(sub.endpoint);
    }
  }
  if (dead.length) {
    rec.subscriptions = pushList(rec).filter((x) => dead.indexOf(x.endpoint) < 0);
    delete rec.subscription;
    writeJson(pushPath(key), rec);
  }
  return { sent, dead: dead.length, total: list.length };
}

app.post("/api/push/subscribe/:key", (req, res) => {
  const { key } = req.params;
  if (!KEY_RE.test(key)) return res.status(400).json({ error: "bad key" });
  const { subscription } = req.body || {};
  if (!subscription || !subscription.endpoint) return res.status(400).json({ error: "subscription required" });
  const rec = readJson(pushPath(key), {});
  /* Устройство узнаём по endpoint: повторное включение на том же телефоне
     обновляет запись, а не плодит дубли. */
  const list = pushList(rec).filter((x) => x.endpoint !== subscription.endpoint);
  list.unshift(Object.assign({}, subscription, { addedAt: Date.now() }));
  rec.subscriptions = list.slice(0, PUSH_MAX_DEVICES);
  delete rec.subscription;
  rec.updatedAt = new Date().toISOString();
  rec.notified = rec.notified || {};
  writeJson(pushPath(key), rec);
  res.json({ ok: true, devices: rec.subscriptions.length });
});

/* Тестовое уведомление — для проверки с телефона */
app.post("/api/push/test/:key", async (req, res) => {
  const { key } = req.params;
  if (!KEY_RE.test(key)) return res.status(400).json({ error: "bad key" });
  const rec = readJson(pushPath(key), null);
  const list = pushList(rec);
  if (!list.length) return res.status(404).json({ error: "no subscription" });
  if (req.body && req.body.dry) return res.json({ ok: true, dry: true, total: list.length });
  const r = await pushAll(key, rec, { title: "Finappa", body: "Уведомления работают ✓" });
  if (!r.sent) return res.status(502).json({ error: "push failed", ...r });
  res.json({ ok: true, ...r });
});

/* Состояние подписок: включены ли уведомления ИМЕННО на этом устройстве.
   Приложение раньше судило по Notification.permission, а это не то же самое:
   разрешение может быть дано, а подписка на сервере — чужая. */
app.post("/api/push/state/:key", (req, res) => {
  const { key } = req.params;
  if (!KEY_RE.test(key)) return res.status(400).json({ error: "bad key" });
  const rec = readJson(pushPath(key), null);
  const list = pushList(rec);
  const endpoint = String((req.body && req.body.endpoint) || "");
  res.json({
    ok: true,
    devices: list.length,
    here: !!endpoint && list.some((x) => x.endpoint === endpoint),
  });
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
    if (!pushList(rec).length) continue;
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
      const r = await pushAll(key, rec, {
        title: "Завтра списание",
        body: `${s.name}: ${s.amount} ${s.currency}. Открой Finappa, чтобы добавить расход.`,
      });
      if (r.sent) {
        rec.notified[s.id] = periodKey;
        changed = true;
        console.log(`push sent: ${key.slice(0, 8)}… ${s.name} → ${r.sent}/${r.total}`);
      }
      if (!pushList(rec).length) break;
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
  tasks: 5000,
  habits: 500,
  wishes: 500,
  shopping: 500,
  ideas: 2000,
};
const MAX_PTOMB = 20000;
const MAX_PERSONAL_BYTES = 4 * 1024 * 1024;

const emptyPersonal = () => ({
  wallets: [], categories: [], txs: [], subscriptions: [], drafts: [], goals: [], tasks: [], habits: [], wishes: [], shopping: [], ideas: [],
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


/* ───────────────── ТЗ-21: напоминание о неразобранных черновиках ─────────────────
   Nicky: «забываю зайти и проверить черновики, а когда захожу — не знаю, за что
   был перевод». Вторая жалоба на самом деле про время: банк получателя не
   называет вовсе, и вспомнить можно только пока свежо. Значит лечение — не
   подсказка задним числом, а частое напоминание с суммой.

   Черновик живёт в двух местах, и считаются оба:
   - в инбоксе, если приложение не открывали с момента прихода сообщения (это и
     есть основной случай «забыл зайти»);
   - в личном снимке, если приложение открывали, а черновик не разобрали.

   Ночью молчим, и через сутки безуспешных напоминаний частота падает до раза в
   день: забытый на выходные черновик не должен превратиться в полсотни пушей. */

const DRAFT_QUIET_FROM = 23;    // с 23:00 по Бангкоку тихо
const DRAFT_QUIET_TO = 8;       // до 8:00
const DRAFT_HOURLY_LIMIT = 12;  // после стольких напоминаний — раз в сутки
const DRAFT_MIN_GAP_MS = 55 * 60 * 1000;  // «раз в час» с запасом на дрожь таймера
const DAY_MS = 24 * 3600 * 1000;

/* Сумма для текста уведомления — и только для него. Настоящий разбор живёт в
   клиенте и остаётся единственным источником правды; ошибка здесь ничего не
   портит, потому что запись всё равно создаётся руками на открытом экране.
   Поэтому тут не второй парсер, а нюхач: число рядом со словом валюты. */
function sniffAmount(text) {
  const s = String(text || "").replace(/\s+/g, " ");
  let m = s.match(/\b(?:amount|Purchase)\s+([0-9][0-9,]*(?:\.[0-9]+)?)\s*(?:Baht|THB|B\.)/i);
  if (!m) m = s.match(/([0-9][0-9,]*(?:\.[0-9]+)?)\s*(?:Baht|THB|бат)/i);
  if (!m) return "";
  const n = Number(String(m[1]).replace(/,/g, ""));
  if (!isFinite(n) || n <= 0) return "";
  return n.toLocaleString("ru-RU", { maximumFractionDigits: 2 }) + " THB";
}

function draftMessage(texts) {
  const sums = texts.map(sniffAmount).filter(Boolean);
  if (texts.length === 1) {
    return {
      title: "📥 Черновик ждёт",
      body: (sums[0] ? sums[0] + " — р" : "Р") + "азберите, пока помните, за что это было",
    };
  }
  const head = sums.slice(0, 3).join(" · ");
  return {
    title: `📥 Черновиков: ${texts.length}`,
    body: head ? head + (sums.length > 3 ? " и другие" : "") : "Откройте Finappa, чтобы разобрать",
  };
}

/* force — не смотреть на ночь и на паузу между напоминаниями;
   dry — ничего не слать и ничего не записывать, только показать план.
   Оба нужны для проверки: без них поведение можно увидеть только подождав час. */
async function remindDrafts(opts) {
  const o = opts || {};
  const only = o.onlyUid || null;
  const { hour } = bangkokNow();
  const quiet = hour >= DRAFT_QUIET_FROM || hour < DRAFT_QUIET_TO;
  const report = { hour, quiet, planned: [] };
  if (quiet && !o.force) return report;

  const files = fs.readdirSync(PUSH_DIR).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    const key = f.replace(/\.json$/, "");
    const rec = readJson(pushPath(key), null);
    if (!pushList(rec).length) continue;

    const uid = userIdOf(key);
    if (only && uid !== only) continue;
    const personal = readJson(personalPath(uid), null);
    const kept = personal && Array.isArray(personal.drafts) ? personal.drafts : [];
    const texts = readInbox(uid).map((i) => i && i.text)
      .concat(kept.map((d) => d && d.text))
      .filter(Boolean);

    const st = rec.draftReminder || {};
    if (!texts.length) {
      /* Разобрал — счётчик обнуляется, следующий черновик начнёт с нуля. */
      if (!o.dry && st.count) { rec.draftReminder = {}; writeJson(pushPath(key), rec); }
      continue;
    }

    const now = Date.now();
    const gap = (st.count || 0) >= DRAFT_HOURLY_LIMIT ? DAY_MS : DRAFT_MIN_GAP_MS;
    if (!o.force && st.lastAt && now - st.lastAt < gap) continue;

    const msg = draftMessage(texts);
    report.planned.push({ key: key.slice(0, 6), n: texts.length, title: msg.title, body: msg.body });
    if (o.dry) continue;

    try {
      await webpush.sendNotification(rec.subscription, JSON.stringify(msg));
      rec.draftReminder = { count: (st.count || 0) + 1, lastAt: now };
      writeJson(pushPath(key), rec);
      console.log(`draft push: ${key.slice(0, 8)}… n=${texts.length}`);
    } catch (e) {
      console.error("draft push error", e && e.statusCode);
      if (e && (e.statusCode === 404 || e.statusCode === 410)) {
        delete rec.subscription;
        writeJson(pushPath(key), rec);
      }
    }
  }
  return report;
}

setInterval(() => remindDrafts().catch(() => {}), 60 * 60 * 1000);

/* Ручной прогон — им же проверяется поведение в тестах. */
app.post("/api/push/drafts-check", auth, async (req, res) => {
  const b = req.body || {};
  res.json(await remindDrafts({ force: !!b.force, dry: !!b.dry, onlyUid: req.userId }));
});


/* ───────────────── ТЗ-24: напоминания о делах ─────────────────
   Реже, чем о черновиках, и это принципиально. Черновик можно напоминать
   каждый час, потому что его разбор занимает секунду. Дело так не работает:
   частые напоминания о том, что человек и так знает, кончаются выключенными
   уведомлениями — и тогда молчать будет всё, включая нужное.

   Сегодняшнее дело со временем — в ближайший тик после этого времени.
   Сегодняшнее без времени — утром. Просроченное — раз в сутки, утром. */

const TASK_MORNING = 9;              // час утреннего напоминания
const TASK_OVERDUE_GAP_MS = 20 * 3600 * 1000;  // «раз в сутки» с запасом на дрожь

const bkkIso = () => {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
};

function taskPlan(tasks, hour, today, state) {
  const live = (Array.isArray(tasks) ? tasks : []).filter((t) => t && t.id && t.text && !t.doneAt);
  const overdue = live.filter((t) => t.due && t.due < today);
  const now = live.filter((t) => t.due === today);

  /* Дела на сегодня: со временем — когда время настало, без времени — утром. */
  const due = now.filter((t) => {
    if (!t.dueTime) return hour >= TASK_MORNING;
    const h = Number(String(t.dueTime).slice(0, 2));
    return isFinite(h) && hour >= h;
  });

  const out = [];
  for (const t of due) {
    if ((state.notified || {})[t.id] === today) continue;
    out.push({ kind: "due", id: t.id, title: "☑️ Сегодня", body: t.text });
  }
  if (overdue.length && hour >= TASK_MORNING) {
    const last = Number(state.overdueAt) || 0;
    if (Date.now() - last >= TASK_OVERDUE_GAP_MS) {
      out.push({
        kind: "overdue",
        id: null,
        title: overdue.length === 1 ? "⚠️ Просрочено" : `⚠️ Просрочено: ${overdue.length}`,
        body: overdue.length === 1 ? overdue[0].text : overdue.slice(0, 3).map((t) => t.text).join(" · "),
      });
    }
  }
  return out;
}

/* ТЗ-39: оценка длительности дела по формулировке. Это ДОСЛОВНАЯ копия
   клиентской zSpeed — в тестах обе стороны прогоняются одной таблицей
   примеров, чтобы копия не разошлась молча. */
const SPEED_FAST = ["позвонить", "написать", "отправить", "оплатить", "заплатить", "перевести", "купить", "заказать", "забрать", "отнести", "отдать", "вынести", "полить", "помыть", "отмыть", "вымыть", "почистить", "постирать", "выкинуть", "выбросить", "убрать", "записаться", "спросить", "уточнить", "подтвердить", "продлить", "распечатать", "скинуть", "переслать", "зарядить", "проверить"];
const SPEED_SLOW = ["найти", "искать", "поискать", "выбрать", "изучить", "разобраться", "прочитать", "посмотреть", "смотреть", "придумать", "продумать", "спланировать", "сделать", "создать", "запустить", "настроить", "собрать", "написать статью", "разработать", "оформить", "перевезти", "переехать", "починить", "отремонтировать", "курс", "видео", "тест", "экзамен", "сайт"];
const SPEED_BOUND = "[^\\p{L}\\p{N}]";
const speedRe = (w) => new RegExp("(?:^|" + SPEED_BOUND + ")(?:" + w + ")(?:" + SPEED_BOUND + "|$)", "iu");
function taskSpeed(t) {
  if (!t) return 2;
  if (t.slow) return 3;
  if (t.fast) return 1;
  const low = String(t.text || "").toLowerCase();
  const words = low.split(/[^\p{L}\p{N}]+/u).filter(Boolean).length;
  if (SPEED_SLOW.some((w) => speedRe(w).test(low))) return 3;
  if (SPEED_FAST.some((w) => speedRe(w).test(low)) && words <= 6) return 1;
  if (words <= 3) return 1;
  if (words >= 8) return 3;
  return 2;
}

/* Одно быстрое дело раз в день — ответ на «теряюсь, когда не понимаю, что
   сейчас сделать». Не список: список это снова выбор. */
const NOW_HOUR = Number(process.env.NOW_HOUR) || 15;
async function remindNow(opts) {
  const o = opts || {};
  const only = o.onlyUid || null;
  const { hour } = bangkokNow();
  const report = { hour, planned: [] };
  if (!o.force && hour !== NOW_HOUR) return report;
  const today = bkkIso();
  const files = fs.readdirSync(PUSH_DIR).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    const key = f.replace(/\.json$/, "");
    const rec = readJson(pushPath(key), null);
    if (!pushList(rec).length) continue;
    const uid = userIdOf(key);
    if (only && uid !== only) continue;
    const personal = readJson(personalPath(uid), null);
    const tasks = (personal && Array.isArray(personal.tasks) ? personal.tasks : []).filter((t) => t && t.id && t.text && !t.doneAt);
    if (!tasks.length) continue;
    const st = rec.nowReminder || {};
    if (!o.force && st.day === today) continue;
    const best = tasks
      .map((t) => ({ t, s: taskSpeed(t) }))
      .sort((a, b) => a.s - b.s || pNum(a.t.createdAt) - pNum(b.t.createdAt))[0];
    const title = best.s === 1 ? "⚡ Быстрое дело" : "🕐 Одно дело";
    report.planned.push({ key: key.slice(0, 6), speed: best.s, title, body: best.t.text });
    if (o.dry) continue;
    const r = await pushAll(key, rec, { title, body: best.t.text, section: "now" });
    if (r.sent) {
      rec.nowReminder = { day: today, at: Date.now() };
      writeJson(pushPath(key), rec);
    }
  }
  return report;
}

setInterval(() => remindNow().catch(() => {}), 60 * 60 * 1000);

app.post("/api/push/now-check", auth, async (req, res) => {
  const b = req.body || {};
  res.json(await remindNow({ force: !!b.force, dry: !!b.dry, onlyUid: req.userId }));
});

async function remindTasks(opts) {
  const o = opts || {};
  const only = o.onlyUid || null;
  const { hour } = bangkokNow();
  const quiet = hour >= DRAFT_QUIET_FROM || hour < DRAFT_QUIET_TO;
  const report = { hour, quiet, planned: [] };
  if (quiet && !o.force) return report;

  const today = bkkIso();
  const files = fs.readdirSync(PUSH_DIR).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    const key = f.replace(/\.json$/, "");
    const rec = readJson(pushPath(key), null);
    if (!pushList(rec).length) continue;

    const uid = userIdOf(key);
    if (only && uid !== only) continue;
    const personal = readJson(personalPath(uid), null);
    const tasks = personal && Array.isArray(personal.tasks) ? personal.tasks : [];
    if (!tasks.length) continue;

    const state = rec.taskReminder || {};
    const plan = taskPlan(tasks, o.force ? 23 : hour, today, o.force ? {} : state);
    for (const p of plan) {
      report.planned.push({ key: key.slice(0, 6), kind: p.kind, title: p.title, body: p.body });
      if (o.dry) continue;
      const r = await pushAll(key, rec, { title: p.title, body: p.body, section: "tasks" });
      if (r.sent) {
        const st = rec.taskReminder || (rec.taskReminder = {});
        if (p.kind === "overdue") st.overdueAt = Date.now();
        else {
          st.notified = st.notified || {};
          st.notified[p.id] = today;
        }
        writeJson(pushPath(key), rec);
      }
      if (!pushList(rec).length) break;
    }
    /* Отметки о вчерашних делах не копим: словарь должен оставаться маленьким. */
    if (!o.dry && rec.taskReminder && rec.taskReminder.notified) {
      const n = rec.taskReminder.notified;
      for (const id of Object.keys(n)) if (n[id] !== today) delete n[id];
    }
  }
  return report;
}

setInterval(() => remindTasks().catch(() => {}), 60 * 60 * 1000);

/* ==================== ТЗ-29: советник ====================

   Ключ берётся ТОЛЬКО из окружения и никогда не покидает сервер.
   ANTHROPIC_BASE_URL существует ради тестов: суита поднимает локальную
   заглушку и подставляет её адрес, поэтому проверять логику можно без
   единого платного запроса и без ключа в репозитории. */

const ADVISOR_MODEL = process.env.ADVISOR_MODEL || "claude-sonnet-5";
const ADVISOR_BASE = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
const ADVISOR_DAY_LIMIT = Number(process.env.ADVISOR_DAY_LIMIT) || 40;
const ADVISOR_MAX_Q = 2000;
const ADVISOR_MAX_TURNS = 12;
/* Каждый круг — отдельный платный запрос. Три хватает на «поискал → уточнил
   → ответил»; больше означало бы, что советник заблудился, и платить за это
   молча не надо. */
const ADVISOR_MAX_ROUNDS = 3;
/* Стена карточек — это не помощь, а работа для человека. */
const ADVISOR_MAX_PROPOSALS = 3;

const ADVISOR_DIR = path.join(DATA_DIR, "advisor");
fs.mkdirSync(ADVISOR_DIR, { recursive: true });
const advisorPath = (uid) => path.join(ADVISOR_DIR, uid + ".json");

/* Суточный счётчик: день считаем по Бангкоку, как все напоминания. */
function advisorTake(uid) {
  const day = bkkIso();
  const rec = readJson(advisorPath(uid), {});
  if (rec.day !== day) { rec.day = day; rec.used = 0; }
  if (pNum(rec.used) >= ADVISOR_DAY_LIMIT) return { ok: false, used: pNum(rec.used), limit: ADVISOR_DAY_LIMIT };
  rec.used = pNum(rec.used) + 1;
  writeJson(advisorPath(uid), rec);
  return { ok: true, used: rec.used, limit: ADVISOR_DAY_LIMIT };
}

const advNum = (v) => Math.round((Number(v) || 0) * 100) / 100;
const advDay = (ts) => {
  const d = new Date(Number(ts) || 0);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/* Дайджест — не сырые данные, а выжимка.
   Слать 215 операций построчно значит платить за шум: модель всё равно
   считает по агрегатам. Поэтому категории и итоги считаем здесь, а
   построчно даём только последние операции — для «что это было». */
function advisorDigest(uid) {
  const p = readJson(personalPath(uid), null);
  if (!p) return null;
  const today = bkkIso();
  const month = today.slice(0, 7);
  const prevMonth = (() => {
    const d = new Date(today + "T00:00:00Z");
    d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1);
    return d.toISOString().slice(0, 7);
  })();
  const cats = Object.fromEntries((p.categories || []).map((c) => [c.id, c]));
  const wallets = (p.wallets || []).filter((w) => w && !w.sharedId);
  const wById = Object.fromEntries(wallets.map((w) => [w.id, w]));

  const bal = {};
  const catMonth = {};
  const catPrev = {};
  const totals = { month: {}, prev: {} };
  for (const t of p.txs || []) {
    if (!t || t.shared) continue;
    if (t.type === "transfer") continue; /* переводы учитываются отдельным проходом ниже */
    const w = wById[t.walletId];
    if (!w) continue;
    const inMonth = String(t.date || "").startsWith(month);
    const inPrev = String(t.date || "").startsWith(prevMonth);
    if (t.type === "expense" && (inMonth || inPrev)) {
      const c = cats[t.categoryId];
      const name = c ? c.name : t.catName || "Прочее";
      const box = inMonth ? catMonth : catPrev;
      const k = name + " · " + t.currency;
      box[k] = advNum((box[k] || 0) + (Number(t.amount) || 0));
    }
    if (inMonth || inPrev) {
      const box = inMonth ? totals.month : totals.prev;
      const k = t.currency;
      box[k] = box[k] || { income: 0, expense: 0 };
      box[k][t.type] = advNum(box[k][t.type] + (Number(t.amount) || 0));
    }
  }

  /* Балансы: полный проход, включая переводы — иначе цифра соврёт. */
  for (const w of wallets) bal[w.id] = {};
  for (const t of p.txs || []) {
    if (!t) continue;
    if (t.type === "transfer") {
      if (bal[t.fromWalletId]) bal[t.fromWalletId][t.fromCurrency] = advNum((bal[t.fromWalletId][t.fromCurrency] || 0) - (Number(t.fromAmount) || 0));
      if (bal[t.toWalletId]) bal[t.toWalletId][t.toCurrency] = advNum((bal[t.toWalletId][t.toCurrency] || 0) + (Number(t.toAmount) || 0));
      continue;
    }
    if (!bal[t.walletId]) continue;
    const sign = t.type === "income" ? 1 : -1;
    bal[t.walletId][t.currency] = advNum((bal[t.walletId][t.currency] || 0) + sign * (Number(t.amount) || 0));
  }

  /* Обмены не расходы, поэтому в итогах их нет — но человек про них
     спрашивает, и до ТЗ-33 они были не видны советнику вообще. */
  const monthTransfers = (p.txs || [])
    .filter((t) => t && !t.shared && t.type === "transfer" && String(t.date || "").startsWith(month))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));

  const recent = (p.txs || [])
    .filter((t) => t && t.type !== "transfer")
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || pNum(b.createdAt) - pNum(a.createdAt))
    .slice(0, 25)
    .map((t) => ({
      д: t.date,
      тип: t.type === "income" ? "доход" : "расход",
      сумма: advNum(t.amount),
      вал: t.currency,
      кат: (cats[t.categoryId] || {}).name || t.catName || "Прочее",
      кошелёк: (wById[t.walletId] || {}).name || "",
      комм: String(t.comment || "").slice(0, 60),
    }));

  const openTasks = (p.tasks || []).filter((t) => t && !t.doneAt).map((t) => ({
    дело: String(t.text || "").slice(0, 120),
    срок: t.due || (t.soon ? "на днях" : "когда-нибудь"),
  }));

  const doneRecent = (p.tasks || [])
    .filter((t) => t && t.doneAt)
    .sort((a, b) => pNum(b.doneAt) - pNum(a.doneAt))
    .slice(0, 60)
    .map((t) => ({ д: advDay(t.doneAt), дело: String(t.text || "").slice(0, 120) }));

  const habits = (p.habits || []).filter((h) => h && !h.archived).map((h) => {
    const dd = new Set(h.doneDates || []);
    let streak = 0;
    const d = new Date(today + "T00:00:00Z");
    if (!dd.has(today)) d.setUTCDate(d.getUTCDate() - 1);
    while (dd.has(d.toISOString().slice(0, 10))) { streak++; d.setUTCDate(d.getUTCDate() - 1); }
    const last30 = (h.doneDates || []).filter((x) => {
      const t0 = new Date(today + "T00:00:00Z").getTime();
      const t1 = new Date(x + "T00:00:00Z").getTime();
      return t0 - t1 < 30 * 864e5 && t1 <= t0;
    }).length;
    return { практика: h.name, сегодня: dd.has(today), серия: streak, за30дней: last30 };
  });

  const goals = (p.goals || []).filter((g) => g && !g.closedAt).map((g) => ({
    цель: g.name, нужно: advNum(g.target), отложено: advNum(g.saved), вал: g.currency, срок: g.deadline || null,
  }));

  const subs = (p.subscriptions || []).map((x) => ({
    подписка: x.name, сумма: advNum(x.amount), вал: x.currency, день: x.day, период: x.periodicity || "monthly",
  }));

  return {
    сегодня: today,
    кошельки: wallets.map((w) => ({ имя: w.name, балансы: bal[w.id] || {} })),
    итогМесяца: totals.month,
    итогПрошлогоМесяца: totals.prev,
    категорииЭтогоМесяца: catMonth,
    категорииПрошлогоМесяца: catPrev,
    последниеОперации: recent,
    открытыеДела: openTasks,
    закрытыеДелаНедавно: doneRecent,
    практики: habits,
    цели: goals,
    подписки: subs,
    обменыИПереводыЭтогоМесяца: monthTransfers.slice(0, 20).map((t) => advTransferRow(t, wById)),
    итогоПоОбменамЭтогоМесяца: advTransferTotals(monthTransfers),
    идеи: (p.ideas || []).slice(-60).map((x) => String((x && x.text) || "").slice(0, 200)),
    списокПокупок: (p.shopping || []).filter((x) => x && !x.doneAt).slice(0, 60).map((x) => String(x.text || "").slice(0, 80)),
    купленоНедавно: (p.shopping || []).filter((x) => x && x.doneAt).length,
    черновиковЖдёт: (p.drafts || []).length,
    пожелания: (p.wishes || []).map((w) => ({
      что: String((w && w.text) || "").slice(0, 200),
      отправлено: advDay(w && w.at),
      сделано: !!(w && w.doneAt),
    })),
  };
}

/* Обмен и перевод — одна сущность (type: "transfer"), но человеку это две
   разные вещи: обмен валюты ВНУТРИ кошелька и перевод МЕЖДУ кошельками.
   Различаем по кошелькам и называем словами, иначе модель будет гадать. */
function advTransferRow(t, wl) {
  const same = t.fromWalletId === t.toWalletId;
  const fa = advNum(t.fromAmount);
  const ta = advNum(t.toAmount);
  const row = {
    дата: t.date,
    тип: same ? "обмен" : "перевод",
    отдал: fa + " " + t.fromCurrency,
    получил: ta + " " + t.toCurrency,
    комментарий: String(t.comment || "").slice(0, 80),
  };
  if (t.fromCurrency !== t.toCurrency && fa > 0) row.курс = advNum(ta / fa);
  if (same) row.кошелёк = String((wl[t.fromWalletId] || {}).name || "");
  else {
    row.изКошелька = String((wl[t.fromWalletId] || {}).name || "");
    row.вКошелёк = String((wl[t.toWalletId] || {}).name || "");
  }
  return row;
}

/* Итоги по обменам считаем здесь же: складывать десять строк — ровно то, на
   чём языковая модель ошибается правдоподобно. */
function advTransferTotals(list) {
  const out = {};
  for (const t of list) {
    const k = t.fromCurrency + "→" + t.toCurrency;
    const b = (out[k] = out[k] || { сколькоРаз: 0, отдано: 0, получено: 0 });
    b.сколькоРаз++;
    b.отдано = advNum(b.отдано + (Number(t.fromAmount) || 0));
    b.получено = advNum(b.получено + (Number(t.toAmount) || 0));
  }
  for (const k of Object.keys(out)) {
    const b = out[k];
    if (b.отдано > 0) b.среднийКурс = advNum(b.получено / b.отдано);
  }
  return out;
}

/* Поиск по операциям. Всё считается здесь: модели отдаём только найденное,
   иначе смысл выжимки теряется и мы снова платим за шум. */
function advisorFindTx(uid, args) {
  const p = readJson(personalPath(uid), null);
  if (!p) return { найдено: 0, операции: [] };
  const a = args || {};
  const cats = Object.fromEntries((p.categories || []).map((c) => [c.id, c]));
  const wl = Object.fromEntries((p.wallets || []).map((w) => [w.id, w]));
  const q = String(a.текст || a.text || "").trim().toLowerCase();
  const cat = String(a.категория || a.category || "").trim().toLowerCase();
  const from = String(a.с || a.from || "");
  const to = String(a.по || a.to || "");
  const sumRaw = a.amount !== undefined ? a.amount : a.сумма;
  const sum = sumRaw === undefined || sumRaw === null || sumRaw === "" ? null : Number(sumRaw);
  const type = String(a.тип || a.type || "").trim();
  const wal = String(a.кошелёк || a.wallet || "").trim().toLowerCase();
  const limit = Math.min(60, Math.max(1, Number(a.сколько || a.limit) || 40));
  const inWallet = (id) => !wal || String((wl[id] || {}).name || "").toLowerCase().indexOf(wal) >= 0;

  const out = [];
  const trans = [];
  for (const t of p.txs || []) {
    if (!t || t.shared) continue;
    if (t.type === "transfer") {
      /* Обмен не расход и не доход: под фильтр по категории он не подходит по
         смыслу, поэтому при поиске по категории его не показываем вовсе. */
      if (type && type !== "transfer") continue;
      if (cat) continue;
      if (from && String(t.date || "") < from) continue;
      if (to && String(t.date || "") > to) continue;
      if (!inWallet(t.fromWalletId) && !inWallet(t.toWalletId)) continue;
      if (sum !== null && Math.abs((Number(t.fromAmount) || 0) - sum) > 0.009 && Math.abs((Number(t.toAmount) || 0) - sum) > 0.009) continue;
      if (q) {
        const hay = (String(t.comment || "") + " " + String((wl[t.fromWalletId] || {}).name || "") + " " + String((wl[t.toWalletId] || {}).name || "") + " обмен перевод").toLowerCase();
        if (hay.indexOf(q) < 0) continue;
      }
      trans.push(t);
      out.push(advTransferRow(t, wl));
      continue;
    }
    if (type === "transfer") continue;
    if (!inWallet(t.walletId)) continue;
    const catName = String((cats[t.categoryId] || {}).name || t.catName || "Прочее");
    const cm = String(t.comment || "");
    if (from && String(t.date || "") < from) continue;
    if (to && String(t.date || "") > to) continue;
    if (type && t.type !== type) continue;
    if (cat && catName.toLowerCase().indexOf(cat) < 0) continue;
    if (sum !== null && Math.abs((Number(t.amount) || 0) - sum) > 0.009) continue;
    if (q && (catName + " " + cm).toLowerCase().indexOf(q) < 0) continue;
    out.push({
      дата: t.date,
      тип: t.type === "income" ? "доход" : "расход",
      сумма: advNum(t.amount),
      валюта: t.currency,
      категория: catName,
      комментарий: cm.slice(0, 80),
      кошелёк: String((wl[t.walletId] || {}).name || ""),
    });
  }
  out.sort((x, y) => String(y.дата).localeCompare(String(x.дата)));
  const total = out.length;
  const rows = out.slice(0, limit);
  const sums = {};
  for (const r of out) {
    if (r.тип !== "расход") continue; /* иначе у обмена нет .валюта и в итог лезет ключ undefined */
    sums[r.валюта] = advNum((sums[r.валюта] || 0) + r.сумма);
  }
  const res = { найдено: total, показано: rows.length, суммаРасходовПоВалютам: sums, операции: rows };
  if (trans.length) res.итогоПоОбменам = advTransferTotals(trans);
  return res;
}

/* Предложение записи. Здесь НИЧЕГО не создаётся и не сохраняется: мы лишь
   сверяем предложение с настоящим снимком (кошелёк, валюта, категория,
   практика, дубли) и возвращаем его — карточку подтверждает человек.
   Отказ возвращается модели текстом, чтобы она исправилась сама, а не
   сообщила Nicky выдуманный успех. */
function advPropose(uid, args) {
  const p = readJson(personalPath(uid), null);
  if (!p) return { ok: false, ошибка: "данные не найдены" };
  const a = args || {};
  const kind = String(a.kind || "").trim();
  const title = String(a.title || "").trim().slice(0, 200);
  const note = String(a.note || "").trim().slice(0, 200);
  const low = (v) => String(v || "").trim().toLowerCase();
  const pick = (list, name, field) => {
    const q = low(name);
    if (!q) return null;
    return list.find((x) => low(x[field]) === q) || list.find((x) => low(x[field]).indexOf(q) >= 0) || null;
  };
  if (!title) return { ok: false, ошибка: "нужно название" };

  if (kind === "task") {
    const due = String(a.due || "").trim();
    if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return { ok: false, ошибка: "срок пиши как ГГГГ-ММ-ДД" };
    const same = (p.tasks || []).find((t) => t && !t.doneAt && low(t.text) === low(title));
    if (same) return { ok: false, ошибка: "такое дело уже есть в списке — второе заводить не надо" };
    return { ok: true, предложение: { kind: "task", title, due: due || null, soon: !!a.soon, note } };
  }

  if (kind === "shopping_item") {
    const same = (p.shopping || []).find((x) => x && !x.doneAt && low(x.text) === low(title));
    if (same) return { ok: false, ошибка: "это уже есть в списке покупок" };
    return { ok: true, предложение: { kind: "shopping_item", title, note } };
  }

  if (kind === "habit_mark") {
    const hs = (p.habits || []).filter((h) => h && !h.archived);
    const h = pick(hs, title, "name");
    if (!h) return { ok: false, ошибка: "такой практики нет", практики: hs.map((x) => x.name) };
    const today = bkkIso();
    if ((h.doneDates || []).indexOf(today) >= 0) return { ok: false, ошибка: "эта практика уже отмечена сегодня" };
    return { ok: true, предложение: { kind: "habit_mark", title: h.name, note } };
  }

  if (kind === "subscription") {
    const wallets = (p.wallets || []).filter((w) => w && !w.sharedId);
    if (!wallets.length) return { ok: false, ошибка: "нет ни одного личного кошелька" };
    const w = a.wallet ? pick(wallets, a.wallet, "name") : wallets[0];
    if (!w) return { ok: false, ошибка: "такого кошелька нет", кошельки: wallets.map((x) => x.name) };
    const amount = Number(a.amount);
    if (!(amount > 0)) return { ok: false, ошибка: "нужна сумма больше нуля" };
    const curs = Array.isArray(w.currencies) && w.currencies.length ? w.currencies : ["THB"];
    const cur = String(a.currency || "").trim().toUpperCase() || curs[0];
    if (curs.indexOf(cur) < 0) return { ok: false, ошибка: "в кошельке «" + w.name + "» нет валюты " + cur, валюты: curs };
    const day = Math.round(Number(a.day));
    if (!(day >= 1 && day <= 31)) return { ok: false, ошибка: "день списания — число от 1 до 31" };
    const period = a.period === "yearly" ? "yearly" : "monthly";
    const month = period === "yearly" ? Math.min(12, Math.max(1, Math.round(Number(a.month) || 1))) : null;
    const c = a.category ? pick(p.categories || [], a.category, "name") : null;
    if (a.category && !c) return { ok: false, ошибка: "такой категории нет", категории: (p.categories || []).map((x) => x.name) };
    const dup = (p.subscriptions || []).find((x) => x && low(x.name) === low(title));
    if (dup) return { ok: false, ошибка: "такая подписка уже есть: " + dup.name + ", " + advNum(dup.amount) + " " + dup.currency + ", " + dup.day + "-го" };
    const paid = String(a.paid_on || "").trim();
    if (paid && !/^\d{4}-\d{2}-\d{2}$/.test(paid)) return { ok: false, ошибка: "paid_on пиши как ГГГГ-ММ-ДД" };
    return {
      ok: true,
      предложение: { kind: "subscription", title, amount: advNum(amount), currency: cur, wallet: w.name,
        category: c ? c.name : null, day, period, month, paidOn: paid || null, note },
    };
  }
  return { ok: false, ошибка: "неизвестный вид записи" };
}

const ADVISOR_TOOLS = [
  {
    name: "find_transactions",
    description:
      "Найти операции пользователя по любым признакам: расходы, доходы, а также обмены валюты и переводы между кошельками (type=transfer). Используй ВСЕГДА, когда нужна конкретная запись, её дата или сумма: в готовой выжимке лежат только последние 25 операций и обмены текущего месяца, а всего операций могут быть сотни. Возвращает найденное с датами, суммами, категориями, кошельками, а для обменов — курс и итоги по парам валют.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Искать в названии категории и в комментарии, например «зал», «абонемент», «Лазада»." },
        category: { type: "string", description: "Название категории целиком или частью, например «спорт»." },
        amount: { type: "number", description: "Точная сумма операции." },
        type: { type: "string", enum: ["expense", "income", "transfer"], description: "Только расходы, только доходы или только обмены и переводы (transfer)." },
        wallet: { type: "string", description: "Имя кошелька целиком или частью, например «Личный» или «Агасси». Без него ищем по всем." },
        from: { type: "string", description: "Дата начала периода, ГГГГ-ММ-ДД." },
        to: { type: "string", description: "Дата конца периода, ГГГГ-ММ-ДД." },
        limit: { type: "number", description: "Сколько операций вернуть, по умолчанию 40, максимум 60." },
      },
    },
  },
  {
    name: "propose_record",
    description:
      "Предложить Nicky создать запись: подписку, дело или отметку сегодняшней практики. Ты НЕ создаёшь запись — предложение появляется у него карточкой с кнопкой, нажимает он сам. Ответ инструмента скажет, принято предложение или отклонено (например, такая подписка уже есть); опирайся в тексте на этот ответ и НИКОГДА не пиши, что запись создана, добавлена или отмечена.",
    input_schema: {
      type: "object",
      required: ["kind", "title"],
      properties: {
        kind: { type: "string", enum: ["subscription", "task", "habit_mark", "shopping_item"], description: "Что предложить: subscription — регулярный платёж, task — дело, habit_mark — отметить сегодняшнюю практику, shopping_item — строку в список покупок." },
        title: { type: "string", description: "Название подписки, текст дела, название практики (точно как в ежедневнике) или что купить." },
        amount: { type: "number", description: "Только для подписки: сумма списания." },
        currency: { type: "string", description: "Только для подписки: валюта, например THB. Должна быть в этом кошельке." },
        wallet: { type: "string", description: "Только для подписки: имя кошелька. Без него берётся первый личный." },
        category: { type: "string", description: "Только для подписки: имя существующей категории." },
        day: { type: "number", description: "Только для подписки: день списания, 1–31." },
        period: { type: "string", enum: ["monthly", "yearly"], description: "Только для подписки: раз в месяц или раз в год. По умолчанию monthly." },
        month: { type: "number", description: "Только для годовой подписки: месяц списания, 1–12." },
        paid_on: { type: "string", description: "Только для подписки: дата уже записанного расхода за текущий период, ГГГГ-ММ-ДД. Передавай ВСЕГДА, когда подписка делается из найденной операции, — иначе приложение предложит записать этот же платёж второй раз." },
        due: { type: "string", description: "Только для дела: срок, ГГГГ-ММ-ДД." },
        soon: { type: "boolean", description: "Только для дела без срока: пометить «в ближайшее время»." },
        note: { type: "string", description: "Одна короткая строка на карточке — почему ты это предлагаешь." },
      },
    },
  },
];

/* Карта приложения. Половина «не могу» у советника была не про данные, а про
   незнание того, что нужная кнопка уже существует. */
const ADVISOR_APP = [
  "Что умеет само приложение (предлагай готовый путь ПРЕЖДЕ чем оформлять ТЗ):",
  "• Разделы в шапке: «💳 Деньги», «✅ Дела», «🧠 Советник».",
  "• Деньги — вкладки внизу: Кошелёк, История, Сводка, Ещё.",
    "  – Кошелёк: балансы, «− Расход» и «+ Доход» (сохраняет касание категории), «⇄ Перевод», блок подписок и целей.",
  "  – Один расход можно разделить между двумя кошельками прямо в форме: «✂️ Разделить между кошельками», указать вторую часть — приложение создаст две записи с одной датой и общим комментарием. Так же делится и уже записанная операция, если открыть её в Истории.",
  "  – «⇄ Перевод» — это и перевод между кошельками, и обмен валюты внутри одного кошелька (USD→THB): указываются отданная и полученная суммы, курс считается из них. В расходы и доходы такие операции не входят никогда.",
  "  – История: режимы День/Неделя/Месяц/Период (произвольные даты), поиск по комментарию и категории.",
  "  – Сводка: Месяц или Период, итоги в одной валюте по курсу, разбивка по категориям, «Сколько уходит в месяц».",
  "  – Ещё: подписки, оформление (светлая/тёмная), бэкап и код восстановления, автозапись (инбокс).",
  "• Подписка из уже записанного расхода: руками это «открыть запись в Истории → 🔁 Сделать подпиской», но быстрее предложить её самому — propose_record с kind=subscription и обязательно paid_on = дата той операции, чтобы этот месяц не посчитался дважды.",
  "• Дела — вкладки: Дела, Покупки, Ежедневник, Журнал.",
  "  – Дела: срок можно писать прямо во фразе («позвонить в банк завтра», «оплатить визу 12 сентября», «купить масло на днях»). Кнопка ☀️ ставит дело в план на сегодня, ↩ возвращает обратно.",
  "  – Ежедневник: ежедневные практики, отметка касанием, серия дней.",
    "  – Журнал: что и когда было сделано, по дням.",
    "  – Идеи: мысли по поводу чего-нибудь. Это НЕ дела: их не делают, их перечитывают. Если мысль дозрела до действия, у неё есть кнопка «→ в дела».",
  "  – «⚡ Что сделать сейчас» на экране дел: показывает по одному делу от быстрых к долгим, чтобы не выбирать. Кнопки: «Сделал», «Не сейчас», «Это долгое».",
  "  – Покупки: список того, что нужно купить; в магазине строка вычёркивается касанием. Это НЕ дела: продукты и хозяйство живут здесь, чтобы не топить дела. Можешь предложить строку через propose_record с kind=shopping_item.",
  "• Записать трату можно снаружи приложения: Быстрая команда на телефоне шлёт текст в инбокс, оттуда он приходит черновиком.",
].join("\n");

const ADVISOR_SYSTEM = [
  "Ты — личный советник Nicky внутри его приложения Finappa. Отвечай по-русски, коротко и по делу.",
  "У тебя есть выжимка его настоящих данных: деньги, дела, ежедневные практики, цели, подписки.",
  "",
  "Правила:",
  "1. Опирайся на цифры из данных и называй их. Не выдумывай того, чего в данных нет: если не хватает — так и скажи.",
  "1а. В выжимке лежат только последние 25 операций, а всего их могут быть сотни. Как только речь заходит о КОНКРЕТНОЙ записи, её дате или сумме — не отвечай «не вижу», а вызови инструмент find_transactions. Сказать «в последних операциях этого нет» вместо поиска — ошибка.",
  "1б. Сначала посмотри, умеет ли нужное само приложение (список ниже), и предложи готовый путь: куда нажать. ТЗ на доработку оформляй, только если такого пути действительно нет.",
  "1в. Ты можешь ПРЕДЛОЖИТЬ запись инструментом propose_record: подписку, дело или отметку сегодняшней практики. Создать её ты не можешь — карточку подтверждает он касанием. Поэтому пиши «предлагаю», «подтверди на карточке», и никогда «создал», «добавил», «отметил». Если инструмент вернул ok:false — скажи честно, что не вышло и почему.",
  "1е. Обмен валюты и перевод между кошельками — это операции типа transfer. Они НЕ расходы и НЕ доходы, поэтому их нет ни в итогах месяца, ни в «последниеОперации». Обмены текущего месяца лежат в выжимке отдельным полем; за другой период ищи инструментом с type=transfer. Отвечать «обменов не нашлось», не заглянув туда, — ошибка.",
  "1г. Расходы и доходы предлагать нельзя — их он записывает сам, это уже быстро. Удалять и править существующие записи ты тоже не можешь.",
  "1д. Не больше трёх предложений в одном ответе. Предлагай то, о чём он попросил или что прямо следует из разговора, а не всё, что пришло в голову.",
  "2. Не читай нотаций и не морализируй. Он взрослый человек и знает, что тратит.",
  "3. Не давай инвестиционных советов и не берись отвечать на «где взять денег» — это не то, на что у приложения есть основания.",
  "4. Валюты не смешивай молча: THB и USD — разные, при пересчёте говори, что пересчитал приблизительно.",
  "5. Если он высказывает пожелание к самому приложению — оформи его как ТЗ и заверни в блок ```тз ... ``` с полями ЗАДАЧА / ЗАЧЕМ / КРИТЕРИИ ГОТОВНОСТИ. Под блоком появится кнопка «Отправить в работу» — нажимает её он, не ты. Сам ты код приложения не меняешь.",
  "5а. В данных есть список «пожелания» — то, что уже отправлено продакт-менеджеру. Сверься с ним перед тем, как оформлять новое: если такое уже отправлено, скажи об этом вместо дубля.",
  "6. Короткий ответ лучше длинного. Списком — только когда список действительно нужен.",
  "6а. Пиши обычным текстом, БЕЗ markdown-разметки: приложение показывает ответ как есть, поэтому «**жирный**» и «# заголовок» человек увидит вместе со звёздочками и решётками. Заголовок строки — просто словами с двоеточием, список — тире в начале строки.",
  "",
  ADVISOR_APP,
].join("\n");

function advisorCall(payload) {
  return new Promise((resolve, reject) => {
    let base;
    try { base = new URL(ADVISOR_BASE); } catch { return reject(new Error("bad base url")); }
    const lib = base.protocol === "http:" ? require("http") : https;
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const req = lib.request(
      {
        protocol: base.protocol,
        hostname: base.hostname,
        port: base.port || (base.protocol === "http:" ? 80 : 443),
        path: (base.pathname === "/" ? "" : base.pathname) + "/v1/messages",
        method: "POST",
        timeout: 60000,
        headers: {
          "content-type": "application/json",
          "content-length": body.length,
          "x-api-key": String(process.env.ANTHROPIC_API_KEY || "").trim(),
          "anthropic-version": "2023-06-01",
        },
      },
      (r) => {
        let data = "";
        r.setEncoding("utf8");
        r.on("data", (c) => { data += c; if (data.length > 2e6) req.destroy(); });
        r.on("end", () => {
          let j = null;
          try { j = JSON.parse(data); } catch {}
          if (r.statusCode !== 200 || !j) return reject(new Error("upstream " + r.statusCode + " " + String(data).slice(0, 200)));
          resolve(j);
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

app.post("/api/advisor/ask", auth, async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: "advisor off", hint: "ANTHROPIC_API_KEY не задан на сервере" });
  const b = req.body || {};
  const question = String(b.question || "").trim().slice(0, ADVISOR_MAX_Q);
  if (!question) return res.status(400).json({ error: "empty question" });

  const digest = advisorDigest(req.userId);
  if (!digest) return res.status(409).json({ error: "no data", hint: "Данные ещё не синхронизировались" });

  const gate = advisorTake(req.userId);
  if (!gate.ok) return res.status(429).json({ error: "day limit", used: gate.used, limit: gate.limit });

  const history = Array.isArray(b.history) ? b.history.slice(-ADVISOR_MAX_TURNS) : [];
  const messages = [];
  for (const m of history) {
    const role = m && m.role === "assistant" ? "assistant" : "user";
    const text = String((m && m.text) || "").slice(0, ADVISOR_MAX_Q);
    if (text) messages.push({ role, content: text });
  }
  messages.push({
    role: "user",
    content: "Мои данные на сейчас:\n" + JSON.stringify(digest) + "\n\nВопрос: " + question,
  });

  try {
    let out = null;
    let rounds = 0;
    const usedTools = [];
    const proposals = [];
    while (rounds < ADVISOR_MAX_ROUNDS) {
      rounds++;
      out = await advisorCall({
        model: ADVISOR_MODEL,
        max_tokens: 1500,
        system: ADVISOR_SYSTEM,
        tools: ADVISOR_TOOLS,
        messages,
      });
      const calls = (out.content || []).filter((c) => c && c.type === "tool_use");
      if (!calls.length) break;
      messages.push({ role: "assistant", content: out.content });
      const results = [];
      for (const c of calls) {
        let r;
        try {
          if (c.name === "find_transactions") r = advisorFindTx(req.userId, c.input);
          else if (c.name === "propose_record") {
            if (proposals.length >= ADVISOR_MAX_PROPOSALS) {
              r = { ok: false, ошибка: "за один ответ показываем не больше трёх предложений" };
            } else {
              r = advPropose(req.userId, c.input);
              if (r && r.ok) {
                proposals.push(Object.assign({ id: "pr" + (proposals.length + 1) + Date.now().toString(36) }, r.предложение));
                r = { ok: true, показано: "Карточка показана Nicky. Он подтверждает её сам — не пиши, что запись создана." };
              }
            }
          } else r = { ошибка: "неизвестный инструмент" };
        } catch (e) {
          r = { ok: false, ошибка: String(e.message || e).slice(0, 120) };
        }
        usedTools.push({ tool: c.name, args: c.input, found: r && r.найдено, ok: r && r.ok });
        results.push({ type: "tool_result", tool_use_id: c.id, content: JSON.stringify(r) });
      }
      messages.push({ role: "user", content: results });
    }
    const text = ((( out || {}).content || []).find((c) => c && c.type === "text") || {}).text || "";
    res.json({ ok: true, answer: text, used: gate.used, limit: gate.limit, rounds, tools: usedTools, proposals });
  } catch (e) {
    res.status(502).json({ error: "upstream failed", detail: String(e.message || e).slice(0, 200) });
  }
});

app.post("/api/push/tasks-check", auth, async (req, res) => {
  const b = req.body || {};
  res.json(await remindTasks({ force: !!b.force, dry: !!b.dry, onlyUid: req.userId }));
});

app.listen(PORT, () => console.log(`finappa-server on :${PORT}, data in ${DATA_DIR}`));
