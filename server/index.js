// Общий план поездки. Одна строка в Postgres, номер ревизии, слияние на клиенте.
// Задача сервиса — не потерять правку, когда трое пишут из разных мест.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import pg from "pg";

const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.TRIP_PASSWORD || "";
const ORIGINS = (process.env.ALLOW_ORIGIN || "")
  .split(",").map(s => s.trim()).filter(Boolean);

if (!PASSWORD) {
  console.error("TRIP_PASSWORD не задан — сервис отказывается стартовать без пароля");
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /proxy\.rlwy\.net|\.railway\.app/.test(process.env.DATABASE_URL || "")
    ? { rejectUnauthorized: false }
    : false,
});

const KEEP_REVS = 50;
const OG_TTL_MS = 7 * 24 * 3600 * 1000;
const OG_MAX_BYTES = 512 * 1024;

async function init() {
  await pool.query(`
    create table if not exists plan (
      id int primary key,
      rev int not null,
      data jsonb not null,
      updated_at timestamptz not null default now()
    )
  `);
  // Сервис деплоится в работающую базу, поэтому всё через if not exists.
  await pool.query("alter table plan add column if not exists author text");
  await pool.query(`
    create table if not exists og_cache (
      url text primary key,
      data jsonb not null,
      fetched_at timestamptz not null default now()
    )
  `);
  await pool.query(`
    create table if not exists plan_rev (
      rev int primary key,
      author text,
      updated_at timestamptz not null default now(),
      data jsonb not null
    )
  `);
  const { rowCount } = await pool.query("select 1 from plan where id = 1");
  if (!rowCount) {
    const seed = JSON.parse(await readFile(new URL("./plan.seed.json", import.meta.url), "utf8"));
    await pool.query("insert into plan (id, rev, data) values (1, 1, $1)", [seed]);
    console.log("план засеян из plan.seed.json");
  }
}

// Имя правившего приходит от клиента и ничего не решает — это подпись, не доступ.
function cleanAuthor(v) {
  if (typeof v !== "string") return null;
  const s = v.trim().slice(0, 60);
  return s || null;
}

// Сервер ходит по ссылке, которую дал клиент. Значит, надо явно запретить
// ему стучаться внутрь инфраструктуры: только http/https и только наружу.
function safeTarget(raw) {
  let u;
  try { u = new URL(String(raw || "")); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const h = u.hostname.toLowerCase();
  if (!h || h.startsWith("[")) return null;                       // IPv6-литералы не пускаем
  if (h === "localhost" || h.endsWith(".localhost")) return null;
  if (h.endsWith(".internal") || h.endsWith(".local")) return null;
  if (/^(0\.|127\.|10\.|192\.168\.|169\.254\.)/.test(h)) return null;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return null;
  return u;
}

function unescapeHtml(v) {
  return String(v)
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&").trim();
}

function metaMap(html) {
  const out = {};
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const key = (/(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag) || [])[1];
    const val = (/content\s*=\s*["']([^"']*)["']/i.exec(tag) || [])[1];
    if (key && val) out[key.toLowerCase()] = unescapeHtml(val);
  }
  const t = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html);
  if (t) out.__title = unescapeHtml(t[1]);
  return out;
}

async function fetchOg(target) {
  const res = await fetch(target, {
    redirect: "follow",
    signal: AbortSignal.timeout(8000),
    headers: {
      // Без человеческого user-agent половина сайтов отдаёт заглушку
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      "accept": "text/html,application/xhtml+xml",
      "accept-language": "ru,en;q=0.8"
    }
  });
  if (!res.ok) return { url: target.toString(), error: "сайт ответил " + res.status };
  const type = res.headers.get("content-type") || "";
  if (!/text\/html|application\/xhtml/i.test(type)) return { url: target.toString(), error: "не страница" };

  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < OG_MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    chunks.push(value);
  }
  try { await reader.cancel(); } catch {}
  const html = Buffer.concat(chunks.map(c => Buffer.from(c))).toString("utf8");

  const m = metaMap(html);
  const image = m["og:image"] || m["twitter:image"] || "";
  const out = {
    url: target.toString(),
    // Короткие ссылки (maps.app.goo.gl и прочие) разворачиваем: клиенту
    // нужен конечный адрес, чтобы достать из него название места.
    final: res.url || target.toString(),
    title: (m["og:title"] || m["twitter:title"] || m.__title || "").slice(0, 180),
    description: (m["og:description"] || m["twitter:description"] || m.description || "").slice(0, 300),
    site: (m["og:site_name"] || target.hostname.replace(/^www\./, "")).slice(0, 80),
    image: /^https:\/\//i.test(image) ? image.slice(0, 800) : ""
  };
  if (!out.title && !out.image) out.error = "нет карточки";
  return out;
}

function authorized(req) {
  const got = req.headers["x-trip-key"];
  if (typeof got !== "string") return false;
  const a = Buffer.from(got);
  const b = Buffer.from(PASSWORD);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-trip-key");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function send(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("тело запроса слишком большое");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function validPlan(p) {
  return p && typeof p === "object"
    && Array.isArray(p.checklist)
    && p.segments && typeof p.segments === "object"
    && Array.isArray(p.notes)
    // links появился позже: в базе есть планы без него, поэтому проверяем,
    // только если поле вообще пришло
    && (p.links === undefined || Array.isArray(p.links))
    && (p.points === undefined || Array.isArray(p.points))
    && (p.people === undefined || Array.isArray(p.people));
}

const server = http.createServer(async (req, res) => {
  cors(req, res);

  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/health") return send(res, 200, { ok: true });

  const isPlan = url.pathname === "/plan";
  const isHistory = url.pathname === "/history" || url.pathname.startsWith("/history/");
  const isOg = url.pathname === "/og";
  if (!isPlan && !isHistory && !isOg) return send(res, 404, { error: "нет такого пути" });

  if (!authorized(req)) return send(res, 401, { error: "неверный пароль" });

  try {
    if (isOg) {
      if (req.method !== "GET") return send(res, 405, { error: "метод не поддерживается" });
      const target = safeTarget(url.searchParams.get("url"));
      if (!target) return send(res, 400, { error: "такую ссылку не открываем" });
      const key = target.toString();

      const hit = await pool.query("select data, fetched_at from og_cache where url = $1", [key]);
      const fresh = hit.rowCount && Date.now() - new Date(hit.rows[0].fetched_at).getTime() < OG_TTL_MS;
      // Кэш живёт неделю и переживает деплой. Если форма ответа изменилась,
      // старую запись надо перечитать, иначе клиент неделю видит прошлый формат.
      const sameShape = hit.rowCount && hit.rows[0].data && (hit.rows[0].data.final || hit.rows[0].data.error);
      if (fresh && sameShape) return send(res, 200, hit.rows[0].data);

      let data;
      try { data = await fetchOg(target); }
      catch (e) { data = { url: key, error: "не открылось" }; }

      await pool.query(
        "insert into og_cache (url, data, fetched_at) values ($1, $2, now()) " +
        "on conflict (url) do update set data = $2, fetched_at = now()",
        [key, data]
      );
      return send(res, 200, data);
    }

    if (isHistory && req.method === "GET") {
      const tail = url.pathname.slice("/history".length).replace(/^\//, "");
      if (!tail) {
        const { rows } = await pool.query(
          "select rev, author, updated_at from plan_rev order by rev desc limit $1", [KEEP_REVS]
        );
        return send(res, 200, { history: rows });
      }
      const want = Number(tail);
      if (!Number.isInteger(want)) return send(res, 400, { error: "ревизия не число" });
      const { rows } = await pool.query(
        "select rev, author, updated_at, data from plan_rev where rev = $1", [want]
      );
      if (!rows.length) return send(res, 404, { error: "такой ревизии нет" });
      return send(res, 200, { rev: rows[0].rev, author: rows[0].author, updated_at: rows[0].updated_at, plan: rows[0].data });
    }
    if (isHistory) return send(res, 405, { error: "метод не поддерживается" });

    if (req.method === "GET") {
      const { rows } = await pool.query("select rev, data, author, updated_at from plan where id = 1");
      return send(res, 200, {
        rev: rows[0].rev, plan: rows[0].data,
        author: rows[0].author, updated_at: rows[0].updated_at
      });
    }

    if (req.method === "PUT") {
      const body = await readBody(req);
      if (!Number.isInteger(body.rev)) return send(res, 400, { error: "нет номера ревизии" });
      if (!validPlan(body.plan)) return send(res, 400, { error: "план не того формата" });

      const author = cleanAuthor(body.author);
      const upd = await pool.query(
        "update plan set rev = rev + 1, data = $1, author = $2, updated_at = now() where id = 1 and rev = $3 returning rev, updated_at",
        [body.plan, author, body.rev]
      );

      if (upd.rowCount) {
        const saved = upd.rows[0];
        // Снимок на каждую удачную запись: без него не ответить «кто это удалил».
        await pool.query(
          "insert into plan_rev (rev, author, updated_at, data) values ($1, $2, $3, $4) on conflict (rev) do nothing",
          [saved.rev, author, saved.updated_at, body.plan]
        );
        await pool.query("delete from plan_rev where rev <= $1", [saved.rev - KEEP_REVS]);
        return send(res, 200, { rev: saved.rev, author, updated_at: saved.updated_at });
      }

      // Кто-то записал раньше. Отдаём текущее — клиент сольёт и повторит.
      const { rows } = await pool.query("select rev, data, author, updated_at from plan where id = 1");
      return send(res, 409, {
        rev: rows[0].rev, plan: rows[0].data,
        author: rows[0].author, updated_at: rows[0].updated_at
      });
    }

    return send(res, 405, { error: "метод не поддерживается" });
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: "сервис не смог обработать запрос" });
  }
});

await init();
server.listen(PORT, () => console.log("слушаю порт " + PORT));
