// The web side's D1 tables (BINGO-WEB.md §7.3), made on first use so a new database needs no setup
// Players, login sessions, join codes, games and their hosts, and the OpenID nonces already used
// Finished games, results and the leaderboards come later

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
  `CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY,
    host TEXT NOT NULL,
    created INTEGER NOT NULL,
    board TEXT NOT NULL,
    ruleset TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS games_by_host ON games (host, created)",
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
