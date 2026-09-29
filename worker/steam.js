// Signing in through Steam (OpenID 2.0) and reading a player's Steam name and avatar
// (BINGO-WEB.md §3.1, §11). Steam's answer comes through the player's browser, so nothing in it
// is trusted until Steam itself confirms it (check_authentication)

export const STEAM_OPENID = "https://steamcommunity.com/openid/login";
const OPENID_NS = "http://specs.openid.net/auth/2.0";
const IDENTIFIER_SELECT = "http://specs.openid.net/auth/2.0/identifier_select";
const CLAIMED_ID = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;
// Steam signs these, and the answer is only worth anything if they're among the signed fields
const MUST_BE_SIGNED = ["op_endpoint", "claimed_id", "identity", "return_to", "response_nonce"];
// An answer older than this is refused, and its nonce is remembered at least this long
export const NONCE_MAX_AGE_MS = 5 * 60_000;

/**
 * Where to send the player to sign in
 * @param {string} returnTo Our callback, exactly as it must come back
 * @param {string} realm Our origin
 */
export function loginUrl(returnTo, realm) {
  const query = new URLSearchParams({
    "openid.ns": OPENID_NS,
    "openid.mode": "checkid_setup",
    "openid.return_to": returnTo,
    "openid.realm": realm,
    "openid.identity": IDENTIFIER_SELECT,
    "openid.claimed_id": IDENTIFIER_SELECT,
  });
  return `${STEAM_OPENID}?${query}`;
}

/**
 * @typedef {{ steamid64: string, nonce: string } | { error: "cancelled" | "bad_answer" | "too_old" | "not_confirmed" | "steam_unreachable" }} LoginCheck
 */

/**
 * Checks Steam's answer, as it arrived at our callback
 * @param {URLSearchParams} params The callback's query
 * @param {string} expectedReturnTo The return_to we sent, which the answer must repeat exactly
 * @param {number} now Unix ms
 * @param {typeof fetch} [fetchFn] For tests
 * @returns {Promise<LoginCheck>}
 */
export async function verifyLogin(params, expectedReturnTo, now, fetchFn = fetch) {
  const openid = [...params].filter(([key]) => key.startsWith("openid."));
  // A field given twice could be read one way here and another way by Steam
  if (new Set(openid.map(([key]) => key)).size !== openid.length) {
    return { error: "bad_answer" };
  }
  const field = (/** @type {string} */ name) => params.get(`openid.${name}`);
  if (field("mode") === "cancel") {
    return { error: "cancelled" };
  }
  if (field("mode") !== "id_res" || field("ns") !== OPENID_NS || field("op_endpoint") !== STEAM_OPENID) {
    return { error: "bad_answer" };
  }
  if (field("return_to") !== expectedReturnTo) {
    return { error: "bad_answer" };
  }
  const claimedId = field("claimed_id") ?? "";
  const match = CLAIMED_ID.exec(claimedId);
  if (!match || field("identity") !== claimedId) {
    return { error: "bad_answer" };
  }
  const signed = (field("signed") ?? "").split(",");
  if (!MUST_BE_SIGNED.every((name) => signed.includes(name))) {
    return { error: "bad_answer" };
  }
  // The nonce starts with the time Steam made the answer, e.g. 2026-09-29T12:34:56Z
  const nonce = field("response_nonce") ?? "";
  const made = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)/.exec(nonce);
  const madeAt = made ? Date.parse(made[1]) : NaN;
  if (!Number.isFinite(madeAt) || nonce.length > 256) {
    return { error: "bad_answer" };
  }
  if (now - madeAt > NONCE_MAX_AGE_MS || madeAt - now > 60_000) {
    return { error: "too_old" };
  }

  // Steam confirms its own answer: the same fields, with the mode changed
  const body = new URLSearchParams(openid);
  body.set("openid.mode", "check_authentication");
  let text;
  try {
    const response = await fetchFn(STEAM_OPENID, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!response.ok) {
      return { error: "steam_unreachable" };
    }
    text = await response.text();
  } catch {
    return { error: "steam_unreachable" };
  }
  if (!/^is_valid:true$/m.test(text)) {
    return { error: "not_confirmed" };
  }
  return { steamid64: match[1], nonce };
}

/**
 * A player's Steam name and avatar, or null (no API key, Steam unreachable, private profile...)
 * @param {string} steamid64
 * @param {string | undefined} apiKey The Steam Web API key, a Worker secret
 * @param {typeof fetch} [fetchFn] For tests
 * @returns {Promise<{ name: string, avatar: string | null } | null>}
 */
export async function playerSummary(steamid64, apiKey, fetchFn = fetch) {
  if (!apiKey) {
    return null;
  }
  const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(apiKey)}&steamids=${steamid64}`;
  try {
    const response = await fetchFn(url);
    if (!response.ok) {
      return null;
    }
    /** @type {any} */
    const data = await response.json();
    const player = data?.response?.players?.[0];
    if (!player || player.steamid !== steamid64 || typeof player.personaname !== "string") {
      return null;
    }
    // Only Steam's own image addresses end up on the pages
    const avatar = typeof player.avatarfull === "string" && /^https:\/\/avatars\.([a-z]+\.)?steamstatic\.com\/[\w./-]+$/.test(player.avatarfull) ? player.avatarfull : null;
    return { name: player.personaname, avatar };
  } catch {
    return null;
  }
}
