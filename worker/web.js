// The routes the web pages call (BINGO-WEB.md §7.1): Steam sign-in, who is signed in, making a
// game, joining it with a personal code, and the host's actions. The pages only ask; the
// Worker checks who is asking and then calls the game (GameRoom) like the dev routes do
//
//   GET  /auth/steam/login?return=<page>        to Steam's sign-in page
//   GET  /auth/steam/callback                   back from Steam: checked, then signed in
//   POST /auth/logout
//   GET  /api/me[?game=<id>]                    who is signed in, and whether they host / play that game
//   GET  /api/me/games                          the games they host or are in, newest first
//   GET  /api/boards                            the boards a game can be made with
//   POST /api/games                             make a game: { board, settings }, the maker hosts it;
//                                               a random board also takes { ruleset, pools }
//   POST /api/games/<id>/join                   join a team: { team }, gives a join code
//   POST /api/games/<id>/code                   a new join code
//   POST /api/games/<id>/host/<action>          the host's actions, see HOST_ACTIONS

import extraFiles from "../rules/extra-files.json";
import handicapPresets from "../rules/handicaps.json";
import scripted from "../rules/won-scripted.json";
import scriptless from "../rules/won-scriptless.json";
import scriptedBoard from "../boards/scripted.json";
import scriptlessBoard from "../boards/scriptless.json";
import hl1Catalog from "../catalog/hl1.json";
import { checkHandicapPresets } from "../src/rules/handicaps.js";
import {
  LOGIN_COOKIE,
  LOGIN_LIFETIME_MS,
  SESSION_COOKIE,
  SESSION_LIFETIME_MS,
  cookie,
  endSession,
  isAllowed,
  isLocalPath,
  isPageOrigin,
  isPrivate,
  randomToken,
  readCookie,
  sameSecret,
  startSession,
} from "./auth.js";
import { boardTiles, catalogPools, drawBoard } from "./boards.js";
import { CODE_LIFETIME_MS, issueCode } from "./codes.js";
import { ensureSchema, sweep } from "./db.js";
import { checkSettings } from "./settings.js";
import { newGameId } from "./secrets.js";
import { playerGames } from "./records.js";
import { NONCE_MAX_AGE_MS, loginUrl, playerSummary, verifyLogin } from "./steam.js";

/**
 * @typedef {import("./index.js").Env} Env
 * @typedef {import("./auth.js").SignedIn} SignedIn
 */

/** @type {Record<string, import("../src/protocol/segment.js").Ruleset>} */
const RULESETS = /** @type {any} */ ({ scriptless, scripted });
const PRESETS = checkHandicapPresets(handicapPresets);

/**
 * The segment catalog, every pool's file (BINGO.md §3.1)
 * @type {import("../src/protocol/segment.js").Segment[]}
 */
const CATALOG = /** @type {any} */ (hl1Catalog);

// The board drawn from the catalog, 25 segments of the pools the host ticks, with the rules they pick
const RANDOM_BOARD = "random";

/**
 * The test boards, BXT's offline manifests, each with its own rules
 * @type {Record<string, { name: string, ruleset: string, manifest: any }>}
 */
const BOARDS = {
  scriptless: { name: "Test board (scriptless)", ruleset: "scriptless", manifest: scriptlessBoard },
  scripted: { name: "Test board (scripted)", ruleset: "scripted", manifest: scriptedBoard },
};

/**
 * @param {string} board
 * @param {string | null} [ruleset] A random board's rules
 */
const boardName = (board, ruleset) =>
  board === RANDOM_BOARD ? (ruleset ? `Random board, ${ruleset}` : "Random board") : Object.hasOwn(BOARDS, board) ? BOARDS[board].name : board;

// Largest request body the routes read
const MAX_BODY_BYTES = 8192;

/**
 * @param {number} status
 * @param {unknown} body
 * @param {HeadersInit} [headers]
 */
const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });

/**
 * @param {Env} env
 * @param {string} id
 */
const game = (env, id) => env.GAME.get(env.GAME.idFromName(id));

/**
 * The web routes, or null when the path isn't one of them
 * @param {Request} request
 * @param {Env} env
 * @param {SignedIn | null} me
 * @param {number} now
 * @returns {Promise<Response | null>}
 */
export async function webRoute(request, env, me, now) {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const method = request.method;

  if (parts[0] === "auth") {
    if (parts[1] === "steam" && parts[2] === "login" && parts.length === 3 && method === "GET") {
      return steamLogin(request, env, url);
    }
    if (parts[1] === "steam" && parts[2] === "callback" && parts.length === 3 && method === "GET") {
      return steamCallback(request, env, url, now);
    }
    if (parts[1] === "logout" && parts.length === 2) {
      return withCors(request, env, method === "OPTIONS" ? preflight(request, env) : method === "POST" ? await logout(request, env) : null);
    }
    return null;
  }

  if (parts[0] !== "api") {
    return null;
  }
  if (method === "OPTIONS") {
    return withCors(request, env, preflight(request, env));
  }
  /** @type {Response | null} */
  let response = null;
  if (parts[1] === "me" && parts.length === 2 && method === "GET") {
    response = await whoAmI(env, me, url.searchParams.get("game"));
  } else if (parts[1] === "me" && parts[2] === "games" && parts.length === 3 && method === "GET") {
    response = await myGames(env, me);
  } else if (parts[1] === "boards" && parts.length === 2 && method === "GET") {
    response = json(200, [
      { id: RANDOM_BOARD, name: boardName(RANDOM_BOARD), ruleset: null, rulesets: Object.keys(RULESETS), pools: catalogPools(CATALOG) },
      ...Object.entries(BOARDS).map(([id, b]) => ({ id, name: b.name, ruleset: b.ruleset })),
    ]);
  } else if (parts[1] === "games" && method === "POST") {
    response = await gameAction(request, env, me, parts.slice(2), now);
  }
  return withCors(request, env, response);
}

// CORS: pages on PAGE_ORIGINS (e.g. jrik.dev, when the Worker is bingo.jrik.dev) call with credentials

/**
 * @param {Request} request
 * @param {Env} env
 * @param {Response | null} response
 */
function withCors(request, env, response) {
  const origin = request.headers.get("Origin");
  if (response && origin && origin !== new URL(request.url).origin && isPageOrigin(request, env, origin)) {
    const out = new Response(response.body, response);
    out.headers.set("Access-Control-Allow-Origin", origin);
    out.headers.set("Access-Control-Allow-Credentials", "true");
    out.headers.append("Vary", "Origin");
    return out;
  }
  return response;
}

/**
 * @param {Request} request
 * @param {Env} env
 */
function preflight(request, env) {
  if (!isPageOrigin(request, env, request.headers.get("Origin"))) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Methods": "GET, POST",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "600",
    },
  });
}

/**
 * Asks a rate-limit binding; no binding (a plain local server) never limits
 * @param {RateLimit | undefined} binding
 * @param {string} key
 */
async function overLimit(binding, key) {
  if (!binding) {
    return false;
  }
  const { success } = await binding.limit({ key });
  return !success;
}

/** @param {Request} request */
export const clientIp = (request) => request.headers.get("CF-Connecting-IP") ?? "local";

// Signing in

/**
 * Where to go after signing in: a path on this site, or a page on PAGE_ORIGINS. Anything else
 * (another site, a `//host` path) goes to the bingo home page instead
 * @param {Request} request
 * @param {Env} env
 * @param {string | null} value
 */
function safeReturn(request, env, value) {
  const fallback = "/bingo/";
  if (!value || value.length > 512) {
    return fallback;
  }
  if (isLocalPath(value)) {
    return value;
  }
  try {
    const target = new URL(value);
    return isPageOrigin(request, env, target.origin) && target.origin !== "null" ? target.href : fallback;
  } catch {
    return fallback;
  }
}

/**
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 */
async function steamLogin(request, env, url) {
  if (await overLimit(env.LOGIN_LIMIT, clientIp(request))) {
    return page(429, "Too many sign-ins", "Wait a minute and try again.");
  }
  const state = randomToken(16);
  const back = safeReturn(request, env, url.searchParams.get("return"));
  const callback = `${url.origin}/auth/steam/callback?state=${state}`;
  return new Response(null, {
    status: 302,
    headers: {
      Location: loginUrl(callback, url.origin),
      "Set-Cookie": cookie(LOGIN_COOKIE, `${state}|${encodeURIComponent(back)}`, LOGIN_LIFETIME_MS),
      "Cache-Control": "no-store",
    },
  });
}

/**
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 * @param {number} now
 */
async function steamCallback(request, env, url, now) {
  const clearLogin = cookie(LOGIN_COOKIE, "", 0);
  const saved = readCookie(request, LOGIN_COOKIE) ?? "";
  const bar = saved.indexOf("|");
  const state = url.searchParams.get("state") ?? "";
  // The answer must come back to the browser that asked for it
  if (bar < 0 || !state || !sameSecret(saved.slice(0, bar), state)) {
    return page(400, "Sign-in didn't work", "It took too long, or it was started in another browser. Try again.", clearLogin);
  }
  let back = "/bingo/";
  try {
    back = safeReturn(request, env, decodeURIComponent(saved.slice(bar + 1)));
  } catch {
    // Keeps the home page
  }

  const check = await verifyLogin(url.searchParams, `${url.origin}/auth/steam/callback?state=${state}`, now);
  if ("error" in check) {
    if (check.error === "cancelled") {
      return new Response(null, { status: 302, headers: { Location: back, "Set-Cookie": clearLogin } });
    }
    const why = check.error === "steam_unreachable" ? "Steam couldn't be reached. Try again in a moment." : "Steam's answer couldn't be confirmed. Try again.";
    return page(check.error === "steam_unreachable" ? 502 : 400, "Sign-in didn't work", why, clearLogin);
  }
  await ensureSchema(env.DB);
  // Each answer works once
  const fresh = await env.DB.prepare("INSERT INTO openid_nonces (nonce, expires) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING nonce")
    .bind(check.nonce, now + 2 * NONCE_MAX_AGE_MS)
    .first();
  if (!fresh) {
    return page(400, "Sign-in didn't work", "That sign-in was already used. Try again.", clearLogin);
  }
  if (!isAllowed(env, check.steamid64)) {
    return page(403, "Private test server", "Only invited players can use this server.", clearLogin);
  }

  const known = /** @type {{ name: string, avatar: string | null } | null} */ (
    await env.DB.prepare("SELECT name, avatar FROM players WHERE steamid64 = ?").bind(check.steamid64).first()
  );
  const summary = await playerSummary(check.steamid64, env.STEAM_API_KEY);
  const player = {
    steamid64: check.steamid64,
    name: summary?.name ?? known?.name ?? `Player ${check.steamid64.slice(-4)}`,
    avatar: summary ? summary.avatar : (known?.avatar ?? null),
  };
  const token = await startSession(env.DB, player, now);
  await sweep(env.DB, now);
  const headers = new Headers({ Location: back, "Cache-Control": "no-store" });
  headers.append("Set-Cookie", cookie(SESSION_COOKIE, token, SESSION_LIFETIME_MS));
  headers.append("Set-Cookie", clearLogin);
  return new Response(null, { status: 302, headers });
}

/**
 * @param {Request} request
 * @param {Env} env
 */
async function logout(request, env) {
  if (!isPageOrigin(request, env, request.headers.get("Origin"))) {
    return json(403, { error: "bad_origin" });
  }
  await endSession(request, env.DB);
  return json(200, { ok: true }, { "Set-Cookie": cookie(SESSION_COOKIE, "", 0) });
}

/**
 * The signed-in player, and their place in a game
 * @param {Env} env
 * @param {SignedIn | null} me
 * @param {string | null} gameId
 */
async function whoAmI(env, me, gameId) {
  const body = {
    player: me,
    private: isPrivate(env),
    /** @type {{ host: boolean, player: unknown } | null} */
    game: null,
  };
  if (me && gameId && /^[0-9a-f]{16}$/.test(gameId)) {
    const [row, snapshot] = await Promise.all([hostOf(env, gameId), game(env, gameId).snapshot()]);
    if (snapshot) {
      body.game = {
        host: row === me.steamid64,
        player: snapshot.lobby.players.find((/** @type {any} */ p) => p.steamid64 === me.steamid64) ?? null,
      };
    }
  }
  return json(200, body);
}

// How many games the list shows, and how many unfinished ones in it are checked with their game
const MY_GAMES = 50;
const MY_GAMES_CHECKED = 10;

/**
 * The games the signed-in player hosts or is in, newest first, with each one's state and ending
 * The unfinished ones are checked with their game first, which writes its record again if D1 is
 * behind (a game ended before records existed, or a write that failed)
 * @param {Env} env
 * @param {SignedIn | null} me
 */
async function myGames(env, me) {
  if (!me) {
    return json(401, { error: "sign_in", message: "sign in through Steam first" });
  }
  let games = await playerGames(env.DB, me.steamid64, MY_GAMES);
  const unfinished = games.filter((g) => g.state !== "finished").slice(0, MY_GAMES_CHECKED);
  const wrote = await Promise.all(unfinished.map((g) => game(env, g.id).refreshRecord(g.state).catch(() => false)));
  if (wrote.some(Boolean)) {
    games = await playerGames(env.DB, me.steamid64, MY_GAMES);
  }
  return json(200, {
    games: games.map((g) => ({ ...g, board_name: boardName(g.board, g.ruleset) })),
  });
}

/**
 * The game's host, from D1. Games made by the dev routes have none
 * @param {Env} env
 * @param {string} gameId
 */
async function hostOf(env, gameId) {
  await ensureSchema(env.DB);
  const row = await env.DB.prepare("SELECT host FROM games WHERE id = ?").bind(gameId).first();
  return row ? String(row.host) : null;
}

// Games

/**
 * A refusal from the game, as an HTTP status
 * @param {{ error?: string, message?: string }} result
 */
function refused(result) {
  const notFound = ["not_found", "unknown_player", "unknown_attempt"].includes(result.error ?? "");
  return json(result.error === "bad_request" ? 400 : notFound ? 404 : 409, result);
}

/**
 * The request's JSON object, or null
 * @param {Request} request
 */
async function readBody(request) {
  // Refused before reading when the size is given; bodies sent in chunks are measured after
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_BODY_BYTES) {
    return null;
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return null;
  }
  try {
    const body = JSON.parse(text || "{}");
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

/**
 * POST /api/games and /api/games/<id>/...
 * @param {Request} request
 * @param {Env} env
 * @param {SignedIn | null} me
 * @param {string[]} rest After /api/games
 * @param {number} now
 */
async function gameAction(request, env, me, rest, now) {
  // Other sites can't act for a signed-in visitor
  if (!isPageOrigin(request, env, request.headers.get("Origin"))) {
    return json(403, { error: "bad_origin", message: "requests must come from the bingo pages" });
  }
  if (!me) {
    return json(401, { error: "sign_in", message: "sign in through Steam first" });
  }
  const body = await readBody(request);
  if (!body) {
    return json(400, { error: "bad_request", message: "the body must be a JSON object" });
  }

  if (rest.length === 0) {
    return createGame(env, me, body, now);
  }
  const id = rest[0];
  if (!/^[0-9a-f]{16}$/.test(id)) {
    return json(404, { error: "not_found" });
  }
  if (rest.length === 2 && rest[1] === "join") {
    return join(env, me, id, body, now);
  }
  if (rest.length === 2 && rest[1] === "code") {
    return newCode(env, me, id, now);
  }
  if (rest.length === 3 && rest[1] === "host") {
    return hostAction(env, me, id, rest[2], body);
  }
  return json(404, { error: "not_found" });
}

/**
 * @param {Env} env
 * @param {SignedIn} me
 * @param {any} body
 * @param {number} now
 */
async function createGame(env, me, body, now) {
  if (await overLimit(env.CREATE_LIMIT, me.steamid64)) {
    return json(429, { error: "rate_limited", message: "too many games, wait a minute" });
  }
  /** @type {any[]} */
  let tiles;
  /** @type {string} */
  let ruleset;
  if (body.board === RANDOM_BOARD) {
    if (typeof body.ruleset !== "string" || !Object.hasOwn(RULESETS, body.ruleset)) {
      return json(400, { error: "bad_request", message: `ruleset must be one of ${Object.keys(RULESETS).join(", ")}` });
    }
    const drawn = drawBoard(CATALOG, body.pools);
    if ("error" in drawn) {
      return json(400, { error: "bad_request", message: drawn.error });
    }
    tiles = drawn.tiles;
    ruleset = body.ruleset;
  } else if (typeof body.board === "string" && Object.hasOwn(BOARDS, body.board)) {
    tiles = boardTiles(BOARDS[body.board].manifest, CATALOG);
    ruleset = BOARDS[body.board].ruleset;
  } else {
    return json(400, { error: "bad_request", message: `board must be one of ${[RANDOM_BOARD, ...Object.keys(BOARDS)].join(", ")}` });
  }
  const settings = checkSettings(body.settings ?? {});
  if (typeof settings === "string") {
    return json(400, { error: "bad_request", message: settings });
  }
  const id = newGameId();
  const result = await game(env, id).create({
    id,
    settings,
    tiles,
    ruleset: RULESETS[ruleset],
    handicapPresets: PRESETS,
    extraFiles,
  });
  if (result.error) {
    return refused(result);
  }
  await ensureSchema(env.DB);
  await env.DB.prepare("INSERT INTO games (id, host, created, board, ruleset) VALUES (?, ?, ?, ?, ?)")
    .bind(id, me.steamid64, now, body.board, ruleset)
    .run();
  return json(200, { id });
}

/**
 * Joins a team, or changes it while the game hasn't started, and gives a join code for BXT
 * @param {Env} env
 * @param {SignedIn} me
 * @param {string} id
 * @param {any} body
 * @param {number} now
 */
async function join(env, me, id, body, now) {
  if (await overLimit(env.JOIN_LIMIT, me.steamid64)) {
    return json(429, { error: "rate_limited", message: "too many tries, wait a minute" });
  }
  const team = body.team ?? null;
  if (team !== null && team !== "red" && team !== "blue") {
    return json(400, { error: "bad_request", message: "team must be red, blue or null" });
  }
  const stub = game(env, id);
  const snapshot = await stub.snapshot();
  if (!snapshot) {
    return json(404, { error: "not_found", message: "no such game" });
  }
  const mine = snapshot.lobby.players.find((/** @type {any} */ p) => p.steamid64 === me.steamid64);
  // Once it has started, only the host moves players
  if (mine && mine.team !== team && snapshot.lobby.state !== "lobby") {
    return json(409, { error: "bad_state", message: "the game has started: only the host can move players now" });
  }
  const result = await stub.action("add_player", { steamid64: me.steamid64, name: me.name, team });
  if (result.error) {
    return refused(result);
  }
  const code = await issueCode(env.DB, id, me.steamid64, now);
  return json(200, { code, expires_in_ms: CODE_LIFETIME_MS });
}

/**
 * @param {Env} env
 * @param {SignedIn} me
 * @param {string} id
 * @param {number} now
 */
async function newCode(env, me, id, now) {
  if (await overLimit(env.JOIN_LIMIT, me.steamid64)) {
    return json(429, { error: "rate_limited", message: "too many tries, wait a minute" });
  }
  const snapshot = await game(env, id).snapshot();
  if (!snapshot) {
    return json(404, { error: "not_found", message: "no such game" });
  }
  if (!snapshot.lobby.players.some((/** @type {any} */ p) => p.steamid64 === me.steamid64)) {
    return json(404, { error: "unknown_player", message: "join the game first" });
  }
  if (snapshot.lobby.state === "finished") {
    return json(409, { error: "game_over", message: "the game is over" });
  }
  const code = await issueCode(env.DB, id, me.steamid64, now);
  return json(200, { code, expires_in_ms: CODE_LIFETIME_MS });
}

const STEAMID = /^\d{17}$/;
const TEAM_OR_NULL = (/** @type {unknown} */ t) => t === null || t === "red" || t === "blue";
const ATTEMPT = /^[0-9a-f-]{36}$/i;

/**
 * The host's actions, each with its arguments checked and copied (nothing else goes through)
 * @type {Record<string, (body: any) => Record<string, unknown> | null>}
 */
const HOST_ACTIONS = {
  start: (b) => (b.force === undefined || typeof b.force === "boolean" ? { force: b.force === true } : null),
  end: () => ({}),
  move: (b) => (STEAMID.test(b.steamid64) && TEAM_OR_NULL(b.team ?? null) ? { steamid64: b.steamid64, team: b.team ?? null } : null),
  kick: (b) =>
    STEAMID.test(b.steamid64) && (b.ban === undefined || typeof b.ban === "boolean") ? { steamid64: b.steamid64, ban: b.ban === true } : null,
  unban: (b) => (STEAMID.test(b.steamid64) ? { steamid64: b.steamid64 } : null),
  lock: (b) => (typeof b.locked === "boolean" ? { locked: b.locked } : null),
  handicaps: (b) =>
    STEAMID.test(b.steamid64) && Array.isArray(b.handicaps) && b.handicaps.length <= 32 && b.handicaps.every((/** @type {unknown} */ h) => typeof h === "string" && h.length <= 64)
      ? { steamid64: b.steamid64, handicaps: b.handicaps }
      : null,
  void: (b) => (typeof b.attempt_id === "string" && ATTEMPT.test(b.attempt_id) ? { attempt_id: b.attempt_id } : null),
  accept: (b) => (typeof b.attempt_id === "string" && ATTEMPT.test(b.attempt_id) ? { attempt_id: b.attempt_id } : null),
};

/**
 * @param {Env} env
 * @param {SignedIn} me
 * @param {string} id
 * @param {string} action
 * @param {any} body
 */
async function hostAction(env, me, id, action, body) {
  const check = Object.hasOwn(HOST_ACTIONS, action) ? HOST_ACTIONS[action] : null;
  if (!check) {
    return json(404, { error: "not_found", message: `unknown action ${action}` });
  }
  if ((await hostOf(env, id)) !== me.steamid64) {
    return json(403, { error: "not_host", message: "only the game's host can do that" });
  }
  if (await overLimit(env.ACTION_LIMIT, me.steamid64)) {
    return json(429, { error: "rate_limited", message: "too many actions, wait a minute" });
  }
  const args = check(body);
  if (!args) {
    return json(400, { error: "bad_request", message: `bad arguments for ${action}` });
  }
  const result = await game(env, id).action(action, args);
  return result.error ? refused(result) : json(200, result);
}

// Pages the Worker writes itself: sign-in errors, and the private server's front door

/** @param {string} text */
const escapeHtml = (text) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * A small page with a title, a line and an optional sign-in link
 * @param {number} status
 * @param {string} title
 * @param {string} line
 * @param {string} [setCookie]
 * @param {string} [signInReturn] Adds "Sign in through Steam", coming back here
 */
export function page(status, title, line, setCookie, signInReturn) {
  const link =
    signInReturn === undefined
      ? `<p><a href="/bingo/">Back to Half-Life Bingo</a></p>`
      : `<p><a class="btn" href="/auth/steam/login?return=${encodeURIComponent(signInReturn)}">Sign in through Steam</a></p>`;
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — BXT Bingo</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #0f110b; color: #d9d6c0; font: 16px/1.5 system-ui, sans-serif; }
  main { max-width: 440px; padding: 32px; border: 1px solid #7c8a52; background: #1b1f13; }
  h1 { margin: 0 0 8px; font-size: 1.3rem; color: #e8962e; }
  a { color: #2de2e6; }
  .btn { display: inline-block; margin-top: 8px; padding: 10px 18px; border: 1px solid #e8962e; color: #ffb547; text-decoration: none; font-weight: 600; }
</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(line)}</p>${link}</main></body></html>`;
  /** @type {Record<string, string>} */
  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "frame-ancestors 'none'",
    "X-Frame-Options": "DENY",
  };
  if (setCookie) {
    headers["Set-Cookie"] = setCookie;
  }
  return new Response(html, { status, headers });
}
