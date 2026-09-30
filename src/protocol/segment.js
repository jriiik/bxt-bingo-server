// Segment catalog (`segments.json`) and the pieces of it that are sent to BXT

/**
 * Segment to be played on a tile of the board
 * @typedef {object} Segment
 * @property {string} id Stable id, e.g. `oar-2-0` (matches the practice kit cfg name)
 *   Never reused: a changed save or trigger makes a new segment with a new id
 * @property {string} label Short tile text, e.g. `OAR2`
 * @property {string} chapter e.g. `On A Rail`
 * @property {string} [pool] The set the host picks it from (BINGO.md §3.3), e.g. `hl1`. `hl1` if missing
 * @property {string} [game] The game folder it's played in, e.g. `valve` or `gearbox`. `valve` if missing
 *   A board is always one game, as a save from one game doesn't load in another
 * @property {Record<string, FileRef>} saves Start save per engine build (`won` now, `steam` later)
 *   Saves aren't portable between builds
 * @property {StartCondition} start
 * @property {EndCondition} end
 * @property {number | null} reference_time_ms Community gold, as a reference for how long it takes
 */

/** The pool and game of segments that don't say, like the ones on the first test boards */
export const DEFAULT_POOL = "hl1";
export const DEFAULT_GAME = "valve";

/**
 * A file BXT downloads and checks, from `/files/<sha256>`
 * @typedef {object} FileRef
 * @property {string} sha256 Lowercase hex SHA-256
 * @property {number} size Bytes
 */

/**
 * An axis-aligned box, like the ones from `bxt_triggers_add`
 * @typedef {object} TriggerBox
 * @property {string} [map] Only counts on this map, or on any map if missing like the practice kit triggers
 * @property {[[number, number, number], [number, number, number]]} corners Opposite corners, in any order
 */

/**
 * A file outside the saves that BXT downloads into the game directory (e.g. `valve_WON`),
 * like the win sound. Checked like the saves, and never overwrites a different file
 * @typedef {object} ExtraFile
 * @property {string} path Relative to the game directory, e.g. `sound/bingo/firework.wav`
 * @property {string} sha256
 * @property {number} size
 */

/** Kinds of extra files BXT accepts. Maps and models come later */
export const EXTRA_FILE_EXTENSIONS = Object.freeze(["wav"]);

/**
 * A safe path for an extra file: lowercase, forward slashes, no `..`, a known extension
 * BXT checks the same before writing anything
 * @param {unknown} path
 * @returns {path is string}
 */
export function isSafeExtraPath(path) {
  if (typeof path !== "string" || !/^[a-z0-9_-]+(\/[a-z0-9_.-]+)+$/.test(path)) {
    return false;
  }
  const parts = path.split("/");
  const extension = path.slice(path.lastIndexOf(".") + 1);
  return parts.every((p) => p !== "." && p !== ".." && p !== "") && EXTRA_FILE_EXTENSIONS.includes(extension);
}

/**
 * What stops the timer
 * A trigger box (`type` may be left out, as in older boards), or `game_end` for segments that end
 * with the game (Nihilanth), where BXT's timer stops by itself at the end of the game
 * @typedef {({ type?: "trigger" } & TriggerBox) | { type: "game_end" }} EndCondition
 */

/**
 * What starts the timer after the save is loaded
 * `trigger`: the player touches the box
 * `on_load`: the first frame after the save loads
 * @typedef {({ type: "trigger" } & TriggerBox) | { type: "on_load" }} StartCondition
 */

/**
 * Rules BXT enforces for bingo runs. Breaking one cancels the run
 * `rules/` has the ones made from the community whitelist (`npm run whitelist`)
 * @typedef {object} Ruleset
 * @property {CvarRule[]} cvars When several rules match a cvar, the longest name wins
 * @property {boolean} single_segment Loading any save other than the tile's own ends the run, and so does dying
 *   Otherwise saves made during the run can be loaded and the timer keeps running, like in segmented runs
 * @property {boolean} scripted Scripted runs may run more than one command from a single key press or console line
 *   Scriptless runs only allow one
 * @property {CommandRules} commands
 * @property {boolean} no_damage Taking any damage (health or armor) after the start trigger invalidates the run
 *   A handicap, see BINGO.md §10.1
 * @property {boolean} [require_kill] The run only counts if the player killed an enemy monster during it
 *   The Bloodthirsty handicap
 */

/**
 * @typedef {object} CvarRule
 * @property {string} name A trailing `*` matches every cvar starting with the rest, e.g. `bxt_tas_*`
 * @property {CvarOp} op
 * @property {string} [value] Compared numerically when both sides are numbers, otherwise as strings (`eq`/`ne` only)
 *   Unused by `default`, `unchanged` and `any`
 */

/**
 * `set`: BXT sets it to the value while the board is loaded, and puts the player's value back after
 *   It must stay at the value like `eq`. Only for `sv_` cvars, for handicaps like Jupiter
 * `default`: must stay at BXT's default, only for BXT's own cvars
 * `unchanged`: must keep the value it had when the run started, e.g. the skill cvars from `skill.cfg`
 * `any`: anything goes, to exempt a cvar from a wider `*` rule
 * @typedef {"eq" | "ne" | "lte" | "gte" | "set" | "default" | "unchanged" | "any"} CvarOp
 */

/** @type {readonly CvarOp[]} */
export const CVAR_OPS = Object.freeze(["eq", "ne", "lte", "gte", "set", "default", "unchanged", "any"]);

/**
 * What the player may run from a key or the console during a run
 * Commands the game runs by itself (e.g. `changelevel2` from a level change) aren't checked
 * @typedef {object} CommandRules
 * @property {string[]} allowed Aliases and `exec` count as the commands they run
 *   Setting a cvar is always allowed (the cvar rules check the value)
 *   A trailing `*` allows a prefix, e.g. `-*`
 *   `name arg` allows the command only with that first argument, e.g. `impulse 100`
 *   Empty allows every command
 * @property {string[]} not_in_scripts Commands a scripted run may only run on their own, not as part of a script
 * @property {string[]} blocked Commands BXT drops instead of cancelling the run, for handicaps like "No +attack2"
 *   Same patterns as `allowed`. A key or console line that runs one of them is dropped whole
 */

/**
 * An empty ruleset, which allows everything
 * @param {boolean} [scripted]
 * @returns {Ruleset}
 */
export function emptyRuleset(scripted = false) {
  return {
    cvars: [],
    single_segment: false,
    scripted,
    commands: { allowed: [], not_in_scripts: [], blocked: [] },
    no_damage: false,
  };
}
