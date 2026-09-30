// The web side's pieces of the Worker: Steam sign-in checks, settings checks, sessions, join
// codes and game records (on an in-memory SQLite standing in for D1)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { ALL_TILES } from "../src/protocol/index.js";
import { Room } from "../src/room/index.js";
import { checkHandicapPresets } from "../src/rules/handicaps.js";

import { boardTiles, catalogPools, drawBoard } from "../worker/boards.js";
import { cookie, isAllowed, isLocalPath, isPageOrigin, isPrivate, readCookie, sameSecret, signedIn, startSession } from "../worker/auth.js";
import { CODE_LIFETIME_MS, issueCode, redeemCode } from "../worker/codes.js";
import { ensureSchema } from "../worker/db.js";
import { gameRecord, playerGames, writeGameRecord } from "../worker/records.js";
import { checkSettings } from "../worker/settings.js";
import { STEAM_OPENID, loginUrl, playerSummary, verifyLogin } from "../worker/steam.js";

const NOW = Date.parse("2026-09-29T12:00:00Z");
const PLAYER = "76561190000000011";
const RETURN_TO = "https://bingo.example/auth/steam/callback?state=abc";

// node:sqlite is newer than Node 22.0, so these tests skip without it
/** @type {any} */
const sqlite = await import("node:sqlite").catch(() => null);

/**
 * The parts of D1 the Worker uses, on node:sqlite
 * @returns {any}
 */
function fakeD1() {
  const db = new sqlite.DatabaseSync(":memory:");
  /**
   * @param {string} sql
   * @param {unknown[]} args
   */
  const statement = (sql, args = []) => ({
    bind: (/** @type {unknown[]} */ ...values) => statement(sql, values),
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    runNow: () => db.prepare(sql).run(...args),
  });
  return {
    prepare: (/** @type {string} */ sql) => statement(sql),
    batch: async (/** @type {any[]} */ list) => list.map((s) => s.runNow()),
  };
}

/**
 * Steam's answer as it comes back to the callback
 * @param {Record<string, string>} [change]
 */
function answer(change = {}) {
  const id = `https://steamcommunity.com/openid/id/${PLAYER}`;
  return new URLSearchParams({
    state: "abc",
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "id_res",
    "openid.op_endpoint": STEAM_OPENID,
    "openid.claimed_id": id,
    "openid.identity": id,
    "openid.return_to": RETURN_TO,
    "openid.response_nonce": "2026-09-29T11:59:30ZdJ3uvUPkIcvmZ8iaRSUW8kdxLHg=",
    "openid.assoc_handle": "1234567890",
    "openid.signed": "signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle",
    "openid.sig": "c2lnbmF0dXJl",
    ...change,
  });
}

/**
 * A fetch that answers like Steam's check_authentication, and records what it was sent
 * @param {string} reply
 */
function fakeSteam(reply = "ns:http://specs.openid.net/auth/2.0\nis_valid:true\n") {
  /** @type {{ url: string, body: URLSearchParams }[]} */
  const calls = [];
  /** @type {any} */
  const fetchFn = async (/** @type {string} */ url, /** @type {any} */ init) => {
    calls.push({ url, body: new URLSearchParams(init.body) });
    return new Response(reply);
  };
  return { fetchFn, calls };
}

test("the sign-in link asks Steam to pick the account and come back to us", () => {
  const url = new URL(loginUrl(RETURN_TO, "https://bingo.example"));
  assert.equal(url.origin + url.pathname, STEAM_OPENID);
  assert.equal(url.searchParams.get("openid.mode"), "checkid_setup");
  assert.equal(url.searchParams.get("openid.return_to"), RETURN_TO);
  assert.equal(url.searchParams.get("openid.realm"), "https://bingo.example");
  assert.equal(url.searchParams.get("openid.claimed_id"), "http://specs.openid.net/auth/2.0/identifier_select");
});

test("a good answer is confirmed with Steam, with only the openid fields and the mode changed", async () => {
  const steam = fakeSteam();
  const check = await verifyLogin(answer(), RETURN_TO, NOW, steam.fetchFn);
  assert.deepEqual(check, { steamid64: PLAYER, nonce: "2026-09-29T11:59:30ZdJ3uvUPkIcvmZ8iaRSUW8kdxLHg=" });
  assert.equal(steam.calls.length, 1);
  assert.equal(steam.calls[0].url, STEAM_OPENID);
  assert.equal(steam.calls[0].body.get("openid.mode"), "check_authentication");
  assert.equal(steam.calls[0].body.get("openid.sig"), "c2lnbmF0dXJl");
  assert.equal(steam.calls[0].body.get("state"), null);
});

test("answers Steam doesn't confirm, or that were changed on the way, are refused", async () => {
  const cases = [
    [answer(), "ns:http://specs.openid.net/auth/2.0\nis_valid:false\n", "not_confirmed"],
    [answer({ "openid.return_to": "https://evil.example/auth/steam/callback?state=abc" }), undefined, "bad_answer"],
    [answer({ "openid.op_endpoint": "https://evil.example/openid/login" }), undefined, "bad_answer"],
    [answer({ "openid.claimed_id": "https://evil.example/openid/id/76561190000000011" }), undefined, "bad_answer"],
    [answer({ "openid.claimed_id": "https://steamcommunity.com/openid/id/123" }), undefined, "bad_answer"],
    [answer({ "openid.identity": "https://steamcommunity.com/openid/id/76561190000000000" }), undefined, "bad_answer"],
    [answer({ "openid.signed": "signed,op_endpoint,identity,return_to,response_nonce" }), undefined, "bad_answer"],
    [answer({ "openid.response_nonce": "2026-09-29T11:50:00Zold" }), undefined, "too_old"],
    [answer({ "openid.response_nonce": "garbage" }), undefined, "bad_answer"],
    [answer({ "openid.mode": "cancel" }), undefined, "cancelled"],
  ];
  for (const [params, reply, error] of cases) {
    const steam = fakeSteam(reply);
    const check = await verifyLogin(/** @type {URLSearchParams} */ (params), RETURN_TO, NOW, steam.fetchFn);
    assert.deepEqual(check, { error }, `expected ${error}`);
  }
});

test("a field given twice is refused before asking Steam", async () => {
  const params = answer();
  params.append("openid.claimed_id", "https://steamcommunity.com/openid/id/76561190000000000");
  const steam = fakeSteam();
  assert.deepEqual(await verifyLogin(params, RETURN_TO, NOW, steam.fetchFn), { error: "bad_answer" });
  assert.equal(steam.calls.length, 0);
});

test("Steam being down is its own error", async () => {
  /** @type {any} */
  const down = async () => {
    throw new Error("offline");
  };
  assert.deepEqual(await verifyLogin(answer(), RETURN_TO, NOW, down), { error: "steam_unreachable" });
});

test("Steam names and avatars: only Steam's own image addresses", async () => {
  /** @param {any} player */
  const api = (player) => /** @type {any} */ (async () => Response.json({ response: { players: [player] } }));
  const good = await playerSummary(PLAYER, "key", api({ steamid: PLAYER, personaname: "jriiik", avatarfull: "https://avatars.steamstatic.com/abc_full.jpg" }));
  assert.deepEqual(good, { name: "jriiik", avatar: "https://avatars.steamstatic.com/abc_full.jpg" });
  const odd = await playerSummary(PLAYER, "key", api({ steamid: PLAYER, personaname: "x", avatarfull: "https://evil.example/a.jpg" }));
  assert.equal(odd?.avatar, null);
  assert.equal(await playerSummary(PLAYER, "key", api({ steamid: "76561190000000000", personaname: "x" })), null);
  assert.equal(await playerSummary(PLAYER, undefined, api({})), null);
});

test("settings from the create page are checked key by key", () => {
  assert.deepEqual(checkSettings({}), {});
  assert.deepEqual(checkSettings({ timeLimitMs: 900_000, suddenDeathMs: null, tiebreakers: ["total_time", "steals"], lockout: true }), {
    timeLimitMs: 900_000,
    suddenDeathMs: null,
    tiebreakers: ["total_time", "steals"],
    lockout: true,
  });
  for (const bad of [
    null,
    [],
    { timeLimitMs: 5 },
    { timeLimitMs: 1.5 * 60_000 + 0.5 },
    { timeLimitMs: "900000" },
    { suddenDeathMs: 0 },
    { tiebreakers: ["total_time", "total_time"] },
    { tiebreakers: ["coin_flip"] },
    { countdownMs: 100 },
    { maxPlayers: 100 },
    { lockout: "yes" },
    { teamColors: { red: "#ff0000" } },
    { __proto__: { lockout: true }, extra: 1 },
  ]) {
    assert.equal(typeof checkSettings(bad), "string", JSON.stringify(bad));
  }
});

test("cookies and secrets", () => {
  const request = new Request("https://bingo.example/", { headers: { Cookie: "a=1; __Host-bingo_session=tok; b=2" } });
  assert.equal(readCookie(request, "__Host-bingo_session"), "tok");
  assert.equal(readCookie(request, "c"), null);
  assert.equal(cookie("n", "v", 60_000), "n=v; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=60");
  assert.ok(sameSecret("abc", "abc"));
  assert.ok(!sameSecret("abc", "abd"));
  assert.ok(!sameSecret("abc", "abcd"));
});

test("the private test server lets only the listed players in", () => {
  const env = { PRIVATE: "true", ALLOWED_STEAMIDS: `${PLAYER}, 76561190000000012` };
  assert.ok(isPrivate(env));
  assert.ok(isAllowed(env, PLAYER));
  assert.ok(isAllowed(env, "76561190000000012"));
  assert.ok(!isAllowed(env, "76561190000000000"));
  // Private with nobody listed lets nobody in
  assert.ok(!isAllowed({ PRIVATE: "true" }, PLAYER));
  assert.ok(!isPrivate({}));
  assert.ok(isAllowed({}, "76561190000000000"));
});

test("pages that may call the routes", () => {
  const request = new Request("https://bingo.example/api/me");
  const env = { PAGE_ORIGINS: "https://jrik.dev" };
  assert.ok(isPageOrigin(request, env, "https://bingo.example"));
  assert.ok(isPageOrigin(request, env, "https://jrik.dev"));
  assert.ok(!isPageOrigin(request, env, "https://evil.example"));
  assert.ok(!isPageOrigin(request, env, null));
  assert.ok(!isPageOrigin(request, env, "null"));
  assert.ok(!isPageOrigin(request, env, "http://localhost:8765"));
  assert.ok(isPageOrigin(request, { DEV_ROUTES: "true" }, "http://localhost:8765"));
  assert.ok(isPageOrigin(request, { DEV_ROUTES: "true" }, "null"));
});

test("after signing in, only paths on this site", () => {
  assert.ok(isLocalPath("/bingo/"));
  assert.ok(isLocalPath("/bingo/game/?id=0123456789abcdef&view=stream"));
  assert.ok(!isLocalPath("//evil.example/"));
  assert.ok(!isLocalPath("/\\evil.example/"));
  // Browsers drop tabs and line breaks from addresses: these would be //evil.example
  assert.ok(!isLocalPath("/\t/evil.example/"));
  assert.ok(!isLocalPath("/\n/evil.example/"));
  assert.ok(!isLocalPath("/ /evil.example/"));
  assert.ok(!isLocalPath("https://evil.example/"));
  assert.ok(!isLocalPath(""));
});

test("sessions: the cookie's token finds the player until it expires", { skip: !sqlite && "needs node:sqlite" }, async () => {
  const db = fakeD1();
  const token = await startSession(db, { steamid64: PLAYER, name: "jriiik", avatar: null }, NOW);
  const env = { DB: db };
  const withCookie = (/** @type {string} */ t) => new Request("https://bingo.example/", { headers: { Cookie: `__Host-bingo_session=${t}` } });
  assert.deepEqual({ ...(await signedIn(withCookie(token), env, NOW + 1000)) }, { steamid64: PLAYER, name: "jriiik", avatar: null });
  assert.equal(await signedIn(withCookie("wrong"), env, NOW), null);
  assert.equal(await signedIn(withCookie(token), env, NOW + 31 * 24 * 3600_000), null);
  // Taken off the private server's list: signed out
  assert.equal(await signedIn(withCookie(token), { DB: db, PRIVATE: "true", ALLOWED_STEAMIDS: "76561190000000012" }, NOW), null);
  // A new sign-in refreshes the name
  await startSession(db, { steamid64: PLAYER, name: "jriiik2", avatar: null }, NOW + 5000);
  assert.equal((await signedIn(withCookie(token), env, NOW + 6000))?.name, "jriiik2");
});

test("join codes work once, for 10 minutes, typed in any case", { skip: !sqlite && "needs node:sqlite" }, async () => {
  const db = fakeD1();
  const code = await issueCode(db, "0123456789abcdef", PLAYER, NOW);
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{2}$/);
  assert.deepEqual(await redeemCode(db, ` ${code.toLowerCase()} `, NOW + 1000), { gameId: "0123456789abcdef", steamid64: PLAYER });
  assert.deepEqual(await redeemCode(db, code, NOW + 2000), { error: "bad_code" });
  const late = await issueCode(db, "0123456789abcdef", PLAYER, NOW);
  assert.deepEqual(await redeemCode(db, late, NOW + CODE_LIFETIME_MS + 1), { error: "code_expired" });
  assert.deepEqual(await redeemCode(db, "AAAA-AA", NOW), { error: "bad_code" });
});

// Game records

const scriptless = JSON.parse(readFileSync(new URL("../rules/won-scriptless.json", import.meta.url), "utf8"));
const presets = checkHandicapPresets(JSON.parse(readFileSync(new URL("../rules/handicaps.json", import.meta.url), "utf8")));
const RED = "76561190000000021";
const BLUE = "76561190000000022";
const SPECTATOR = "76561190000000023";
const T0 = 1_800_000_000_000;
const MIN_MS = 60_000;

/** @param {number} i */
const sha = (i) => i.toString(16).padStart(64, "0");

/** A room with red and blue ready, and a player off the teams */
function recordedRoom(/** @type {string} */ id) {
  const tiles = ALL_TILES.map((tile, i) => ({
    id: tile,
    segment: {
      id: `seg-${i}`,
      label: `S${i}`,
      chapter: "Test",
      saves: { won: { sha256: sha(i + 1), size: 1000 } },
      start: { type: /** @type {const} */ ("trigger"), corners: /** @type {[[number, number, number], [number, number, number]]} */ ([[0, 0, 0], [1, 1, 1]]) },
      end: { corners: /** @type {[[number, number, number], [number, number, number]]} */ ([[2, 2, 2], [3, 3, 3]]) },
      reference_time_ms: 10_000,
    },
  }));
  const room = new Room({ id, settings: {}, tiles, ruleset: scriptless, handicapPresets: presets });
  for (const [player, team] of /** @type {const} */ ([[RED, "red"], [BLUE, "blue"]])) {
    room.addPlayer({ steamid64: player, name: team, team });
    room.setConnected(player, true);
    room.hello(player, { type: "hello", protocol: 1, bxt_version: "t", engine_build: "won", dll_sha256: null, steamid64: null }, "tok", T0 - 10_000);
    room.onMessage(player, { type: "ready", manifest_hash: room.manifestFor(player).manifest_hash }, T0 - 10_000);
  }
  room.addPlayer({ steamid64: SPECTATOR, name: "watching", team: null });
  let next = 1;
  /**
   * A run finishing `at` ms after T0
   * @param {string} player
   * @param {string} tile
   * @param {number} at
   */
  const run = (player, tile, at) => {
    const attempt_id = `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`;
    room.onMessage(player, { type: "attempt_started", attempt_id, tile }, T0 + at - 9800);
    const result = { type: /** @type {const} */ ("attempt_result"), attempt_id, tile, time_ms: 9800, server_time_delta_ms: 9800, frames: 100, real_ms: 9800, load_ms: 0, save_sha256: sha(ALL_TILES.indexOf(tile) + 1), ruleset_ok: true, demo: null };
    room.onMessage(player, result, T0 + at);
    return attempt_id;
  };
  return { room, run };
}

/**
 * @param {any} db
 * @param {string} sql
 * @param {unknown[]} args
 */
const rows = async (db, sql, ...args) => (await db.prepare(sql).bind(...args).all()).results;

test("a game's record: lobby, running, finished with its results, reopened by a void", { skip: !sqlite && "needs node:sqlite" }, async () => {
  const db = fakeD1();
  await ensureSchema(db);
  await db.prepare("INSERT INTO games (id, host, created, board, ruleset) VALUES (?, ?, ?, ?, ?)").bind("0123456789abcdef", RED, T0 - MIN_MS, "scriptless", "scriptless").run();
  const { room, run } = recordedRoom("0123456789abcdef");

  let record = gameRecord(room, T0 - 10_000);
  assert.equal(record.state, "lobby");
  assert.equal(record.started, null);
  assert.equal(record.results, null);
  await writeGameRecord(db, record);
  assert.deepEqual(
    (await rows(db, "SELECT steamid64, team, handicaps FROM game_players ORDER BY steamid64")).map((/** @type {any} */ r) => ({ ...r })),
    [
      { steamid64: RED, team: "red", handicaps: "[]" },
      { steamid64: BLUE, team: "blue", handicaps: "[]" },
      { steamid64: SPECTATOR, team: null, handicaps: "[]" },
    ],
  );

  room.start(T0 - 5000, false);
  room.tick(T0);
  run(BLUE, "C3", 15_000);
  let last = "";
  for (const [i, tile] of ["A1", "B1", "C1", "D1", "E1"].entries()) {
    last = run(RED, tile, 20_000 + i * 20_000);
  }
  record = gameRecord(room, T0 + 200_000);
  assert.equal(record.state, "finished");
  assert.equal(record.started, T0);
  assert.equal(record.finished, T0 + 100_000);
  assert.deepEqual([record.winner, record.reason, record.line], ["red", "line", "A1 B1 C1 D1 E1"]);
  assert.deepEqual(record.tiles, { red: 5, blue: 1 });
  assert.deepEqual(record.leaderboards, { players: "standard", segments: "scriptless" });
  await writeGameRecord(db, record);
  const game = /** @type {any} */ (await db.prepare("SELECT * FROM games").first());
  assert.deepEqual(
    [game.state, game.started, game.finished, game.winner, game.reason, game.line, game.red_tiles, game.blue_tiles, game.player_board, game.segment_board],
    ["finished", T0, T0 + 100_000, "red", "line", "A1 B1 C1 D1 E1", 5, 1, "standard", "scriptless"],
  );
  const results = await rows(db, "SELECT steamid64, tile, segment, time_ms, verdict, voided, flagged, accepted FROM results ORDER BY at_ms");
  assert.equal(results.length, 6);
  assert.deepEqual({ ...results[0] }, { steamid64: BLUE, tile: "C3", segment: "seg-12", time_ms: 9800, verdict: "captured", voided: 0, flagged: 0, accepted: 0 });

  // The host voids the winning run: the game goes on, and its results wait for the new ending
  room.void(last, T0 + 210_000);
  await writeGameRecord(db, gameRecord(room, T0 + 210_000));
  const reopened = /** @type {any} */ (await db.prepare("SELECT state, finished, winner FROM games").first());
  assert.deepEqual({ ...reopened }, { state: "running", finished: null, winner: null });
  assert.equal((await rows(db, "SELECT * FROM results")).length, 0);
});

test("a game the host ends in the lobby never ran; games made without the pages aren't recorded", { skip: !sqlite && "needs node:sqlite" }, async () => {
  const db = fakeD1();
  await ensureSchema(db);
  const { room } = recordedRoom("fedcba9876543210");
  room.end(T0);
  const record = gameRecord(room, T0);
  assert.deepEqual([record.state, record.started, record.finished, record.winner, record.reason], ["finished", null, null, null, "host_ended"]);
  // No games row (a dev game): nothing is written for it
  await writeGameRecord(db, record);
  assert.equal((await rows(db, "SELECT * FROM game_players")).length, 0);
});

test("a player's games: the ones they host or are in, newest first", { skip: !sqlite && "needs node:sqlite" }, async () => {
  const db = fakeD1();
  await ensureSchema(db);
  const add = (/** @type {string} */ id, /** @type {string} */ host, /** @type {number} */ created) =>
    db.prepare("INSERT INTO games (id, host, created, board, ruleset) VALUES (?, ?, ?, ?, ?)").bind(id, host, created, "scriptless", "scriptless").run();
  await add("000000000000000a", RED, T0);
  await add("000000000000000b", BLUE, T0 + 1000);
  await add("000000000000000c", BLUE, T0 + 2000);
  const { room } = recordedRoom("000000000000000b");
  await writeGameRecord(db, gameRecord(room, T0));

  const mine = await playerGames(db, RED, 50);
  assert.deepEqual(
    mine.map((g) => [g.id, g.host, g.joined, g.team, g.players]),
    [
      ["000000000000000b", false, true, "red", 3],
      ["000000000000000a", true, false, null, 0],
    ],
  );
  assert.deepEqual((await playerGames(db, BLUE, 50)).map((g) => g.id), ["000000000000000c", "000000000000000b"]);
  assert.deepEqual((await playerGames(db, BLUE, 1)).map((g) => g.id), ["000000000000000c"]);
  assert.deepEqual(await playerGames(db, "76561190000000099", 50), []);
});

const catalog = JSON.parse(readFileSync(new URL("../catalog/hl1.json", import.meta.url), "utf8"));

test("random boards: 25 different segments from the pools ticked, a game can be made with them", () => {
  assert.deepEqual(catalogPools(catalog), [{ id: "hl1", name: "Half-Life campaign", game: "valve", segments: catalog.length }]);
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const drawn = drawBoard(catalog, ["hl1"]);
    assert.ok("tiles" in drawn);
    assert.deepEqual(drawn.tiles.map((t) => t.id), ALL_TILES);
    assert.equal(new Set(drawn.tiles.map((t) => t.segment.id)).size, 25);
    drawn.tiles.forEach((t) => seen.add(t.segment.id));
    if (i === 0) {
      const room = new Room({ id: "00000000000000aa", settings: {}, tiles: drawn.tiles, ruleset: scriptless, handicapPresets: presets });
      assert.equal(room.gameFolder, "valve");
      assert.ok(room.tileInfo().every((t) => t.label && t.segment && t.chapter));
    }
  }
  // Random: 50 boards of 25 reach far more than 25 segments, and the catalog isn't reordered
  assert.ok(seen.size > 150, `only ${seen.size} segments in 50 boards`);
  assert.equal(catalog[0].id, "am-2-0");
  // The same numbers, the same board
  const fixed = () => drawBoard(catalog, ["hl1"], (n) => n - 1);
  assert.deepEqual(fixed(), fixed());
});

test("random boards: pools checked", () => {
  for (const pools of [undefined, null, "hl1", [], [1], ["hl1", 2], Array(21).fill("hl1")]) {
    assert.equal(/** @type {any} */ (drawBoard(catalog, pools)).error, "pools must be a list of pool ids");
  }
  assert.match(/** @type {any} */ (drawBoard(catalog, ["hl1", "opfor"])).error, /^pools must be some of hl1$/);
  assert.match(/** @type {any} */ (drawBoard(catalog, ["__proto__"])).error, /^pools must be some of/);
  const small = catalog.slice(0, 24);
  assert.equal(/** @type {any} */ (drawBoard(small, ["hl1"])).error, "these pools have 24 segments, a board needs 25");
  const mixed = [...catalog.slice(0, 30), ...catalog.slice(30, 60).map((s) => ({ ...s, pool: "opfor", game: "gearbox" }))];
  assert.equal(/** @type {any} */ (drawBoard(mixed, ["hl1", "opfor"])).error, "pools of different games can't be on one board");
  assert.ok("tiles" in drawBoard(mixed, ["opfor"]));
  // Pools of one game mix
  const hazard = [...catalog.slice(0, 10), ...catalog.slice(10, 30).map((s) => ({ ...s, pool: "hazard-course" }))];
  const both = drawBoard(hazard, ["hl1", "hazard-course"]);
  assert.ok("tiles" in both && both.tiles.length === 25);
});

test("test boards: tiles the catalog has are its segments", () => {
  for (const name of ["scriptless", "scripted"]) {
    const manifest = JSON.parse(readFileSync(new URL(`../boards/${name}.json`, import.meta.url), "utf8"));
    const tiles = boardTiles(manifest, catalog);
    assert.equal(tiles.length, 25);
    tiles.forEach((t, i) => {
      assert.equal(t.id, manifest.tiles[i].id);
      assert.equal(t.segment.label, manifest.tiles[i].label);
      assert.ok(catalog.includes(t.segment), `${t.id} ${t.segment.label} not from the catalog`);
    });
    // Without a catalog: made up from the tile, as dev-game does
    const bare = boardTiles(manifest, []);
    assert.deepEqual(bare[0].segment, {
      id: manifest.tiles[0].label.toLowerCase(),
      label: manifest.tiles[0].label,
      chapter: "",
      game: "valve",
      saves: { won: manifest.tiles[0].save },
      start: manifest.tiles[0].start,
      end: manifest.tiles[0].end,
      reference_time_ms: null,
    });
  }
});
