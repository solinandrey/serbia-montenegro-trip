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
    && (p.links === undefined || Array.isArray(p.links));
}

const server = http.createServer(async (req, res) => {
  cors(req, res);

  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/health") return send(res, 200, { ok: true });

  const isPlan = url.pathname === "/plan";
  const isHistory = url.pathname === "/history" || url.pathname.startsWith("/history/");
  if (!isPlan && !isHistory) return send(res, 404, { error: "нет такого пути" });

  if (!authorized(req)) return send(res, 401, { error: "неверный пароль" });

  try {
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
