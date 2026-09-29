// The Worker: the front door of the backend (BINGO.md §8, BINGO-WEB.md §7.1)
//
// Routes here:
//   GET  /bxt                     BXT's socket, with X-Bingo-Join or X-Bingo-Session
//   GET  /ws/games/<id>           live updates for pages and spectators
//   GET  /api/games/<id>          a snapshot of a game
//   GET  /files/<sha256>          saves and other files (production serves them from assets.jrik.dev)
// The web pages' routes (Steam sign-in, making and joining games, the host's actions) are in web.js
// With an ASSETS binding or a PAGES bucket (the pages, e.g. on the private test server), everything
// else is a page
// Dev routes, only with DEV_ROUTES=true (`npm run dev`), standing in for the pages and Steam login:
//   POST /dev/games                          create a game: { tiles, settings, ruleset }
//   POST /dev/games/<id>/players             add a player: { name, team, steamid64? }, gives a join code
//   POST /dev/games/<id>/code                a new join code: { steamid64 }
//   POST /dev/games/<id>/<action>            host actions, see GameRoom.action
//   PUT  /dev/files/<sha256>                 upload a file
//   GET  /dev/login?steamid64=&name=&return= sign in as anyone, without Steam (localhost only)

import extraFiles from "../rules/extra-files.json";
import handicapPresets from "../rules/handicaps.json";
import scripted from "../rules/won-scripted.json";
import scriptless from "../rules/won-scriptless.json";
import { JOIN_HEADER, SESSION_HEADER } from "../src/protocol/index.js";
import { checkHandicapPresets } from "../src/rules/handicaps.js";
import { SESSION_COOKIE, SESSION_LIFETIME_MS, cookie, isLocalPath, isPageOrigin, isPrivate, signedIn, startSession } from "./auth.js";
import { issueCode, redeemCode } from "./codes.js";
import { newGameId, newSessionToken, sha256Hex } from "./secrets.js";
import { clientIp, page, webRoute } from "./web.js";

export { GameRoom } from "./game-room.js";

/**
 * @typedef {object} Env
 * @property {DurableObjectNamespace<import("./game-room.js").GameRoom>} GAME
 * @property {R2Bucket} FILES
 * @property {D1Database} DB Players, sessions, join codes, games (db.js)
 * @property {Fetcher} [ASSETS] The web pages, when this Worker serves them as static assets
 * @property {R2Bucket} [PAGES] Or the web pages in a bucket, by path (e.g. `bingo/game/index.html`)
 * @property {string} [DEV_ROUTES]
 * @property {string} [STEAM_API_KEY] Secret: Steam names and avatars
 * @property {string} [PRIVATE] "true": only ALLOWED_STEAMIDS may sign in and see anything
 * @property {string} [ALLOWED_STEAMIDS] Comma-separated SteamID64s, for the private test server
 * @property {string} [PAGE_ORIGINS] Comma-separated origins of pages served elsewhere, e.g. https://jrik.dev
 * @property {RateLimit} [LOGIN_LIMIT]
 * @property {RateLimit} [JOIN_LIMIT]
 * @property {RateLimit} [CODE_LIMIT] Join codes typed in BXT, per address
 * @property {RateLimit} [CREATE_LIMIT]
 * @property {RateLimit} [ACTION_LIMIT]
 */

/** @type {Record<string, import("../src/protocol/segment.js").Ruleset>} */
const RULESETS = /** @type {any} */ ({ scriptless, scripted });
const PRESETS = checkHandicapPresets(handicapPresets);

// Saves are about 1 MB, this leaves room for maps later
const MAX_FILE_BYTES = 64 * 1024 * 1024;

/**
 * @param {number} status
 * @param {unknown} body
 */
const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * Lets pages on other origins read a public response. Only for what anyone may read without
 * signing in: no credentials, so `*` is enough
 * @param {Response} response
 */
function withCors(response) {
  response.headers.set("Access-Control-Allow-Origin", "*");
  return response;
}

/**
 * A refusal from the game, as an HTTP status
 * @param {{ error?: string, message?: string }} result
 */
function refused(result) {
  const status = result.error === "not_found" || result.error === "unknown_player" || result.error === "unknown_attempt" ? 404 : 409;
  return json(result.error === "bad_request" ? 400 : status, result);
}

/**
 * @param {Env} env
 * @param {string} id
 */
const game = (env, id) => env.GAME.get(env.GAME.idFromName(id));

// Paths that work without signing in on the private test server: BXT's socket (join codes and
// session tokens are its credentials), the files it downloads, signing in, and the dev routes
// when they're on
const OPEN_PATHS = ["bxt", "files", "auth"];

// Game ids are 16 hex digits (newGameId). Anything else would make a Durable Object for nothing
const GAME_ID = /^[0-9a-f]{16}$/;

export default {
  /**
   * @param {Request} request
   * @param {Env} env
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const parts = path.split("/").filter(Boolean);
    const now = Date.now();

    if (path === "/bxt" && method === "GET") {
      return connectBxt(request, env);
    }

    const me = await signedIn(request, env, now);
    const open = OPEN_PATHS.includes(parts[0]) || (parts[0] === "dev" && env.DEV_ROUTES === "true");
    if (isPrivate(env) && !me && !open) {
      if (parts[0] === "api" || parts[0] === "ws") {
        return json(401, { error: "sign_in", message: "this is a private test server: sign in through Steam" });
      }
      return page(401, "Private test server", "This Half-Life Bingo server is for invited testers.", undefined, url.pathname + url.search);
    }

    const web = await webRoute(request, env, me, now);
    if (web) {
      return web;
    }
    if ((parts[0] === "ws" || parts[0] === "api") && parts[1] === "games" && parts.length === 3 && method === "GET" && !GAME_ID.test(parts[2])) {
      return withCors(json(404, { error: "not_found" }));
    }
    if (parts[0] === "ws" && parts[1] === "games" && parts.length === 3 && method === "GET") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return json(426, { error: "expected a WebSocket upgrade" });
      }
      // Browsers send where the page is from. Other sites' pages don't get the live updates
      const origin = request.headers.get("Origin");
      if (origin !== null && !isPageOrigin(request, env, origin)) {
        return json(403, { error: "bad_origin" });
      }
      return game(env, parts[2]).fetch(new Request("https://game/web", { headers: request.headers }));
    }
    if (parts[0] === "api" && parts[1] === "games" && parts.length === 3 && method === "GET") {
      const snapshot = await game(env, parts[2]).snapshot();
      // Public, so any page may read it: the game pages on jrik.dev, a local copy of them
      return withCors(snapshot ? json(200, snapshot) : json(404, { error: "not_found" }));
    }
    if (parts[0] === "files" && parts.length === 2 && method === "GET") {
      const object = /^[0-9a-f]{64}$/.test(parts[1]) ? await env.FILES.get(parts[1]) : null;
      if (!object) {
        return json(404, { error: "not_found" });
      }
      return new Response(object.body, {
        headers: { "Content-Type": "application/octet-stream", "Cache-Control": "public, max-age=31536000, immutable" },
      });
    }
    if (parts[0] === "dev" && env.DEV_ROUTES === "true") {
      return devRoute(request, env, parts.slice(1), now);
    }
    if ((env.ASSETS || env.PAGES) && method === "GET") {
      if (path === "/") {
        return Response.redirect(`${url.origin}/bingo/`, 302);
      }
      return env.ASSETS ? env.ASSETS.fetch(request) : servePage(env.PAGES, url);
    }
    return json(404, { error: "not_found" });
  },
};

/**
 * A page from the PAGES bucket: `/bingo/game/` is `bingo/game/index.html`, and `/bingo/game`
 * goes to `/bingo/game/`. Pages can be updated by putting new files in the bucket, no deploy
 * @param {R2Bucket} bucket
 * @param {URL} url
 */
async function servePage(bucket, url) {
  // Page paths are plain lowercase names, so anything encoded is simply not found
  const path = url.pathname;
  const notFound = () => new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  if (!/^(\/[a-z0-9_-]+)*\/?([a-z0-9_-]+\.html)?$/.test(path)) {
    return notFound();
  }
  if (!path.endsWith("/") && !path.endsWith(".html")) {
    const folder = await bucket.head(`${path.slice(1)}/index.html`);
    return folder ? Response.redirect(`${url.origin}${path}/${url.search}`, 301) : notFound();
  }
  const key = path.slice(1) + (path.endsWith("/") ? "index.html" : "");
  const object = await bucket.get(key);
  if (!object) {
    return notFound();
  }
  return new Response(object.body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
      ETag: object.httpEtag,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      // Other sites can't show the pages in a frame and trick a host into clicking
      "Content-Security-Policy": "frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
    },
  });
}

/**
 * BXT's socket: a join code or a session token picks the game and the player
 * Refusals are HTTP 403 with `{ "error": <code> }`, before the upgrade (BINGO.md §6)
 * @param {Request} request
 * @param {Env} env
 */
async function connectBxt(request, env) {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return json(426, { error: "expected a WebSocket upgrade" });
  }
  const code = request.headers.get(JOIN_HEADER);
  const session = request.headers.get(SESSION_HEADER);

  // Only these go through to the game, never the client's own headers
  const headers = new Headers({ Upgrade: "websocket" });
  let gameId;
  if (code) {
    // Codes are short, so guessing is limited per address
    const limited = env.CODE_LIMIT && !(await env.CODE_LIMIT.limit({ key: clientIp(request) })).success;
    if (limited) {
      return json(429, { error: "rate_limited" });
    }
    const redeemed = await redeemCode(env.DB, code);
    if ("error" in redeemed) {
      return json(403, { error: redeemed.error });
    }
    gameId = redeemed.gameId;
    headers.set("X-Bingo-Player", redeemed.steamid64);
    headers.set("X-Bingo-Token", newSessionToken(gameId));
  } else if (session) {
    gameId = session.split(".")[0];
    if (!/^[0-9a-f]{16}$/.test(gameId)) {
      return json(403, { error: "bad_session" });
    }
    headers.set("X-Bingo-Token", session);
  } else {
    return json(403, { error: "bad_code" });
  }

  const response = await game(env, gameId).fetch(new Request("https://game/bxt", { headers }));
  if (response.status === 404) {
    return json(403, { error: code ? "bad_code" : "bad_session" });
  }
  return response;
}

/**
 * @param {Request} request
 * @param {Env} env
 * @param {string[]} parts After /dev
 * @param {number} now
 */
async function devRoute(request, env, parts, now) {
  const method = request.method;

  // Signs in as anyone, for testing the pages without Steam. Only on this machine
  if (parts[0] === "login" && parts.length === 1 && method === "GET") {
    const url = new URL(request.url);
    const steamid64 = url.searchParams.get("steamid64") ?? "";
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || !/^\d{17}$/.test(steamid64)) {
      return json(400, { error: "bad_request", message: "needs steamid64 (17 digits), on localhost" });
    }
    const token = await startSession(env.DB, { steamid64, name: url.searchParams.get("name") || `Player ${steamid64.slice(-4)}`, avatar: null }, now);
    const back = url.searchParams.get("return") ?? "/bingo/";
    return new Response(null, {
      status: 302,
      headers: {
        Location: isLocalPath(back) || /^http:\/\/(localhost|127\.0\.0\.1)[:/][\x21-\x7e]*$/.test(back) ? back : "/bingo/",
        "Set-Cookie": cookie(SESSION_COOKIE, token, SESSION_LIFETIME_MS),
      },
    });
  }

  if (parts[0] === "files" && parts.length === 2 && method === "PUT") {
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_FILE_BYTES) {
      return json(413, { error: "too big" });
    }
    const hash = await sha256Hex(body);
    if (hash !== parts[1]) {
      return json(400, { error: `the file's SHA-256 is ${hash}` });
    }
    await env.FILES.put(hash, body);
    return json(200, { ok: true, sha256: hash, size: body.byteLength });
  }

  if (parts[0] !== "games" || method !== "POST") {
    return json(404, { error: "not_found" });
  }
  /** @type {any} */
  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "bad_request", message: "the body must be JSON" });
  }

  if (parts.length === 1) {
    const ruleset = Object.hasOwn(RULESETS, body.ruleset ?? "scriptless") ? RULESETS[body.ruleset ?? "scriptless"] : undefined;
    if (!ruleset || !Array.isArray(body.tiles)) {
      return json(400, { error: "bad_request", message: "needs tiles, and ruleset scriptless or scripted" });
    }
    const id = newGameId();
    const result = await game(env, id).create({
      id,
      settings: body.settings ?? {},
      tiles: body.tiles,
      ruleset,
      handicapPresets: PRESETS,
      extraFiles,
    });
    return result.error ? refused(result) : json(200, { id });
  }

  const id = parts[1];
  const stub = game(env, id);
  if (parts.length === 3 && parts[2] === "players") {
    const steamid64 = body.steamid64 ?? devSteamId();
    const result = await stub.action("add_player", { steamid64, name: body.name ?? "Player", team: body.team ?? null });
    if (result.error) {
      return refused(result);
    }
    return json(200, { steamid64, code: await issueCode(env.DB, id, steamid64) });
  }
  if (parts.length === 3 && parts[2] === "code") {
    const snapshot = await stub.snapshot();
    if (!snapshot?.lobby.players.some((p) => p.steamid64 === body.steamid64)) {
      return json(404, { error: "unknown_player" });
    }
    return json(200, { code: await issueCode(env.DB, id, body.steamid64) });
  }
  if (parts.length === 3) {
    const result = await stub.action(parts[2], body);
    return result.error ? refused(result) : json(200, result);
  }
  return json(404, { error: "not_found" });
}

/** A made-up SteamID64 for a test player, outside the range Steam uses for real accounts */
function devSteamId() {
  const digits = crypto.getRandomValues(new Uint8Array(10));
  return "7656110" + [...digits].map((d) => d % 10).join("");
}
