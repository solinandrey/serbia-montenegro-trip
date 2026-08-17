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

async function init() {
  await pool.query(`
    create table if not exists plan (
      id int primary key,
      rev int not null,
      data jsonb not null,
      updated_at timestamptz not null default now()
    )
  `);
  const { rowCount } = await pool.query("select 1 from plan where id = 1");
  if (!rowCount) {
    const seed = JSON.parse(await readFile(new URL("./plan.seed.json", import.meta.url), "utf8"));
    await pool.query("insert into plan (id, rev, data) values (1, 1, $1)", [seed]);
    console.log("план засеян из plan.seed.json");
  }
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
    && Array.isArray(p.notes);
}

const server = http.createServer(async (req, res) => {
  cors(req, res);

  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/health") return send(res, 200, { ok: true });

  if (url.pathname !== "/plan") return send(res, 404, { error: "нет такого пути" });

  if (!authorized(req)) return send(res, 401, { error: "неверный пароль" });

  try {
    if (req.method === "GET") {
      const { rows } = await pool.query("select rev, data from plan where id = 1");
      return send(res, 200, { rev: rows[0].rev, plan: rows[0].data });
    }

    if (req.method === "PUT") {
      const body = await readBody(req);
      if (!Number.isInteger(body.rev)) return send(res, 400, { error: "нет номера ревизии" });
      if (!validPlan(body.plan)) return send(res, 400, { error: "план не того формата" });

      const upd = await pool.query(
        "update plan set rev = rev + 1, data = $1, updated_at = now() where id = 1 and rev = $2 returning rev",
        [body.plan, body.rev]
      );

      if (upd.rowCount) return send(res, 200, { rev: upd.rows[0].rev });

      // Кто-то записал раньше. Отдаём текущее — клиент сольёт и повторит.
      const { rows } = await pool.query("select rev, data from plan where id = 1");
      return send(res, 409, { rev: rows[0].rev, plan: rows[0].data });
    }

    return send(res, 405, { error: "метод не поддерживается" });
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: "сервис не смог обработать запрос" });
  }
});

await init();
server.listen(PORT, () => console.log("слушаю порт " + PORT));
