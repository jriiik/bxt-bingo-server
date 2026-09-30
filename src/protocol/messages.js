// Messages on the BXT <-> server WebSocket (BINGO.md §6)
// Every message is one JSON text message with a snake_case `type`
// Optional fields are sent as `null` and may be left out by BXT

/** Bumped on any breaking change to the message shapes. Sent by BXT in `hello` */
export const PROTOCOL_VERSION = 1;

/** Largest message the server accepts, in bytes */
export const MAX_MESSAGE_BYTES = 4096;

// Keep-alive, sent by BXT every 30 s
// Exact text, so a Durable Object can answer it without waking the game
export const PING_TEXT = '{"type":"ping"}';
export const PONG_TEXT = '{"type":"pong"}';
export const PING_INTERVAL_MS = 30_000;

// Connecting (BINGO.md §6)
// BXT opens `wss://<server>/bxt` with one of these headers
export const JOIN_HEADER = "X-Bingo-Join";
export const SESSION_HEADER = "X-Bingo-Session";

/**
 * Why the server refused the connection before the upgrade
 * Sent as HTTP 403 with `{ "error": <code> }`, or HTTP 429 when rate limited
 * @typedef {"bad_code" | "code_expired" | "bad_session" | "game_locked" | "game_full" | "game_over" | "banned"} ConnectError
 */

/** @type {readonly ConnectError[]} */
export const CONNECT_ERRORS = Object.freeze([
  "bad_code",
  "code_expired",
  "bad_session",
  "game_locked",
  "game_full",
  "game_over",
  "banned",
]);

/** WebSocket close codes the server uses. On any other drop BXT reconnects with backoff */
export const CLOSE = Object.freeze({
  KICKED: 4001,
  GAME_DELETED: 4002,
  // The same player connected again somewhere else
  REPLACED: 4003,
  BANNED: 4004,
  // Reconnect
  RESTARTING: 1012,
});

// BXT -> server

/**
 * First message on every connection
 * @typedef {object} Hello
 * @property {"hello"} type
 * @property {number} protocol
 * @property {string} bxt_version
 * @property {string} engine_build Engine build as detected by BXT, e.g. `won`. Picks the saves in the manifest
 * @property {string | null} dll_sha256
 * @property {string | null} steamid64 Self-reported and unverified, only compared with the one the join code belongs to
 */

/**
 * The player picked a tile (a click or Enter on the board, or `bxt_bingo_play`, not just hovering),
 * or left it (`null`). From here they contest the tile, and the lobby shows it
 * @typedef {object} TileSelected
 * @property {"tile_selected"} type
 * @property {import("./ids.js").TileId | null} tile
 */

/**
 * @typedef {object} DownloadProgress
 * @property {"download_progress"} type
 * @property {number} done
 * @property {number} total
 */

/**
 * All files in the manifest are present and verified
 * @typedef {object} Ready
 * @property {"ready"} type
 * @property {string} manifest_hash
 */

/**
 * The start trigger fired. The server times the attempt on its own clock from here
 * @typedef {object} AttemptStarted
 * @property {"attempt_started"} type
 * @property {string} attempt_id UUID made by BXT
 * @property {import("./ids.js").TileId} tile
 */

/**
 * A finished attempt. Resent until acknowledged, the server dedupes by `attempt_id`
 * An invalid run is never sent as a result, see `attempt_invalidated`
 * @typedef {object} AttemptResult
 * @property {"attempt_result"} type
 * @property {string} attempt_id
 * @property {import("./ids.js").TileId} tile
 * @property {number} time_ms BXT game time between the start and end trigger. This is the time that counts
 * @property {number} server_time_delta_ms Same interval with the server DLL's clock
 * @property {number} frames
 * @property {number} real_ms Wall-clock duration on the player's machine
 * @property {number} load_ms Wall-clock time spent in loading screens during the attempt
 * @property {string} save_sha256 Hash of the save the attempt was loaded from
 * @property {boolean} ruleset_ok
 * @property {string | null} demo Local demo file name, if one was recorded
 */

/**
 * The attempt broke a rule (load, banned command, cvar, damage with No damage%) and won't be submitted
 * @typedef {object} AttemptInvalidated
 * @property {"attempt_invalidated"} type
 * @property {string} attempt_id
 * @property {import("./ids.js").TileId} tile
 * @property {string} reason
 */

/**
 * The demo asked for with `request_demo` has been uploaded
 * @typedef {object} DemoUploaded
 * @property {"demo_uploaded"} type
 * @property {string} attempt_id
 */

/**
 * @typedef {object} Ping
 * @property {"ping"} type
 */

/** @typedef {Hello | TileSelected | Ping | DownloadProgress | Ready | AttemptStarted | AttemptResult | AttemptInvalidated | DemoUploaded} ClientMessage */

// Server -> BXT

/**
 * @typedef {object} PlayerInfo
 * @property {string} steamid64
 * @property {string} name Steam name
 * @property {import("./ids.js").Team | null} team `null` while waiting for the host to pick one
 */

/**
 * @typedef {object} Welcome
 * @property {"welcome"} type
 * @property {string} session_token Sent in the session header to reconnect
 * @property {string} server_time ISO 8601
 * @property {PlayerInfo} player
 */

/**
 * `lobby`: joining, downloading, getting ready
 * `countdown`: `round_start` was sent
 * @typedef {"lobby" | "countdown" | "running" | "finished"} LobbyState
 */

/** @type {readonly LobbyState[]} */
export const LOBBY_STATES = Object.freeze(["lobby", "countdown", "running", "finished"]);

/**
 * @typedef {object} LobbyPlayer
 * @property {string} steamid64
 * @property {string} name
 * @property {import("./ids.js").Team | null} team
 * @property {boolean} ready
 * @property {boolean} connected
 * @property {import("./ids.js").TileId | null} tile From `tile_selected`
 * @property {string[]} handicaps Names of the player's handicap presets (BINGO.md §10.1)
 * @property {{ done: number, total: number } | null} download From `download_progress`, `null` once ready
 */

/**
 * @typedef {object} TeamInfo
 * @property {import("./ids.js").Team} team
 * @property {string | null} color `#rrggbb`. `null` leaves it to each client's default
 */

/**
 * @typedef {object} Lobby
 * @property {"lobby"} type
 * @property {LobbyState} state
 * @property {boolean} locked No new players can join
 * @property {LobbyPlayer[]} players
 * @property {TeamInfo[]} teams Missing teams use the client's default colors
 */

/**
 * Everything BXT needs for a round, already resolved for the player's engine build and handicaps
 * @typedef {object} Manifest
 * @property {"manifest"} type
 * @property {string} manifest_hash Echoed back in `ready`
 * @property {import("./segment.js").Ruleset} ruleset This player's rules, with their handicaps applied
 * @property {ManifestTile[]} tiles
 * @property {import("./segment.js").ExtraFile[]} extra_files Other files the game needs, e.g. the win sound
 * @property {string} game The game folder the board is played in, e.g. `valve` (BINGO.md §3.3)
 *   BXT checks it against the game it runs in
 * @property {string} files_url Where BXT downloads every file, as `<files_url><sha256>`
 *   A path like `/files/` is on the server BXT connected to (`http` for `ws`, `https` for `wss`)
 */

/**
 * @typedef {object} ManifestTile
 * @property {import("./ids.js").TileId} id
 * @property {string | null} label `null` while labels are hidden until the round starts
 * @property {import("./segment.js").FileRef} save
 * @property {import("./segment.js").StartCondition} start
 * @property {import("./segment.js").EndCondition} end
 */

/**
 * Which segment is on a tile, for the web pages. BXT gets this in its manifest instead
 * `label`, `segment` and `chapter` are all null while hideLabels keeps them hidden
 * @typedef {object} TileInfo
 * @property {import("./ids.js").TileId} id
 * @property {string | null} label e.g. `OAR2`
 * @property {string | null} segment The segment's id, e.g. `oar-2-0`
 * @property {string | null} chapter e.g. `On A Rail`
 */

/**
 * Pages only: sent first when a page connects, and again when hidden labels are revealed
 * @typedef {object} TilesMessage
 * @property {"tiles"} type
 * @property {TileInfo[]} tiles All 25
 */

/**
 * @typedef {object} TileLabel
 * @property {import("./ids.js").TileId} tile
 * @property {string} label
 */

/**
 * BXT counts down from `countdown_ms` from when the message arrives, as PC clocks differ
 * @typedef {object} RoundStart
 * @property {"round_start"} type
 * @property {number} countdown_ms
 * @property {string} starts_at ISO 8601, for display only
 * @property {TileLabel[]} labels Labels that were hidden in the manifest, revealed now
 */

/**
 * @typedef {object} ContestingPlayer
 * @property {string} steamid64
 * @property {import("./ids.js").Team} team
 */

/**
 * @typedef {object} TileSnapshot
 * @property {import("./ids.js").TileId} id
 * @property {import("./ids.js").Team | null} owner
 * @property {number | null} time_ms The time to beat
 * @property {string | null} holder Name of the player who set it
 * @property {boolean} playable_for_you Whether the receiving player's team may play this tile. `false` for spectators
 * @property {ContestingPlayer[]} contesting Players on this tile now: they picked it (`tile_selected`)
 *   and their team may play it. Empty for BXT when the lobby turns contesting off
 */

/**
 * @typedef {object} Board
 * @property {"board"} type
 * @property {number} seq Increases with every change. Clients ignore snapshots older than the last one seen
 * @property {number} clock_ms Since the round started
 * @property {number | null} time_limit_ms
 * @property {number | null} sudden_death_ms Length of sudden death after the time limit, `null` when off
 * @property {TileSnapshot[]} tiles
 */

/**
 * Outcome of a submitted result
 * `captured`: the tile was free and is now the player's team's
 * `stolen`: beat the other team's time, the tile changed hands
 * `improved`: beat the player's own team's time (only with redo own tile)
 * `not_faster`: not strictly faster than the holder. Ties go to whoever set the time first
 * `locked`: redo own tile is off and the team owns the tile, or lockout is on and the other team does
 * `game_over`: the game had already ended
 * `rejected`: refused (wrong save hash, tile not on the board, game not running)
 * @typedef {"captured" | "stolen" | "improved" | "not_faster" | "locked" | "game_over" | "rejected"} Verdict
 */

/** @type {readonly Verdict[]} */
export const VERDICTS = Object.freeze([
  "captured",
  "stolen",
  "improved",
  "not_faster",
  "locked",
  "game_over",
  "rejected",
]);

/**
 * @typedef {object} ResultAck
 * @property {"result_ack"} type
 * @property {string} attempt_id
 * @property {Verdict} verdict
 * @property {boolean} flagged The result counts for now, but waits for the host's review (e.g. suspiciously fast)
 *   The verdict is still the real one, so BXT plays the right sound
 * @property {string | null} detail Why it was rejected or flagged
 */

/**
 * Human-readable notification, shown in the message feed
 * @typedef {object} EventMessage
 * @property {"event"} type
 * @property {string} text
 */

/**
 * BXT uploads the demo with an HTTP PUT to `upload_url`, with the session header, then sends `demo_uploaded`
 * @typedef {object} RequestDemo
 * @property {"request_demo"} type
 * @property {string} attempt_id
 * @property {string} upload_url
 */

/**
 * How a game ended (BINGO.md §10.2)
 * `line`: a full row, column or diagonal
 * `most_tiles`: more tiles when the time limit ran out
 * `sudden_death`: got ahead during sudden death
 * `tiebreaker`: still even, decided by `tiebreaker`
 * `draw`: still even after every tiebreaker
 * `host_ended`: the host ended the game early, no winner
 * @typedef {"line" | "most_tiles" | "sudden_death" | "tiebreaker" | "draw" | "host_ended"} EndReason
 */

/** @type {readonly EndReason[]} */
export const END_REASONS = Object.freeze([
  "line",
  "most_tiles",
  "sudden_death",
  "tiebreaker",
  "draw",
  "host_ended",
]);

/**
 * Checked in the order the lobby creator puts them (BINGO.md §10.2)
 * `total_time`: higher sum of the times on the team's tiles
 * `steals`: more tiles taken from the other team
 * `first_to_final_score`: first to reach the final tile count
 * `fewest_players`: fewer players
 * `most_handicaps`: more handicaps in total, minus assists
 * @typedef {"total_time" | "steals" | "first_to_final_score" | "fewest_players" | "most_handicaps"} Tiebreaker
 */

/** @type {readonly Tiebreaker[]} */
export const TIEBREAKERS = Object.freeze([
  "total_time",
  "steals",
  "first_to_final_score",
  "fewest_players",
  "most_handicaps",
]);

/**
 * @typedef {object} GameOver
 * @property {"game_over"} type
 * @property {import("./ids.js").Team | null} winner `null` for a draw or when the host ended the game
 * @property {EndReason} reason
 * @property {Tiebreaker | null} tiebreaker The one that decided, with reason `tiebreaker`
 * @property {import("./ids.js").TileId[] | null} line The winning line, with reason `line`
 */

/**
 * `bad_message`: not a known message, or a field is wrong. The socket is closed after a few
 * `protocol_unsupported`: `hello.protocol` isn't one the server speaks
 * `engine_build_unsupported`: no saves for `hello.engine_build`
 * `not_running`: an attempt while the game isn't running
 * `tile_not_playable`: an attempt on a tile the team may not play
 * `rate_limited`: too many messages
 * @typedef {"bad_message" | "protocol_unsupported" | "engine_build_unsupported" | "not_running" | "tile_not_playable" | "rate_limited"} ErrorCode
 */

/** @type {readonly ErrorCode[]} */
export const ERROR_CODES = Object.freeze([
  "bad_message",
  "protocol_unsupported",
  "engine_build_unsupported",
  "not_running",
  "tile_not_playable",
  "rate_limited",
]);

/**
 * @typedef {object} ErrorMessage
 * @property {"error"} type
 * @property {ErrorCode} code
 * @property {string} detail
 */

/**
 * @typedef {object} Pong
 * @property {"pong"} type
 */

/** @typedef {Welcome | Lobby | Manifest | RoundStart | Board | ResultAck | EventMessage | RequestDemo | GameOver | ErrorMessage | Pong | TilesMessage} ServerMessage */
