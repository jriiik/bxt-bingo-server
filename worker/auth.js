// Who is signed in: login sessions in a cookie, the private test server's allowlist, and which
// pages may call the routes (BINGO-WEB.md §11)

import { ensureSchema } from "./db.js";
import { sha256Hex } from "./secrets.js";

// __Host-: only from this exact host, over HTTPS (or localhost), for the whole site
export const SESSION_COOKIE = "__Host-bingo_session";
// Ties Steam's answer to the browser that asked for it
export const LOGIN_COOKIE = "__Host-bingo_login";
export const SESSION_LIFETIME_MS = 30 * 24 * 3600_000;
export const LOGIN_LIFETIME_MS = 10 * 60_000;

/**
 * @typedef {object} SignedIn
 * @property {string} steamid64
 * @property {string} name Steam name
 * @property {string | null} avatar
 */

/**
 * @param {Request} request
 * @param {string} name
 */
export function readCookie(request, name) {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

/**
 * A Set-Cookie value. HttpOnly, so the pages' scripts never see it
 * @param {string} name
 * @param {string} value
 * @param {number} maxAgeMs 0 deletes it
 */
export function cookie(name, value, maxAgeMs) {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}`;
}

/** A random URL-safe secret */
export function randomToken(bytes = 32) {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Constant-time comparison of two strings
 * @param {string} a
 * @param {string} b
 */
export function sameSecret(a, b) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}

// The private test server (BINGO-WEB.md §7.6): only the players on the list can sign in and see
// anything. PRIVATE=true with an empty list lets nobody in

/**
 * @param {{ PRIVATE?: string, ALLOWED_STEAMIDS?: string }} env
 */
export function isPrivate(env) {
  return env.PRIVATE === "true" || allowList(env).length > 0;
}

/** @param {{ ALLOWED_STEAMIDS?: string }} env */
function allowList(env) {
  return (env.ALLOWED_STEAMIDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\d{17}$/.test(s));
}

/**
 * @param {{ PRIVATE?: string, ALLOWED_STEAMIDS?: string }} env
 * @param {string} steamid64
 */
export function isAllowed(env, steamid64) {
  return !isPrivate(env) || allowList(env).includes(steamid64);
}

/**
 * Stores the player (name and avatar refreshed at each sign-in) and starts a session
 * @param {D1Database} db
 * @param {{ steamid64: string, name: string, avatar: string | null }} player
 * @param {number} now
 * @returns {Promise<string>} The session token, for the cookie
 */
export async function startSession(db, player, now) {
  await ensureSchema(db);
  const token = randomToken();
  await db.batch([
    db
      .prepare(
        `INSERT INTO players (steamid64, name, avatar, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (steamid64) DO UPDATE SET name = excluded.name, avatar = excluded.avatar, last_seen = excluded.last_seen`,
      )
      .bind(player.steamid64, player.name, player.avatar, now, now),
    db
      .prepare("INSERT INTO sessions (token_hash, steamid64, created, expires) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(token), player.steamid64, now, now + SESSION_LIFETIME_MS),
  ]);
  return token;
}

/**
 * The signed-in player, from the session cookie, or null
 * On a private server, a player taken off the list is signed out
 * @param {Request} request
 * @param {{ DB: D1Database, PRIVATE?: string, ALLOWED_STEAMIDS?: string }} env
 * @param {number} now
 * @returns {Promise<SignedIn | null>}
 */
export async function signedIn(request, env, now) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token || token.length > 100) {
    return null;
  }
  await ensureSchema(env.DB);
  /** @type {SignedIn | null} */
  const row = await env.DB.prepare(
    `SELECT p.steamid64 AS steamid64, p.name AS name, p.avatar AS avatar
     FROM sessions s JOIN players p ON p.steamid64 = s.steamid64
     WHERE s.token_hash = ? AND s.expires > ?`,
  )
    .bind(await sha256Hex(token), now)
    .first();
  return row && isAllowed(env, row.steamid64) ? row : null;
}

/**
 * Signs out: the session is deleted, not just the cookie
 * @param {Request} request
 * @param {D1Database} db
 */
export async function endSession(request, db) {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) {
    await ensureSchema(db);
    await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
  }
}

// Pages that may call the routes: this Worker's own (it can serve them) and PAGE_ORIGINS,
// e.g. `https://jrik.dev`, or `http://localhost:8765` for a local copy

/**
 * @param {Request} request
 * @param {{ PAGE_ORIGINS?: string, DEV_ROUTES?: string }} env
 * @param {string | null} origin
 */
export function isPageOrigin(request, env, origin) {
  if (!origin) {
    return false;
  }
  if (origin === new URL(request.url).origin) {
    return true;
  }
  // Testing locally: the pages from another local port, or opened from disk ("null")
  if (env.DEV_ROUTES === "true" && (origin === "null" || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))) {
    return true;
  }
  return (env.PAGE_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .includes(origin);
}
