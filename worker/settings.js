// The lobby options a host sets on the create page (BINGO.md §10), checked before they reach the
// game: they come from a page, so every key and value is checked and nothing else goes through

import { TIEBREAKERS } from "../src/protocol/index.js";

/**
 * The lobby options a host may set (BINGO.md §10), checked here since they come from a page
 * @param {unknown} input
 * @returns {import("../src/room/room.js").RoomSettings | string} The settings, or what's wrong
 */
export function checkSettings(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return "settings must be an object";
  }
  const s = /** @type {Record<string, unknown>} */ (input);
  /** @type {Record<string, unknown>} */
  const out = {};
  const MIN = 60_000;
  const whole = (/** @type {unknown} */ v, /** @type {number} */ lo, /** @type {number} */ hi) =>
    typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
  for (const [key, value] of Object.entries(s)) {
    switch (key) {
      case "redoOwnTile":
      case "lockout":
      case "singleSegment":
      case "showContesting":
      case "hideLabels":
        if (typeof value !== "boolean") {
          return `${key} must be true or false`;
        }
        out[key] = value;
        break;
      case "timeLimitMs":
        if (value !== null && !whole(value, MIN, 3 * 3600_000)) {
          return "timeLimitMs must be null or from 1 minute to 3 hours";
        }
        out[key] = value;
        break;
      case "suddenDeathMs":
        if (value !== null && !whole(value, MIN, 3600_000)) {
          return "suddenDeathMs must be null or from 1 minute to 1 hour";
        }
        out[key] = value;
        break;
      case "tiebreakers":
        if (!Array.isArray(value) || value.some((t) => !TIEBREAKERS.includes(t)) || new Set(value).size !== value.length) {
          return `tiebreakers must be a list of ${TIEBREAKERS.join(", ")}, each once`;
        }
        out[key] = [...value];
        break;
      case "countdownMs":
        if (!whole(value, 3000, 30_000)) {
          return "countdownMs must be from 3 to 30 seconds";
        }
        out[key] = value;
        break;
      case "maxPlayers":
        if (!whole(value, 2, 16)) {
          return "maxPlayers must be from 2 to 16";
        }
        out[key] = value;
        break;
      default:
        return `unknown setting ${key}`;
    }
  }
  return out;
}
