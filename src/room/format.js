// Texts for the event feed, shared by BXT and the web pages

/**
 * @typedef {import("../protocol/ids.js").Team} Team
 * @typedef {import("../game/game.js").Ending} Ending
 */

/**
 * `s.mmm` under a minute, `m:ss.mmm` from a minute, like the in-game board
 * @param {number} ms
 */
export function formatTime(ms) {
  const total = Math.max(0, Math.round(ms));
  const millis = String(total % 1000).padStart(3, "0");
  const seconds = Math.floor(total / 1000);
  if (seconds < 60) {
    return `${seconds}.${millis}`;
  }
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}.${millis}`;
}

/**
 * `m:ss` for the match clock and lengths of time
 * @param {number} ms
 */
export function formatClock(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Names come from Steam: no control characters, and a sane length
 * @param {string} name
 */
export function cleanName(name) {
  const clean = String(name).replace(/\p{Cc}/gu, "").trim().slice(0, 32);
  return clean === "" ? "Player" : clean;
}

/** @param {Team} team */
const TEAM = (team) => team.toUpperCase();

/** @type {Record<string, string>} */
const TIEBREAKER_NAMES = {
  total_time: "total time",
  steals: "steals",
  first_to_final_score: "reaching the final score first",
  fewest_players: "fewer players",
  most_handicaps: "more handicaps",
};

/**
 * @param {"captured" | "stolen" | "improved"} verdict
 * @param {Team} team
 * @param {string} label
 * @param {number} timeMs
 * @param {string} name
 */
export function resultText(verdict, team, label, timeMs, name) {
  const verb = verdict === "captured" ? "took" : verdict === "stolen" ? "stole" : "improved";
  return `${TEAM(team)} ${verb} ${label} — ${formatTime(timeMs)} (${name})`;
}

/**
 * A player's BXT joined the game, or came back to it
 * @param {string} name
 * @param {Team | null} team
 * @param {boolean} again
 */
export function joinText(name, team, again) {
  if (again) {
    return `${name} rejoined`;
  }
  return team ? `${name} joined ${TEAM(team)}` : `${name} joined`;
}

/**
 * A player's BXT closed its connection, or lost it (e.g. a crash)
 * @param {string} name
 * @param {"left" | "lost"} how
 */
export function leaveText(name, how) {
  return how === "left" ? `${name} left` : `${name} lost connection`;
}

/**
 * @param {string} name
 * @param {boolean} ban
 */
export function kickText(name, ban) {
  return `${name} was ${ban ? "banned" : "kicked"}`;
}

/** @param {Readonly<Ending>} ending */
export function endingText(ending) {
  const winner = ending.winner && TEAM(ending.winner);
  switch (ending.reason) {
    case "line":
      return `${winner} wins with ${ending.line?.join(" ")}`;
    case "most_tiles":
      return `Time's up, ${winner} wins with more tiles`;
    case "sudden_death":
      return `${winner} wins in sudden death`;
    case "tiebreaker":
      return `Time's up with even tiles, ${winner} wins on ${TIEBREAKER_NAMES[ending.tiebreaker ?? ""] ?? ending.tiebreaker}`;
    case "draw":
      return "Time's up, it's a draw";
    case "host_ended":
      return "The host ended the game";
  }
}
