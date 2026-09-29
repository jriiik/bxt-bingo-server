// Games in D1 as they go (BINGO.md §11, BINGO-WEB.md §7.3): each game's state and ending, who is
// in it on which team, and once it's finished every result. The players' game lists read it now,
// the leaderboards later. The game (GameRoom) writes its record after each change that alters it

import { ensureSchema } from "./db.js";

/**
 * @typedef {object} GameRecord
 * @property {string} id
 * @property {string} state lobby, countdown, running or finished
 * @property {number | null} started When the clock started, unix ms. Null if it never ran
 * @property {number | null} finished When it ended, unix ms. Null if it isn't over or never ran
 * @property {string | null} winner red or blue, null for a draw or a game the host ended
 * @property {string | null} reason How it ended (game_over's reason)
 * @property {string | null} tiebreaker
 * @property {string | null} line The winning line's tiles, e.g. "A1 B2 C3 D4 E5"
 * @property {{ red: number, blue: number }} tiles The tiles each team holds
 * @property {{ players: string, segments: string }} leaderboards Which ones it counts for
 * @property {{ steamid64: string, team: string | null, handicaps: string[] }[]} players
 * @property {GameResult[] | null} results Only once it's finished
 */

/**
 * @typedef {object} GameResult
 * @property {string} attempt_id
 * @property {string} steamid64
 * @property {string} team
 * @property {string} tile
 * @property {string} segment
 * @property {number} time_ms
 * @property {number} at_ms On the game's clock
 * @property {string | null} verdict
 * @property {boolean} voided
 * @property {boolean} flagged Waits for the host's review, or did
 * @property {boolean} accepted The host accepted it
 */

/**
 * What goes into D1 for a game, as it is now
 * @param {import("../src/room/room.js").Room} room
 * @param {number} now
 * @returns {GameRecord}
 */
export function gameRecord(room, now) {
  const snapshot = room.snapshot(now);
  const ending = room.state === "finished" ? room.game.ending : null;
  // A game the host ended in the lobby or the countdown never ran
  const ran = room.startsAt !== null && (room.state === "running" || (ending !== null && (ending.reason !== "host_ended" || ending.atMs > 0)));
  const tiles = { red: 0, blue: 0 };
  for (const tile of snapshot.board.tiles) {
    if (tile.owner === "red" || tile.owner === "blue") {
      tiles[tile.owner]++;
    }
  }
  return {
    id: room.id,
    state: room.state,
    started: ran ? room.startsAt : null,
    finished: ran && ending && room.startsAt !== null ? room.startsAt + ending.atMs : null,
    winner: ending?.winner ?? null,
    reason: ending?.reason ?? null,
    tiebreaker: ending?.tiebreaker ?? null,
    line: ending?.line ? ending.line.join(" ") : null,
    tiles,
    leaderboards: snapshot.leaderboards,
    players: Object.values(room.players).map((p) => ({ steamid64: p.steamid64, team: p.team, handicaps: [...p.handicaps] })),
    results: ending
      ? snapshot.results.map((r) => ({
          attempt_id: r.attempt_id,
          steamid64: r.steamid64,
          team: r.team,
          tile: r.tile,
          segment: r.segment,
          time_ms: r.time_ms,
          at_ms: r.at_ms,
          verdict: r.verdict,
          voided: r.voided,
          flagged: r.review !== null,
          accepted: r.review?.accepted === true,
        }))
      : null,
  };
}

// Only games made through the pages have a row in games, so the rows below are only written for those
const IF_GAME = "WHERE EXISTS (SELECT 1 FROM games WHERE id = ?1)";

/**
 * Writes a game's record: its row, its players, and its results (none until it's finished)
 * @param {D1Database} db
 * @param {GameRecord} record
 */
export async function writeGameRecord(db, record) {
  await ensureSchema(db);
  const id = record.id;
  await db.batch([
    db
      .prepare(
        `UPDATE games SET state = ?2, started = ?3, finished = ?4, winner = ?5, reason = ?6, tiebreaker = ?7, line = ?8,
           red_tiles = ?9, blue_tiles = ?10, player_board = ?11, segment_board = ?12 WHERE id = ?1`,
      )
      .bind(
        id,
        record.state,
        record.started,
        record.finished,
        record.winner,
        record.reason,
        record.tiebreaker,
        record.line,
        record.tiles.red,
        record.tiles.blue,
        record.leaderboards.players,
        record.leaderboards.segments,
      ),
    db.prepare("DELETE FROM game_players WHERE game_id = ?1").bind(id),
    ...record.players.map((p) =>
      db
        .prepare(`INSERT INTO game_players (game_id, steamid64, team, handicaps) SELECT ?1, ?2, ?3, ?4 ${IF_GAME}`)
        .bind(id, p.steamid64, p.team, JSON.stringify(p.handicaps)),
    ),
    db.prepare("DELETE FROM results WHERE game_id = ?1").bind(id),
    ...(record.results ?? []).map((r) =>
      db
        .prepare(
          `INSERT INTO results (game_id, attempt_id, steamid64, team, tile, segment, time_ms, at_ms, verdict, voided, flagged, accepted)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12 ${IF_GAME}`,
        )
        .bind(id, r.attempt_id, r.steamid64, r.team, r.tile, r.segment, r.time_ms, r.at_ms, r.verdict, r.voided ? 1 : 0, r.flagged ? 1 : 0, r.accepted ? 1 : 0),
    ),
  ]);
}

/**
 * The games a player hosts or is in, newest first
 * @param {D1Database} db
 * @param {string} steamid64
 * @param {number} limit
 */
export async function playerGames(db, steamid64, limit) {
  await ensureSchema(db);
  const { results } = await db
    .prepare(
      `SELECT g.id AS id, g.created AS created, g.board AS board, g.state AS state, g.started AS started,
         g.finished AS finished, g.winner AS winner, g.reason AS reason, g.red_tiles AS red_tiles,
         g.blue_tiles AS blue_tiles, g.host = ?1 AS hosting, me.steamid64 IS NOT NULL AS joined, me.team AS team,
         (SELECT COUNT(*) FROM game_players p WHERE p.game_id = g.id) AS players
       FROM games g LEFT JOIN game_players me ON me.game_id = g.id AND me.steamid64 = ?1
       WHERE g.id IN (SELECT id FROM games WHERE host = ?1 UNION SELECT game_id FROM game_players WHERE steamid64 = ?1)
       ORDER BY g.created DESC LIMIT ?2`,
    )
    .bind(steamid64, limit)
    .all();
  return results.map((/** @type {any} */ g) => ({
    id: String(g.id),
    created: Number(g.created),
    board: String(g.board),
    state: String(g.state),
    started: g.started === null ? null : Number(g.started),
    finished: g.finished === null ? null : Number(g.finished),
    winner: g.winner ?? null,
    reason: g.reason ?? null,
    tiles: { red: Number(g.red_tiles ?? 0), blue: Number(g.blue_tiles ?? 0) },
    host: Boolean(g.hosting),
    joined: Boolean(g.joined),
    team: g.team ?? null,
    players: Number(g.players),
  }));
}
