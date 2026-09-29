// Personal join codes in D1 (BINGO-WEB.md §3.2): single use, valid for 10 minutes, for one
// player of one game, stored only as hashes. The join page makes them, BXT redeems them at /bxt

import { ensureSchema } from "./db.js";
import { newJoinCode, normalizeJoinCode, sha256Hex } from "./secrets.js";

export const CODE_LIFETIME_MS = 10 * 60_000;

/**
 * A new code for a player of a game. Older unused codes of theirs for it stay valid until they expire
 * @param {D1Database} db
 * @param {string} gameId
 * @param {string} steamid64
 * @param {number} [now]
 */
export async function issueCode(db, gameId, steamid64, now = Date.now()) {
  await ensureSchema(db);
  const code = newJoinCode();
  await db
    .prepare("INSERT INTO join_codes (code_hash, game_id, steamid64, expires) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(code), gameId, steamid64, now + CODE_LIFETIME_MS)
    .run();
  return code;
}

/**
 * Uses a code up. Two BXTs sending the same code at once: only one gets it
 * @param {D1Database} db
 * @param {string} code
 * @param {number} [now]
 * @returns {Promise<{ gameId: string, steamid64: string } | { error: "bad_code" | "code_expired" }>}
 */
export async function redeemCode(db, code, now = Date.now()) {
  await ensureSchema(db);
  const hash = await sha256Hex(normalizeJoinCode(code));
  // Marking it used is the check: only an unused code changes
  /** @type {{ game_id: string, steamid64: string } | null} */
  const used = await db
    .prepare("UPDATE join_codes SET used = 1 WHERE code_hash = ? AND used = 0 AND expires >= ? RETURNING game_id, steamid64")
    .bind(hash, now)
    .first();
  if (!used) {
    const row = await db.prepare("SELECT used, expires FROM join_codes WHERE code_hash = ?").bind(hash).first();
    return { error: row && !row.used && Number(row.expires) < now ? "code_expired" : "bad_code" };
  }
  return { gameId: used.game_id, steamid64: used.steamid64 };
}
