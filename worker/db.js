// The web side's D1 tables (BINGO-WEB.md §7.3), made on first use so a new database needs no setup
// Players, login sessions, join codes, games (their hosts, state and ending, players and results:
// records.js), and the OpenID nonces already used. The leaderboards come later
// A column added to a table here later needs an ALTER TABLE on the databases made before it

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS players (
    steamid64 TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    avatar TEXT,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  )`,
  // Only the token's hash is stored
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    steamid64 TEXT NOT NULL,
    created INTEGER NOT NULL,
    expires INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS sessions_by_player ON sessions (steamid64)",
  `CREATE TABLE IF NOT EXISTS join_codes (
    code_hash TEXT PRIMARY KEY,
    game_id TEXT NOT NULL,
    steamid64 TEXT NOT NULL,
    expires INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
  )`,
  // Made by the create route; from state on, kept up to date by the game (records.js)
  `CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY,
    host TEXT NOT NULL,
    created INTEGER NOT NULL,
    board TEXT NOT NULL,
    ruleset TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'lobby',
    started INTEGER,
    finished INTEGER,
    winner TEXT,
    reason TEXT,
    tiebreaker TEXT,
    line TEXT,
    red_tiles INTEGER NOT NULL DEFAULT 0,
    blue_tiles INTEGER NOT NULL DEFAULT 0,
    player_board TEXT,
    segment_board TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS games_by_host ON games (host, created)",
  // Who is in each game, on which team (null: off the teams), with their handicaps (JSON)
  `CREATE TABLE IF NOT EXISTS game_players (
    game_id TEXT NOT NULL,
    steamid64 TEXT NOT NULL,
    team TEXT,
    handicaps TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (game_id, steamid64)
  )`,
  "CREATE INDEX IF NOT EXISTS game_players_by_player ON game_players (steamid64)",
  // Every result of a finished game, voided ones too, for the segment leaderboards
  `CREATE TABLE IF NOT EXISTS results (
    attempt_id TEXT PRIMARY KEY,
    game_id TEXT NOT NULL,
    steamid64 TEXT NOT NULL,
    team TEXT NOT NULL,
    tile TEXT NOT NULL,
    segment TEXT NOT NULL,
    time_ms INTEGER NOT NULL,
    at_ms INTEGER NOT NULL,
    verdict TEXT,
    voided INTEGER NOT NULL,
    flagged INTEGER NOT NULL,
    accepted INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS results_by_game ON results (game_id)",
  "CREATE INDEX IF NOT EXISTS results_by_segment ON results (segment, time_ms)",
  // Steam's answers are refused a second time (BINGO-WEB.md §11)
  `CREATE TABLE IF NOT EXISTS openid_nonces (
    nonce TEXT PRIMARY KEY,
    expires INTEGER NOT NULL
  )`,
];

/** @type {WeakMap<D1Database, Promise<unknown>>} */
const ready = new WeakMap();

/**
 * Makes the tables once per database and Worker instance
 * @param {D1Database} db
 */
export function ensureSchema(db) {
  let done = ready.get(db);
  if (!done) {
    done = db.batch(SCHEMA.map((sql) => db.prepare(sql))).catch((e) => {
      ready.delete(db);
      throw e;
    });
    ready.set(db, done);
  }
  return done;
}

/**
 * Drops what has expired: sessions, join codes and nonces
 * Cheap, so it runs now and then, e.g. at each sign-in
 * @param {D1Database} db
 * @param {number} now
 */
export async function sweep(db, now) {
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE expires < ?").bind(now),
    db.prepare("DELETE FROM join_codes WHERE expires < ?").bind(now),
    db.prepare("DELETE FROM openid_nonces WHERE expires < ?").bind(now),
  ]);
}
