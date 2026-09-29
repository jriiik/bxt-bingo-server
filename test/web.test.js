// The web side's pieces of the Worker: Steam sign-in checks, settings checks, sessions and join
// codes (on an in-memory SQLite standing in for D1)

import assert from "node:assert/strict";
import { test } from "node:test";

import { cookie, isAllowed, isLocalPath, isPageOrigin, isPrivate, readCookie, sameSecret, signedIn, startSession } from "../worker/auth.js";
import { CODE_LIFETIME_MS, issueCode, redeemCode } from "../worker/codes.js";
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
