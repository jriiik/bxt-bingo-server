# BXT Bingo — design plan

Status: **offline bingo works in BXT** (`bingo` branch of BunnymodXT): the board and mini-board,
attempts with retries, the rules (scriptless/scripted, cvars, single-segment), handicaps, contesting
squares and event sounds, all from a local manifest file. In this repo, in JavaScript: the protocol
(`src/protocol`), the game rules with every ending (`src/game`), a whole game (`src/room`), and a
Worker with a game Durable Object that runs locally with `wrangler dev` (`worker/`), plus the
whitelist tool, a fake BXT client and a WebSocket echo server. The backend is deployed by the web
side, on Cloudflare (§8). Next: networking in BXT against the local server, the catalog importer,
downloads and evidence (§9).
This file lives in the bxt-bingo-server repo. The web side's design is `BINGO-WEB.md`, by the
frontend dev.

A Trackmania-Bingo-style community game for Half-Life speedrunning. Two teams of any size race to
claim tiles on a 5x5 board. Each tile is a speedrun segment (e.g. `OAR2`). The first team with a
full row, column or diagonal wins.

Three components:

| Component | Owner | Responsibility |
|---|---|---|
| **BXT bingo client** (BunnymodXT repo) | us | Connect, download/verify segment files, show the board in-game, run and time attempts, submit results, show live updates. **No game rules.** |
| **Bingo backend** | web side (Cloudflare, JavaScript), using this repo's protocol and rules | Authoritative state: lobbies, teams, identity binding, segment catalog, file hosting, result validation, tile ownership rules, win detection, push updates, leaderboards. |
| **Web pages** (jrik.dev) | the frontend dev | Steam login, create a game, pick the board, team setup, rule toggles, spectating, moderation (void a time, kick), results, profiles, leaderboards. |

The key rule: **BXT only reports facts** ("player X finished tile B3 in 12.345 s, and here's the
evidence"). Whether that claims the tile, whether a team can redo its own tile, and whether someone
has won are all decided by the server. So rule changes (like the "allow redo on own tile" checkbox)
never need a BXT update.

---

## 1. How a player plays

### 1.1 One-time setup
1. Install the BXT build that has bingo support (the usual `Bunnymod XT` folder).
2. Optionally put `bxt_bingo_server "bingo.jrik.dev"` in `userconfig.cfg` so they never have to type it.
3. Bind one key: `bind <key> bxt_bingo_board`, which toggles the interactive board and cursor.
   **Retrying needs no new bind.** Players reset the way they already do, with their existing
   `load hard` bind (see §4.3, "Retry = load the save").

### 1.2 A match, end to end

```
 HOST (web)                 PLAYERS (web)                  PLAYERS (in game, BXT)              SERVER
 ──────────                 ─────────────                  ──────────────────────              ──────
 Sign in with Steam
 Create game:
  - board (manual/random
    from segment pool)
  - rules (redo own tile?,
    time limit, cvar ruleset)
  → gets lobby link ───────▶ Open link, sign in
                             with Steam, pick team
                             → shown join code
                               "K7QF-29"
                                                           bxt_bingo_join K7QF-29  ─────────▶ bind BXT session
                                                                                               to Steam user
                                                           ◀───────── lobby state + manifest
                                                           downloads 25 .sav (≈10–30 MB),
                                                           verifies SHA-256
                                                           status: READY ─────────────────────▶
                             Lobby page shows ready ✓
 Clicks "Start" (enabled
 when all ready) ─────────────────────────────────────────────────────────────────────────────▶
                                                           ◀───────── round_start (countdown)
                                                           board revealed, 3-2-1-GO
                                                           bxt_bingo_board → cursor → click B3
                                                           → board closes, mouse goes back to
                                                             the camera, save loads,
                                                             bingo triggers armed
                                                           cross start trigger → timer runs
                                                           cross end trigger → timer stops
                                                           submit {tile B3, 12.345 s, evidence}──▶ validate,
                                                                                                   apply rules
                                                           ◀───────── board (B3 = RED, 12.345, player)
                             Spectator board updates
                                                           toast "RED took OAR2 — 12.345 (Player)"
                                                           ...
                                                           ◀───────── game_over (RED, row 2)
```

### 1.3 In-game UX
- **Mini-board HUD** (`bxt_hud_bingo 1`, placed with `bxt_hud_bingo_anchor` and
  `bxt_hud_bingo_offset`): a small, non-interactive 5x5 that is always visible. Tiles are coloured
  by owner, and the tile you're playing is outlined in gold. Under it: the tile you're playing and
  the run's state (Loading, Ready, Running, Finished or Invalid). *To build:* the match clock and
  "submitting…" once there's a server.
- **Interactive board** (`bxt_bingo_board`, toggle): a large centred window with its own drawn
  cursor (the game hides the system one). Each tile shows its coordinate, its label (`OAR2`), the
  owning team's colour, the time to beat and who holds it, plus the contesting squares (§10).
  The tile you're playing has a gold border and the selected one a white border. Tiles the server
  marks as not playable for your team (for example "your team already owns it and redo is off")
  are darkened. Colors are cvars (`bxt_bingo_color_*`), with colorblind-friendly defaults and the
  team colors picked in the frontend. Clicking a tile:
  1. closes the board and gives the mouse back to the camera (no second toggle needed);
  2. loads that tile's save and arms its triggers.
  Esc or the same bind closes it without choosing.
- **Keyboard/console fallback:** `bxt_bingo_play B3` or `bxt_bingo_play OAR2`. Arrow keys + Enter
  also work in the interactive board.
- **Triggers are drawn** for the tile you're playing: the start trigger in pink and the end trigger
  in gold, with a faint fill and clear edges (`bxt_bingo_show_triggers`,
  `bxt_bingo_color_start_trigger`, `bxt_bingo_color_end_trigger`, `bxt_bingo_triggers_fill_alpha`,
  `bxt_bingo_triggers_edge_alpha`).
- **Timer:** BXT's own timer (`bxt_hud_timer`) is the run's timer. Bingo resets it on loading the
  tile, starts it at the start trigger and stops it at the end trigger or when the run is cancelled.
- **Messages and sounds** for events: a few lines under the mini-board that fade after a few
  seconds (`bxt_bingo_messages 0` turns them off, the console always gets them), and a sound per
  event, each set by a cvar as a path under `sound/` (game directory first, then valve), empty
  for none, with `bxt_bingo_sound_volume` for all of them (up to 1, the loudest the game allows).
  They play through the game's sound system, so a level load right after cuts them off.

  | Event | Cvar | Default |
  |---|---|---|
  | You take a tile or beat its time | `bxt_bingo_sound_capture` | `vox/woop` |
  | Someone else on your team takes a tile | `bxt_bingo_sound_ally_capture` | `fvox/bell` |
  | The other team takes a tile | `bxt_bingo_sound_opponent_capture` | `fvox/blip` |
  | An opponent picks the tile you're playing (taking it or defending it) | `bxt_bingo_sound_contested` | `fvox/danger` |
  | Your run is cancelled or no longer counts | `bxt_bingo_sound_invalid` | `fvox/beep` |
  | A team wins | `bxt_bingo_sound_win` | `bingo/firework` |

  All but the win sound come with Half-Life. `firework.wav` came from an HL or AG server years ago,
  with no known author. The server hosts it (`files/sound/bingo/firework.wav` and
  `rules/extra-files.json` in this repo) and sends it in the manifest's `extra_files`, and BXT
  downloads it into `sound/bingo/` like the saves (step 6). Until then a missing sound is skipped.
- More toasts for players joining or leaving, when networking is in.
- Opening the board mid-attempt does **not** pause or cancel the attempt. Picking a *different*
  tile cancels it.

---

## 2. Identity: who sent this time?

Goal: no account system of our own, and no reliance on the in-game `name` (most people leave it as `Player`).

### Recommended: Steam login on the web + a join code in game
1. The frontend uses **Steam OpenID** ("Sign in through Steam"). This is free and needs no API key
   for the login itself, and it gives a **verified SteamID64**. The Steam Web API
   (`GetPlayerSummaries`, needs a free Web API key) supplies the display name and avatar. Teams are
   built from these Steam users.
2. When a signed-in player joins a lobby, the server issues them a short one-time **join code**
   (e.g. `K7QF-29`, valid for ~10 minutes and single-use).
3. In game: `bxt_bingo_join K7QF-29`. The server binds that BXT connection to that Steam user and
   returns a **session token**. BXT keeps it in memory and uses it to reconnect after a drop or crash.
4. From then on, every message on that connection is attributed to that SteamID and that team.
   There's no ambiguity, and nothing in BXT has to prove who the player is.

Why this approach: the one step that proves identity (Steam OpenID) happens in the browser, where
it's easy and standard. The game side only has to show that the person at the keyboard can also see
the web page. This also works on non-Steam setups if that ever becomes a concern.

### Optional convenience: BXT reports the local SteamID
This HL build (engine 3248, ships `steam_api.dll` + `steam_appid.txt` = 70, and Steam must be
running) probably lets BXT read the local SteamID, either through `SteamUser()->GetSteamID()` from
`steam_api.dll` or from the engine's local `player_info_t::m_nSteamID` (as used by
`bxt_get_steamid_from_demo`, `HwDLL.cpp:3879`, though that path is gated on `is_steamid_build`).
Uses:
- auto-match ("you're signed in on the web as X, join lobby Y?"), so the player can skip the code;
- a cross-check that the SteamID the client reports matches the one the code is bound to.

**It's self-reported, so it must never be treated as proof.** A modified client can send any ID.
Making it proof would need Steam auth tickets (`GetAuthSessionTicket` → Web API
`ISteamUserAuth/AuthenticateUserTicket`). Whether the bundled `steam_api.dll`/`SteamUser010`
interface supports that is unverified (see spikes, §7). It's not worth it for the MVP.

### No fallback without a web login
Dropped by the web side: every player signs in through Steam. The join code is personal: single
use, valid for 10 minutes, and only for that player and that game. The host can accept, move, kick
and ban players, lock the game, and add co-hosts. A ban is for that game only, and the host can
undo it (`unban`, with the banned list in the game's snapshot); the player then joins like a new one.
Once the game is over, the players can't be changed (add, move, kick, handicaps), so the results
stay as they were. Voiding and accepting results still work then. At most **16 players** per game,
spectators unlimited.

---

## 3. Segments, manifest and content

### 3.1 Turn the practice kit into structured data
Today a segment is a `.cfg` like `PracticeCfgs/oar-2-0.cfg`:
`map c1a0` → `bxt_triggers_add` start/end → `bxt_triggers_setcommand bxt_timer_*` → `w 5` → `load oar2start`.

For bingo, BXT should **not** `exec` arbitrary cfgs. That's where cheating and accidents come from
(triggers and timer commands are then client-controlled, and cfgs can set anything). Instead, run a
one-time import script (server side, or a small tool) that parses the kit into a **segment catalog**:

```jsonc
// catalog/hl1.json (server-side catalog, one file per pool; 197 segments from the kit today)
// Authoritative shape: `Segment` in bxt-bingo-server/src/protocol/segment.js
{
  "id": "oar-2-0",
  "label": "OAR2",            // short tile text; sections could be "OAR2.1", "OAR2.2"
  "chapter": "On A Rail",
  "pool": "hl1",              // what the host picks from, §3.3
  "game": "valve",            // the game folder it's played in, §3.3
  "saves": { "won": { "sha256": "…", "size": 812345 } },   // per engine build (§3.1 notes)
  "start": { "type": "trigger", "corners": [[-2843.9,-447.6,-128.8],[-2801.3,-240.0,-3.6]] },
  "end":   { "corners": [[-3101.0,312.9,-12.0],[-3065.2,502.7,253]] },
  "reference_time_ms": 41200  // optional, community best / WR, for plausibility checks (§5)
}
```

Notes:
- Triggers can have a `map`, and then they only count on that map. It's optional, and a trigger
  without one counts on any map, like the practice kit's own triggers. The kit's triggers work fine
  that way, and a segment often starts or ends on a different map than its save (e.g. the save is
  just before a level change), so the importer doesn't set it.
- Custom maps would add more `extra_files` (bsp/wad/mdl/spr) later, see §3.2.
- `start.type` can also be `"on_load"` (timer starts on the first frame after the save loads) for
  segments that don't need a start trigger.
- `end` can be `{ "type": "game_end" }` instead of a trigger box, for segments that end with the
  game (Nihilanth), where the kit has no end trigger and BXT's timer stops by itself at the end of
  the game (autostop, §4.3). A trigger box may leave `type` out, as the current boards do. BXT
  ends the run in its autostop (`Bingo::OnGameEnd`, called from `DoAutoStopTasks`), right before
  BXT's own timer would stop.
- Several sections share a save and start trigger and only differ in the end trigger (`bp-1-0` and
  `bp-1-1` both load `bp1start`). That's fine: an attempt belongs to the tile the player picked.
- **Built:** `npm run catalog -- "<Half-Life Practice Kit folder>"` writes `catalog/hl1.json`. The
  cfg name is `<chapter>-<map>-<section>`: section 0 is the whole segment (label `OAR2`), 1 its
  first half from the start save (`OAR2.1`) and 2 its second half from the half save (`OAR2.2`).
  The start trigger is the one whose command starts the timer and the end trigger the one that
  stops it, in either order. A cfg that starts the timer itself after loading (`am-5-2`) gets
  `on_load`, and Nihilanth gets `game_end`. Left out: `am-1-0`, which loads no save (it starts
  from the map itself, like the map-start segments in §3.3), and three triggers in `wgh-1-1` with
  no timer command. The 197 segments use 135 different saves. The saves aren't in the repo: they
  go to the file storage (`dev-game --saves` locally, the web side's upload in production).
- **Segment ids are never reused.** The leaderboards key times by segment id, so a segment whose
  save or triggers change is a new segment with a new id, and old times aren't compared with new
  ones.
- **Permission:** imp gave consent (on Discord) to use his practice kit for bingo, including
  hosting its saves.
- **Engine builds:** the main target is **HL WON** (the 2005 build, on Windows and on Linux via
  Wine/Proton, see §4.0). Everyone on it runs the same `hl.exe`/`hw.dll`, so the practice kit's
  saves work for all of them. Saves are generally *not* portable to **HL Steam** (Steampipe),
  though. To leave room for HL Steam later without a protocol change, `save` is a map keyed by
  build (`{"won": {...}}` now, `"steam"` later). BXT reports its engine build in `hello` (BXT
  already detects it), and the server hands out the matching file or rejects unsupported builds.

### 3.2 Distribution
- Files are **content-addressed**: `GET https://assets.jrik.dev/bingo/files/<sha256>` (public R2
  storage). They're cacheable and deduplicated, and the name can't be spoofed. The manifest's
  `files_url` says where: BXT downloads `<files_url><sha256>`. It comes from the Worker's
  `FILES_URL` variable, and without it it's `/files/`, a path on the server BXT connected to
  (`ws://localhost:8787/bxt` → `http://localhost:8787/files/<sha256>`).
- A round's manifest lists the 25 tiles, each with its segment data and file hashes (`sha256` +
  `size`) and a destination path.
- **Download only what's missing or different.** For each manifest file, BXT checks the
  destination first:
  1. file missing → download;
  2. size differs → download (a cheap check that avoids hashing);
  3. same size → hash it; if the SHA-256 matches, **skip**, otherwise download and replace.
  After a download, BXT hashes the result again and fails loudly on a mismatch (retry once, then
  report an error to the server).
  A small hash cache (`path → size, mtime, sha256`) avoids re-hashing large files every round.
  That matters later for `.bsp`/`.wad`, not for 1 MB saves. Players who played before, or who
  already have the practice kit, download nothing and are ready instantly.
- Under Wine the game dir is a real Linux directory, and Wine emulates case-insensitivity on top of
  it. To avoid surprises (e.g. an existing `Hard.sav` next to a new `hard.sav`), BXT resolves files
  the way the engine does, through the game's `SAVE/` directory, uses all-lowercase names for files
  it creates (`bingo_<hex>.sav`, `hard.sav`), and matches existing files case-insensitively.
- Saves go to `<gamedir>/SAVE/bingo_<sha256[:12]>.sav`. A save has to be in `SAVE/` for
  `load` to find it, and the hash in the name avoids collisions with the player's own saves.
  These are the **pristine copies**. The retry save (§4.3) is copied from them.
  GoldSrc `.sav` files embed the level state, so one file per segment is enough. The kit's saves are
  0.3–1.3 MB each, so a 25-tile board is roughly 10–30 MB in the worst case.
- `ready` is sent once every file in the manifest is present and verified, whether it was
  downloaded or already there.
- Downloads can already happen in the lobby, before the host starts. Optional twist: hide tile
  labels until `round_start` (the manifest lists opaque tile IDs and file hashes, and labels are
  revealed at start). That way nobody pre-plans a route from the board.
- **Extra files** (the manifest's `extra_files`, each a path relative to the game directory plus
  `sha256` and `size`): same mechanism. Only the win sound for now, so only `.wav` is allowed;
  maps, `.wad`, `.mdl` and `.spr` come later. BXT must **whitelist extensions and reject `..` in
  paths** (the server checks the same with `isSafeExtraPath`). If a
  destination exists with a *different* hash, BXT must not silently overwrite it: it could be a
  stock game file or the player's own content. For now BXT refuses and shows the conflict, and
  the player isn't ready until they move the file away. Installing custom content into a separate
  bingo game dir instead can be decided when custom maps become real.
- **Built** on the `bingo` branch: `Platform::SyncFiles` checks and downloads on a worker thread,
  one file at a time, into a `.part` file that replaces the destination only once its size and
  SHA-256 match (tried twice). BXT sends `download_progress` as files come in and `ready` at the
  end, shows "Downloading 12/26" on the mini-board before the start, and tries missing files again
  every 15 s. Checked under Wine 9 against the local server: missing folders, a file already there,
  a different save replaced, a different extra file refused, a 404, a file too big, a hash mismatch
  and a server that's down. No hash cache yet.

### 3.3 Pools and games
The host picks which **pools** a board is drawn from when making the lobby, e.g. only the HL1
campaign, or the campaign and the Hazard Course together. Every catalog segment has two fields
for this from the start, so adding pools later doesn't change the format:

- **`pool`**: the set it belongs to, shown to the host. For example `hl1` (the campaign),
  `hazard-course`, `blue-shift`, `opfor`, `ag-bhop`, `ag-climb`, or a set of custom bingo or
  challenge maps.
- **`game`**: the game folder it's played in: `valve` for HL1 and the Hazard Course (the Hazard
  Course maps are part of Half-Life), `bshift` for Blue Shift, `gearbox` for Opposing Force, `ag`
  for AG.

Rules:

1. **A board is one game.** Nobody can switch games in the middle of a match, and a save from one
   game doesn't load in another. Pools of different games can't be mixed, and the server refuses
   a board whose segments aren't all the same `game`. Pools of the same game mix freely (HL1 and
   the Hazard Course).
2. **The manifest says which game it is** (`game`), and BXT checks it against the game it's
   running in, e.g. "This game is played in Opposing Force", instead of failing on the first
   tile. A game folder counts when it's the same name or starts with it and `_`, so `valve_WON`
   plays `valve` boards. The lobby could show it too, so players start the right game before
   joining.

   Built: `pool` and `game` on segments (both optional, `hl1` and `valve` when missing), the
   server's one-game check, `game` in the manifest, and BXT's check (it leaves the game with a
   message, and refuses such a board offline too).
3. **Each game has its own saves and triggers** in the catalog, and players need that game
   installed. BXT already runs in Blue Shift and Opposing Force.
4. **The board picker** (web side) draws the 25 tiles from the pools the host ticked. The server
   doesn't care which pool a segment came from, only that the board is one game.

How much work each kind of pool is:

| Pools | Work |
|---|---|
| HL1 campaign, Hazard Course | Only catalog entries, like today's segments. |
| Blue Shift, Opposing Force | Catalog entries with their own saves, plus the `game` check above. |
| AG bhop and climb maps, custom maps | The most work, as its own step later: downloading maps (`.bsp` and often `.wad`, models and sounds, where §3.2 still has to decide on the player's game folder or a separate bingo one), segments that start from the map's start instead of a save (a start like `{ "type": "map", "map": "bhop_x" }`, and a retry reloads the map), and maybe their own rulesets, as bhop and climb have other rules than the HL1 whitelist. |

The rulesets may later be per game or per pool as well. For now every board uses the HL1
whitelist (`rules/won-*.json`).

---

## 4. What BXT has to do

### 4.0 Ground rules: targets, CI, dependencies and code style

#### Targets
Terminology used in this doc:
- **HL WON:** the specific old engine build the community runs (the 2005 package, engine build
  3248). It's still authenticated through Steam: Steam must be running, and the game must be owned.
- **HL Steam:** the current Steampipe build (native on Windows and Linux).

| Priority | Target | Which BXT build | How it runs |
|---|---|---|---|
| **Main** | HL WON on **Windows** | `BunnymodXT.dll` (CI `build-windows`, `COF=OFF`) | `hl.exe -steam`, injected with `Injector.exe` |
| **Main** | HL WON on **Linux** | the **same** `BunnymodXT.dll` | `hl.exe` under **Wine or Proton** (runners use both, so both must work), with Steam for Windows in the same prefix. There's no native Linux binary of this engine build. |
| Future | HL Steam (Windows and native Linux) | `BunnymodXT.dll` / `libBunnymodXT.so` | only if it doesn't need special handling; not a priority |

This makes **"works on Linux" mean "the Windows DLL works under Wine/Proton"** for the main
target, so Wine compatibility is a hard requirement for every Win32 API we use, not an
afterthought. Linux is first-class: each feature is only done once it's verified on WON under
both Windows and Wine/Proton.

#### Must fit the existing GitHub Actions (`.github/workflows/main.yml`) without changes
CI today has three jobs, and bingo must build green in all of them **with no workflow edits and
no new install steps**:
- `build-windows`: `windows-2022`, MSVC, `-A Win32`, Boost 1.78 headers, matrix
  `Release/Debug × COF=OFF/ON`. `winhttp.lib` and `bcrypt.lib` are in the Windows SDK the runner
  already has, so only `target_link_libraries` changes. Bingo compiles in the CoF build too
  (it's game-agnostic), just like splits and custom triggers.
- `build-linux`: `ubuntu-22.04`, `g++-multilib`, `libboost-dev` (1.74), i386 GL. The native `.so`
  must keep compiling. Bingo's shared code builds there, and the Linux transport is a **stub**
  (`bxt_bingo_join` prints "not supported on this engine build yet") until HL Steam support is
  picked up. No `libssl-dev:i386`, no new apt packages.
- `build-flatpak`: freedesktop 22.08 SDK with the i386 toolchain, **Boost 1.76 headers only**
  (built in the manifest). The same stub applies, so no new flatpak modules are needed.
- Only use Boost parts that exist and are header-only across **1.74 (Ubuntu), 1.76 (Flatpak) and
  1.78 (Windows)**. `boost::uuids` qualifies.
- Keep release artifact names and paths unchanged (`fail_on_unmatched_files` is on).
- *Optional, only if maintainers want it:* a small host-side test executable for the shared logic
  (manifest parsing, attempt state machine, file-check logic), run with `ctest`. That would add
  one step to the workflow, so propose it separately rather than bundling it in.

When HL Steam on native Linux becomes a goal, the Linux transport would be Boost.Beast/Asio (in
the Boost we already require) with TLS from the system OpenSSL. That **does** require CI changes
(`libssl-dev:i386` in `build-linux`, an OpenSSL i386 module or SDK extension in the Flatpak
manifest), plus a check that it coexists with the Steam runtime's own `libssl`. That's the price of
that future step, and it's the reason it isn't done now.

#### Dependencies
**Dependencies must be lightweight and well maintained. Prefer what BXT already has, then what the
OS provides, and only then something new.**

| Need | Choice | New dependency? |
|---|---|---|
| JSON | **rapidjson**, already a submodule | no |
| UUIDs (`attempt_id`), string helpers | **Boost** header-only parts, already required | no |
| HTTP(S) downloads + WebSocket, with TLS | **WinHTTP** (`winhttp.lib`, part of Windows). It supports WebSockets natively (`WinHttpWebSocketCompleteUpgrade`/`Send`/`Receive`), with TLS through the OS (SChannel on Windows, Wine's own implementation under Wine/Proton). | no, it's a system library |
| SHA-256 | **BCrypt** (`bcrypt.lib`, part of Windows, implemented by Wine) | no, it's a system library |
| Board input | Win32 **WndProc** subclass (the HL WON engine has no SDL). See §4.4. | no |
| In-game board + mini-board | BXT's **existing drawing** (`GLUtils` rectangles and the console font) | no |

That means **zero new third-party libraries and zero CI changes.** Rejected options, for the
record: IXWebSocket, libcurl, mbedTLS, and vendored OpenSSL on 32-bit MSVC (each is a heavy build or
TLS dependency for something the OS already does, and would need CI work), and Dear ImGui (see
§4.4). If we ever do need a new library, the bar is: actively maintained, small, builds as a
submodule with `add_subdirectory` or a handful of source files like `discord-rpc`/`taslogger`,
builds in all three CI jobs without workflow changes, pinned to a release tag, and a license
compatible with BXT's.

**Code style: bingo code must read like the rest of BXT.**
- Tabs, and the brace, naming and comment style of the surrounding files (e.g. `splits.*`,
  `discord_integration.*`, `Windows/interprocess.cpp`).
- Same file layout: `BunnymodXT/bingo.hpp/.cpp` as `namespace Bingo` (file-local helpers in an
  anonymous namespace, like `discord_integration.cpp`), with platform code split into
  `BunnymodXT/Windows/bingo_platform.cpp` and `BunnymodXT/Linux/bingo_platform.cpp`, the same way
  `interprocess.cpp` is split. Sources are added to the existing lists in `CMakeLists.txt`, and
  `bcrypt` (later `winhttp`) is linked alongside `opengl32` in the `WIN32` branch.
- Cvars go in the `X(...)` list in `cvars.hpp` and are registered like the others. Commands are
  `struct HwDLL::Cmd_BXT_Bingo_*` with `USAGE(...)`/`NO_USAGE()` and a static `handler`,
  registered with `wrapper::Add<..., Handler<...>>("bxt_bingo_...")`.
- Output goes through `EngineMsg`/`EngineDevMsg`/`EngineWarning`/`EngineDevWarning`, never `printf`.
  Bingo's player-facing messages use its own `Print`, which formats the text first, because the
  HL WON engine's `Con_Printf` doesn't support every format (e.g. `%llu`).
- Hooks into the engine and client go through the existing `HwDLL`/`ClientDLL`/`ServerDLL` modules,
  which call into bingo (e.g. `Bingo::Frame` from `HUD_Frame`, `Bingo::OnPlayerCommand` from the
  `Cbuf_AddText` hook). Engine console commands bingo needs to watch (`load`, `save`, `map`, …) are
  wrapped by name through `Cmd_FindCmd`, so no new byte patterns are needed.
- **Don't change existing BXT code** beyond these small calls into bingo. Bingo drives BXT's timer
  through `CustomHud`'s own functions rather than the `bxt_timer_*` commands, for example.
- The mini-board is a `bxt_hud_*` element drawn from `hud_custom.cpp` (`bxt_hud_bingo`,
  `bxt_hud_bingo_anchor`, `bxt_hud_bingo_offset`).

### Module layout
- `bingo.hpp/.cpp`: shared, compiled in every CI job. State, attempt state machine, manifest, the
  board and mini-board drawing, triggers, event messages and sounds, and a small platform interface
  (`Sha256File`, board input; later the transport: connect / send / poll events / download file).
- `bingo_rules.hpp/.cpp`: the ruleset (cvar rules, allowed and blocked commands, scripted,
  single-segment, no damage) and the checks against it.
- `Windows/bingo_platform.cpp`: BCrypt SHA-256 and the WndProc input. Later the WinHTTP transport
  and its worker thread. This is the one real implementation, and it serves HL WON on both Windows
  and Wine/Proton.
- `Linux/bingo_platform.cpp`: stub for the native `.so` until HL Steam support happens.
- `hud_custom.cpp` places the mini-board like the other HUD elements, and `triangle_drawing.cpp`
  calls bingo to draw the triggers.

The rest of BXT only calls in through a few hooks.

### 4.1 Commands and cvars
Built:

| Name | Kind | Purpose |
|---|---|---|
| `bxt_bingo_join [code]` | cmd | Join an online game at `bxt_bingo_server` with the code from the game's page. Without a code it goes back to the last game (the session is kept in `<gamedir>/bingo_session.json`, with the times the server hasn't confirmed yet). With a code while in a game, it leaves that game first; the last game's session is only replaced once the new game lets the player in. |
| `bxt_bingo_manifest <file>` | cmd | Load a board from a local manifest file (`.json` optional), for offline play and testing. Not while online. |
| `bxt_bingo_board` | cmd | Toggle the interactive board and its cursor. |
| `bxt_bingo_play <tile>` | cmd | Start a tile by coordinate (`B3`) or label (`OAR2`). |
| `bxt_bingo_leave` | cmd | Leave the board and put the player's own retry save back. Online it also leaves the game. |
| `bxt_bingo_status` | cmd | Print the board, the run and its state, the run type, handicaps and team colors, and online the match, the players and the times waiting for the server. |
| `bxt_bingo_retry_save` | cvar | Name of the save BXT copies the current tile's save to, so a plain `load <name>` retries it. Default `hard`. See §4.3. |
| `bxt_bingo_server` | cvar | Server address: a `ws://` or `wss://` URL, or a host with an optional port, which gets `ws://` on this computer or the local network (e.g. `localhost:8787`) and `wss://` otherwise. The path is `/bxt` unless one is given. |
| `bxt_hud_bingo`, `bxt_hud_bingo_anchor`, `bxt_hud_bingo_offset` | cvar | Show and place the mini-board, like the other `bxt_hud_*` elements. |
| `bxt_bingo_color_*` | cvar | Board colors: `my_team`, `other_team`, `unowned`, `current`, `selected`, `time`, `start_trigger`, `end_trigger`. |
| `bxt_bingo_show_triggers`, `bxt_bingo_triggers_fill_alpha`, `bxt_bingo_triggers_edge_alpha` | cvar | Drawing the current tile's triggers. |
| `bxt_bingo_messages`, `bxt_bingo_sound_*` | cvar | Event messages and sounds, see §1.3. |

Debug commands, for testing without a server: `_bxt_bingo_set_tile`, `_bxt_bingo_set_playable`,
`_bxt_bingo_set_contesting`, `_bxt_bingo_set_team`, `_bxt_bingo_set_team_color`,
`_bxt_bingo_set_single_segment`, `_bxt_bingo_event` (plays an event's sound), `_bxt_bingo_hash`
(prints a save's SHA-256 and size) and the `_bxt_bingo_debug_input` cvar.

Online, the mini-board shows the match under the tile lines (connecting, waiting for the start,
the countdown, the time left, sudden death, how the game ended), and so does the board's title.

### 4.2 Networking
- **Transport:** one **WebSocket** connection (`wss://` for hosted servers, `ws://` for LAN or
  raw-IP servers) for everything live, plus plain **HTTP(S) GET** for file downloads. The frontend
  will almost certainly use WebSockets as well, so the server can serve both.
- **Implementation:** WinHTTP for the transport and rapidjson for messages (see §4.0). The
  transport sits behind a small platform-neutral interface in `bingo.hpp` (connect / send / poll
  events / download file). `Windows/bingo_platform.cpp` is the real implementation and serves HL
  WON on Windows and under Wine/Proton. `Linux/bingo_platform.cpp` is a stub for the native `.so`,
  so the `build-linux` and `build-flatpak` CI jobs keep compiling with no new dependencies.
- **Threading:** all socket and file I/O on a worker thread. The game thread never blocks.
  - net → game: a mutex-protected event queue, drained once per frame in `Bingo::Frame`
    (called from `HUD_Frame`, which also runs while paused and in the menu).
  - game → net: an outgoing queue.
  - **Never call engine functions from the worker thread.**
- **Connecting:** `bxt_bingo_join <code>` opens `wss://<server>/bxt` with the code in an
  `X-Bingo-Join` header, and a reconnect sends the session token in `X-Bingo-Session` instead. A
  refused code or token is an HTTP 403 before the upgrade, with a JSON reason (§6). Once connected,
  BXT sends `{"type":"ping"}` every 30 s.
- **Reliability:** reconnect with backoff (1, 2, 4… up to 30 s) using the session token, and on
  reconnect the server sends a full snapshot (`welcome`, `lobby`, `manifest`, `board`). No reconnect
  after the close codes that mean kicked, game deleted, replaced or banned (§6). Results carry a client-generated `attempt_id` (UUID) and are re-sent until
  acknowledged, and the server dedupes them. A finished run is never lost to a network blip, even
  if the game is closed before the ack: unacked results are kept in `<gamedir>/bingo_session.json`
  with the session token, and `bxt_bingo_join` without a code goes back and sends them again.
- **Built** on the `bingo` branch: `Windows/bingo_platform.cpp` has the transport (a receiving
  worker and a sending worker per connection, WinHTTP, 75 s receive timeout). Checked under Wine 9
  against the local server: join headers, the 403 refusal body, big messages (the manifest), ping,
  close. `Linux/bingo_platform.cpp` reports networking as unsupported.
- **Until evidence (step 7)** `attempt_result` reports `frames` 0, `server_time_delta_ms` equal to
  `time_ms`, the real time between the triggers as `real_ms`, and all of the rest as `load_ms`, so
  the server clock check only catches results without `attempt_started`.

### 4.3 Attempt state machine (the core)
```
IDLE ──pick (board click / bxt_bingo_play)──▶ LOADING ──save loaded──▶ ARMED ──start trigger──▶ RUNNING ──end trigger──▶ FINISHED
                                                 ▲                                                │
                                                 └──── `load hard` (the retry save) at any point ─┤
                                        a rule broken (§5.1) ──▶ cancelled, back to IDLE ◀────────┘
```
- **Picking a tile** (board click or `bxt_bingo_play`):
  1. check the tile's pristine save `SAVE/bingo_<sha256[:12]>.sav` against the manifest's hash
     and size;
  2. copy it to `SAVE/<bxt_bingo_retry_save>.sav` (default `SAVE/hard.sav`);
  3. make that tile the *current tile* and load it. BXT issues this first `load` itself, and
     nothing goes through a cfg.
- A segment with `"start": {"type": "on_load"}` skips ARMED and runs from the first frame after
  the save loads.
- **Retry = load the save.** There's no retry command. Runners reset the way they always have,
  with their existing `load hard` bind. BXT wraps the engine's `load` console command (found by
  name with `Cmd_FindCmd`, then its handler pointer is swapped; no byte patterns, so it works on
  every engine build). When the loaded file is the retry save, BXT hashes it right before the
  engine reads it. If it doesn't match the tile (e.g. the player swapped it from outside the game),
  BXT copies the pristine save back first and loads that. Either way the tile starts over.
- **Loading other saves during a run** depends on the lobby's single-segment option (§10):
  - segmented (the default): saves made during this run can be loaded, and the timer keeps
    running. BXT hashes each save right after the game writes it and checks the hash again on
    load, so a save swapped from outside the game cancels the run. `reload` after dying loads the
    newest save made during this run (or the retry save if there's none), which is handled the
    same way. BXT picks it rather than the engine, which could load an older autosave or quicksave;
  - single-segment: loading anything but the retry save cancels the run, and so does dying.
    `reload` after dying loads the retry save, so the tile starts over.

  After a run was cancelled or finished, `reload` also starts the tile over.

  Saving over the retry save during a run is refused, since loading it restarts the tile.
- **Other things that cancel a run:** `map`, `changelevel`, `restart`, a broken cvar or command
  rule (§5.1), or picking another tile (quietly). The console says why, with a sound.
- **Protecting the player's own `hard.sav`:** before bingo first overwrites it, BXT backs it up to
  `SAVE/bingo_backup_hard.sav`, and puts it back on `bxt_bingo_leave`, or on the next start if the
  game closed while playing a tile. An existing backup is never replaced, since it's the player's
  original.
- **The retry save stays `hard`** until the community says otherwise. Other options are a
  different agreed name (e.g. `bingo`) that people bind once, or arming on *any* load whose file
  hash equals the current tile's save (any name works, costs a hash per load). The cvar keeps this
  flexible, so switching later is a default change, not a redesign.
- Bingo triggers live in a **separate trigger set** owned by the bingo module, not in the
  `bxt_triggers_*` list. The player's own practice triggers stay visible if they want them, but they
  **can't** start or stop a bingo attempt, and `bxt_triggers_clear` doesn't touch bingo triggers.
  They're checked from the same two places as `CustomTriggers::Update` (the player's position every
  frame, and each move in `PM_Move`, so fast movement can't skip through them).
- **Timing:** BXT's own timer is the run's time. Bingo drives it through `CustomHud` (reset on
  loading the tile, start at the start trigger, stop at the end or on a cancel). The ruleset keeps
  everything else that could move it away from the player: `bxt_timer_*` are banned, and the split
  cvars that start or stop it (`bxt_splits_start_timer_on_first_split`,
  `bxt_splits_end_on_last_split`) must be 0. Autostop at the end of the game stays on, which is
  what the Nihilanth segment relies on.
- **Invalid runs** (the no damage% handicap, §10.1) keep going with the timer in red, but the finish
  doesn't count.
- **On finish**, offline, BXT applies simple local rules so the board can be tested: the first
  finish takes the tile, a strictly faster time takes it over, and a tie keeps the first time. With
  a server, BXT will send the result (§6), show "submitting…" and then the server's verdict
  ("captured", "not faster than 12.301", "tile locked", "flagged for review").
- The player keeps playing freely. A retry (`load hard`) is instant and doesn't wait for the server.

### 4.4 UI and cursor
- **Rendering: no UI library.** The board is 25 rectangles with a few lines of text each. BXT's
  existing drawing covers it: GL rectangles (`GLUtils`) for tiles, borders and highlights, and the
  console font for text. It matches the look of the other BXT HUD elements, and clicks are plain
  rectangle hit-testing. (Dear ImGui was considered. It's well maintained and small, but it would
  add a GL render hook, its own input plumbing and a new submodule for a UI this simple. Revisit
  only if the in-game UI grows a lot, e.g. settings panes or scrolling lists.)
- **Input when the board is open** (built, see the input rules in `bingo.hpp`):
  - The HL WON engine has **no SDL**, so bingo **subclasses the game window's WndProc**. This is
    plain Win32, so it should work the same under Wine/Proton.
  - `ClientDLL::SetMouseState(false)` stops mouse-look while the board is open, and the cursor
    position comes from `WM_MOUSEMOVE`. The game hides the system cursor, so the board draws its
    own and keeps the real one inside the window. The crosshair is hidden while the board is open.
  - Left click picks a tile on release, so the click never reaches the game (no shooting).
  - Other mouse buttons and the wheel go to the engine, which only runs a `bxt_bingo_board` bind,
    so a mouse button bound to the board closes it too.
  - Arrow keys, Enter and Esc drive the board. Other keys reach the game, so the player can keep
    moving and keyboard binds keep working.
  - The board closes when the window loses focus, when the console opens, on disconnect, and if it
    stops being drawn for a while.
  - *Future, HL Steam:* SDL engines would use BXT's existing `SDL` module instead (the TAS editor
    already uses `SDL::GetMouseState`/`SetRelativeMouseMode`), plus a hook on SDL's event pump to
    swallow input. That's the same shared hit-testing code with a different source of events.
- **RInput:** RInput hooks `GetCursorPos`/`SetCursorPos` and takes the mouse raw input, but
  `WM_MOUSEMOVE` still gives the right position, so the board works with RInput (tested, §7 #1).
  Keyboard navigation and `bxt_bingo_play B3` always work as a fallback.

### 4.5 What BXT deliberately does NOT do
- Decide whether a time claims a tile, whether a team may redo a tile, or who wins.
- Store the board. It only renders the last snapshot the server sent, which comes with
  `playable`/`locked` flags per tile for this player's team. (Offline, BXT keeps a local board so
  it can be tested, see §4.3.)
- Execute arbitrary server-sent console commands. The protocol has no "exec" message, ever. That
  would turn a compromised or malicious server into remote control of every client.

---

## 5. Anti-cheat

An honest framing first: **BXT is open source and runs on the player's machine.** Anyone determined
enough can build a modified BXT that sends whatever it likes. No client-side check can be airtight.
The realistic goals are:
1. **Make casual or accidental cheating impossible:** edited saves, moved triggers, a
   `host_framerate` left over from TAS work, a practice trigger stopping the timer.
2. **Make deliberate cheating expensive and detectable:** it should need a custom build, and the
   evidence should look wrong.
3. **Produce evidence** so the community's existing trust and review culture can resolve disputes.

### 5.1 Client side (BXT)
| Measure | Status | Catches |
|---|---|---|
| **Server-owned saves:** SHA-256 and size checked when picking a tile and right before every load of the retry save. A changed retry save is replaced with the pristine one. Saves made during a segmented run are hashed after saving and checked on load. | built | Edited or swapped `.sav` (health, position, ammo, entity state). |
| **Server-owned triggers:** coordinates (and an optional map) come from the manifest and live in a separate set the player can't edit. | built | Moved or enlarged end triggers. |
| **Only a verified load arms an attempt.** Either BXT loads the tile, or the player loads the retry save and its hash matches at load time. An attempt is only valid if the chain `verified load → start trigger → end trigger` is unbroken. | built | Loading your own mid-segment save, `changelevel` or `map` shortcuts. |
| **Commands:** everything the player runs from a key or the console is checked before the engine runs it (the `Cbuf_AddText` hook during `Key_Event`), with aliases and `exec`ed configs expanded. It has to be on the ruleset's allowed list, and scriptless allows one command per key or line. `map`, `changelevel`, `restart` and loads are handled by the command wrappers (§4.3). | built | Console cheats, TAS helpers, scripts in scriptless runs. |
| **Cvar ruleset:** from the community whitelist sheet (§10), checked every frame while armed or running: fixed values (`sv_cheats 0`, `host_framerate 0`, …), BXT cvars that must stay at their default, and cvars that can't change during a run. **The list is server-defined**, so the community decides it per game. | built | Slowmo via `host_framerate`, cheats, disallowed helpers. |
| **Three independent clocks in every result:** BXT game time, server-DLL time delta (`gpGlobals->time`, via `ServerDLL::GetTime()`), and frame count + real time from `QueryPerformanceCounter`. Plus the time spent in loading screens. | to build (step 7) | Timer tampering or inconsistencies. Slowmo shows up as real time much greater than game time. |
| **Per-attempt demo** with BXT runtime data (`RuntimeData`, already TEA-embedded in demos and already used by the community for run verification). Record automatically from ARMED, keep locally, name it by `attempt_id`. | to build (step 7) | Gives evidence for any dispute, and the tools to read it already exist. |
| **Build fingerprint:** BXT git revision + hash of `BunnymodXT.dll` + loaded modules list (runtime data already collects `LoadedModules`). | to build (step 7) | Unofficial builds and unexpected injected DLLs. Spoofable, but it raises the bar (see §5.3). |

### 5.2 Server side (can't be faked by the client)
- **Server-clock sanity:** BXT sends `attempt_started` when the start trigger fires and
  `attempt_result` at the end. The server measures the gap on **its own clock**.
  - `server_gap < reported_time − tolerance` means the reported time is longer than physically
    possible. That's odd, but not beneficial to the player.
  - `server_gap ≫ reported_time + reported_load_time + tolerance` means the player got more real
    time than game time, which points to slowmo. **Flag it.**
- **Plausibility vs `reference_time`:** anything under e.g. 97% of the known best is flagged for
  host review. It isn't rejected, because records do happen.
- **Rate and pattern checks:** a first-try finish faster than the WR within seconds of the round
  starting gets flagged.
- **Demo on demand:** for flagged results, or optionally for every capture, the server asks BXT to
  upload that attempt's demo (a few MB). The frontend links it for review.
- **Moderation in the frontend:** the host can void a result or a tile, and ownership rolls back to
  the previous valid holder. A flagged result claims the tile as normal and waits in the host's
  review list, so the game keeps flowing, until the host accepts or voids it. Site moderators can
  void ranked results at any time, also after the game.
- **Flag, don't auto-reject** (except for hard failures like a hash mismatch or wrong map). It's a
  trust community, and false positives are worse than a human looking at a flag.
- Optional social layer: "streams required" lobby setting, with stream links shown on the frontend.

### 5.3 Against a modified BXT
A modified build can report any time, skip every check in §5.1 and edit the demos it records.
Nothing on the player's PC can be fully trusted, so the aim is that cheating takes a lot of work
and a cheat is likely to be caught:

- **Every attempt is recorded, and the server asks for demos after the fact.** The server sends
  `request_demo` after the result arrives: at random, and always for flagged results, steals and
  top times. The player can't know which run will be checked, so a cheat has to fake every run,
  not only the ones that get checked. BXT keeps the last few demos, and a requested demo that
  doesn't arrive in time voids the result.
- **Each demo is tied to one attempt.** When a run starts, the server sends a random value that BXT
  writes into the demo's runtime data. That stops someone uploading a clean demo from an earlier run.
- **An automatic demo check on the server,** then a person if needed. A parser reads the demo and
  BXT's runtime data and checks:
  - cvar values and the commands each key ran, against the ruleset and the player's handicaps;
  - health and armor for no damage%;
  - that the player loaded the tile's save and crossed its start and end triggers;
  - that the demo's length matches the reported time.

  Anything odd is flagged for the host. The runtime data is scrambled with a key that's in BXT's
  public source, so it isn't tamper-proof. But editing a demo so the movement, the frames and the
  runtime data all still agree is a lot of work.
- **What doesn't help much:** BXT reporting a hash of its own DLL (a modified build reports the
  official one), or anything like kernel-level anti-cheat, which is far too heavy for a community
  mod. The checks that matter are the ones the client can't dodge: the server clock, plausibility
  (§5.2), demo review, and Steam identity so voids and bans stick.
- **For bigger events:** required streams or video, so a cheat has to survive both the demo and the
  video.

---

## 6. Protocol (BXT ⇄ server)

JSON text messages over WebSocket, at most 4 KB each from BXT. Every message has a snake_case
`type`. The exact shapes are the JSDoc types in `src/protocol` (`messages.js`, `segment.js`), and
`parseClientMessage` checks everything BXT sends: unknown types or fields, wrong types, out of range
numbers, bad tile ids and UUIDs are all refused. This section is an overview. It merges the web
side's changes (`BINGO-WEB.md` §5) with ours from after that doc was written.

### Connecting
```
GET wss://bingo.jrik.dev/bxt           (ws://localhost:8787/bxt when testing locally)
X-Bingo-Join: K7QF-29                  first join, the player's personal code
   or
X-Bingo-Session: <token>               reconnect
```
Refused before the upgrade: HTTP 403 with `{ "error": "bad_code" }` (or `code_expired`,
`bad_session`, `game_locked`, `game_full`, `game_over`, `banned`), HTTP 429 when rate limited.

Close codes: `4001` kicked, `4002` game deleted, `4003` replaced (the same player connected again
elsewhere), `4004` banned, `1012` server restarting (reconnect). Any other drop: reconnect.

### BXT → server
```jsonc
{ "type": "hello", "protocol": 1, "bxt_version": "…git rev…", "engine_build": "won",
  "dll_sha256": "…" /* or null */, "steamid64": "7656…" /* optional, unverified */ }   // always first
{ "type": "ping" }                                             // exactly this text, every 30 s
{ "type": "tile_selected", "tile": "B3" }                      // or null when no longer playing one
{ "type": "download_progress", "done": 17, "total": 25 }
{ "type": "ready", "manifest_hash": "…" }                      // all files present + verified
{ "type": "attempt_started", "attempt_id": "uuid", "tile": "B3" }
{ "type": "attempt_result", "attempt_id": "uuid", "tile": "B3", "time_ms": 12345,
  "server_time_delta_ms": 12346, "frames": 1234, "real_ms": 12410, "load_ms": 0,
  "save_sha256": "…", "ruleset_ok": true, "demo": "bingo_<id>.dem" }
{ "type": "attempt_invalidated", "attempt_id": "uuid", "tile": "B3", "reason": "host_framerate must be 0" }
{ "type": "demo_uploaded", "attempt_id": "uuid" }             // after the HTTP PUT, when requested
```

### Server → BXT
```jsonc
{ "type": "welcome", "session_token": "…", "server_time": "…Z",
  "player": { "steamid64": "7656…", "name": "ninya", "team": "red" /* or null, unassigned */ } }
{ "type": "pong" }
{ "type": "lobby", "state": "lobby" /* countdown, running, finished */, "locked": false,
  "players": [ { "steamid64": "…", "name": "…", "team": "red", "ready": true, "connected": true,
                 "tile": null, "handicaps": ["Autojump"], "download": { "done": 17, "total": 25 } } ],
  "teams": [ { "team": "red", "color": "#e64b28" } ] }        // colors optional
{ "type": "manifest", "manifest_hash": "…", "ruleset": { … §10, with this player's handicaps … },
  "tiles": [ { "id": "B3", "label": "OAR2" /* null while hidden */, "save": { "sha256": "…", "size": 812345 },
               "start": { "type": "trigger", "corners": [ … ] }, "end": { "corners": [ … ] } } ],
  "extra_files": [ { "path": "sound/bingo/firework.wav", "sha256": "…", "size": 74858 } ],
  "files_url": "/files/" /* or e.g. "https://assets.jrik.dev/bingo/files/" */,
  "game": "valve" /* the game folder, §3.3 */ }
{ "type": "round_start", "countdown_ms": 5000, "starts_at": "…Z", "labels": [ { "tile": "B3", "label": "OAR2" } ] }
{ "type": "board", "seq": 42, "clock_ms": 1834000, "time_limit_ms": 900000, "sudden_death_ms": 600000,
  "tiles": [ { "id": "B3", "owner": "red", "time_ms": 12345, "holder": "ninya", "playable_for_you": false,
               "contesting": [ { "steamid64": "7656…", "team": "blue" } ] } ] }
{ "type": "result_ack", "attempt_id": "uuid", "flagged": false, "detail": null,
  "verdict": "captured" | "stolen" | "improved" | "not_faster" | "locked" | "game_over" | "rejected" }
{ "type": "event", "text": "BLUE stole OAR2 — 11.980 (Player2)" }   // message feed
{ "type": "request_demo", "attempt_id": "uuid", "upload_url": "https://bingo.jrik.dev/api/demos/<attempt_id>" }
{ "type": "game_over", "winner": "red" /* or null */,
  "reason": "line" | "most_tiles" | "sudden_death" | "tiebreaker" | "draw" | "host_ended",
  "tiebreaker": null /* or which one decided */, "line": ["A2","B2","C2","D2","E2"] /* or null */ }
{ "type": "error", "code": "bad_message", "detail": "…" }
```

Notes:
- `playable_for_you` is how the "redo own tile" and "lockout" options reach BXT. The server
  computes it and BXT just darkens the tile.
- `round_start`: BXT counts down `countdown_ms` from when the message arrives, because PC clocks
  differ. `starts_at` is for display only. `labels` reveals labels that were hidden in the manifest.
- **Contesting:** a player contests a tile from when they pick it: a click or Enter on the board, or
  `bxt_bingo_play` (hovering doesn't count). BXT sends `tile_selected` then, and `null` when the
  player leaves the board. `contesting` lists the connected players whose selected tile it is and
  whose team may play it, so a capture ends it (unless redo is on) and a steal back starts it
  again. That's what the contesting squares and the contested sound use, and the lobby shows each
  player's tile too. BXT only needs the teams, and gets it empty when the lobby turns contesting
  off. `attempt_started` is still sent at the start trigger, for the server's clock check.
- `board` also carries the clock: `time_limit_ms` and `sudden_death_ms` are `null` when off. Sudden
  death is on while `clock_ms` is past the time limit and the game isn't over.
- An invalid run is never sent as `attempt_result`, only as `attempt_invalidated`.
- `event` texts: captures, steals and improved times, sudden death, the ending, voided results,
  kicks and bans (`bot was banned`), and players joining (`naz joined RED`), coming back
  (`naz rejoined`), leaving (`naz left`, BXT closed with 1000) or dropping (`naz lost connection`,
  e.g. a crash). The player's own BXT doesn't get these, and nobody gets them once the game is over.
- **Flagged results** (§5.2) count for now but wait for the host's review. `result_ack` still has
  the real `verdict` (so BXT plays the right sound and shows the right message), with
  `flagged: true` and the reasons in `detail`. Once the host accepts it, a resent result is acked
  with `flagged: false`.
- A result that reaches the server after the game ended gets `game_over`, even if the run started
  before (§10.2).
- Error codes: `bad_message`, `protocol_unsupported`, `engine_build_unsupported`, `not_running`,
  `tile_not_playable`, `rate_limited`.
- Demo upload: an HTTP `PUT` to `upload_url` with the `X-Bingo-Session` header and the `.dem` as the
  body (at most 64 MB), then `demo_uploaded`.

Changes from the web side's §5, to tell them: `hello` keeps `engine_build`; `tile_selected`
drives contesting as they proposed, and the board's list is called `contesting` (their `running`);
`lobby` states are `lobby`/`countdown`/`running`/
`finished`, and players get `handicaps` and `download` (their download progress, `null` once ready)
and the lobby keeps optional `teams` colors; `round_start`
keeps `labels`; `board` gets `sudden_death_ms`; `result_ack` has our newer verdicts (`stolen`,
`improved`, `game_over`), and `flagged` is a separate true/false next to the real verdict instead
of a verdict of its own; `manifest` gets `extra_files` and `files_url`, and a segment's `end` can be `game_end`
(§3.1); `game_over` has our endings (§10.2) plus their `host_ended`; `error` adds
`engine_build_unsupported`; `attempt_result` has no `invalid_reason` or `segment` any more.

### Server → pages
The pages socket (`/ws/games/<id>`) gets the same `lobby`, `board`, `round_start`, `event` and
`game_over` as BXT (the board as a spectator sees it), plus one message of its own:
```jsonc
{ "type": "tiles", "tiles": [ { "id": "B3", "label": "OAR2", "segment": "oar-2-0", "chapter": "On A Rail" } ] }
```
It comes first when a page connects, and again when hidden labels are revealed (the start, or the
host ending the game in the lobby). While `hideLabels` keeps them hidden, `label`, `segment` and
`chapter` are all `null`, as the chapter alone would give most of the route away. The snapshot
(`GET /api/games/<id>`) has the same list as `tiles`.

---

## 7. Open questions and spikes (do these first)

1. **Cursor under RInput** on the 2005 build: with the game window's WndProc subclassed, do we get
   a correct cursor position and clicks? This affects UX more than anything else.
   **First result (2026-09-27, Windows, RInput Exp, 1024x768):**
   - `WM_MOUSEMOVE` lParam works: 7722 messages, sensible positions, and clicks hit the right
     tiles.
   - `GetCursorPos` never produced a position (RInput hooks it).
   - No `WM_INPUT` reached our window, because mouse raw input is registered to another window
     (RInput's).
   - So the board uses `WM_MOUSEMOVE` + button messages, and it's built that way. Keys work too.
     Still to check: RInput off, fullscreen, and Wine.
2. **Board drawing** with the HUD primitives: check that a 5x5 grid of tiles with console-font
   labels is readable at common resolutions.
   **Result:** readable at 1024x768 with the console font, including times over a minute and long
   names (cut with ".."). Other resolutions still to check.
3. **Load hook for retry:** find the right place to intercept a load *before the engine reads the
   file*, and get the resolved file path so we can hash it there. Also confirm that copying over
   `hard.sav` while the game runs is safe (the engine doesn't keep it open or cache it).
   **Finding (2026-09-26):** on HL WON (3248), BXT's pattern-based `Host_Loadgame_f` hook *is*
   found (one of the existing patterns matches), but `SaveGameSlot` is not (it only has a CoF
   pattern). Wrapping the `load`/`save` console commands through `Cmd_FindCmd` works on every
   engine build without patterns, and is the approach to use for both. Hashing a save through the
   game dir works (`valve_WON/SAVE/hard.sav`).
   **Verified in game (2026-09-27, Windows, RInput Exp):**
   - The `load` wrapper runs before the engine's load function and sees the file before it's read.
   - `save hard` goes through the `save` wrapper, and the hash changes with each save.
   - Copying another save over `hard.sav` mid-game, then `load hard`, loads the new file. The
     engine doesn't cache it.
   - Level changes don't go through `load`/`save` (no wrapper calls).
   - Reloading after death (`load autosave`) does go through the `load` wrapper, so a death
     correctly doesn't arm an attempt, because it's not the retry save.
4. **`load` of `SAVE/bingo_<hash>.sav`**: confirm it works, and check what happens to autosaves and
   transitions. The engine writes `.HL?` files into `SAVE/` during changelevels.
   **Result:** works. Bingo always loads through the retry save (`hard.sav`), copied from the
   `bingo_` file, and level changes during a segment are fine.
5. **SteamID access** from this build (`steam_api.dll` 2017 + `SteamUser010`, or engine
   `player_info`). Also: is `GetAuthSessionTicket` available, if we ever want verified identity?
   This is optional and doesn't block the MVP.
6. **Map name per segment:** *resolved.* A trigger's map is optional and the kit's triggers don't
   need one (§3.1), which also covers segments that cross a level change. Maps can still be filled
   in: the web side offered to work them out from the map geometry jrik.dev hosts (which also
   catches triggers inside walls), and they can be found in game too, which takes longer.
7. **Load-time accounting:** confirm how BXT's timer behaves across changelevels inside a segment,
   so `load_ms` and the server-clock check line up.
8. **WinHTTP inside `hl.exe`:** *spike done on Windows:* `ws://` and `wss://` both work from inside
   the game, sending takes under 0.25 ms, and closing while messages are still coming in gives a
   harmless error 12030. Still to check: Wine, and the notes below.
   Confirm the WebSocket API (Windows 8+) works in the game process,
   including if someone runs `hl.exe` in XP compatibility mode (needed for `hw.dll.original`).
   Also confirm both `wss://` (hosted) and `ws://` (LAN / raw IP) work. TLS comes from Windows'
   SChannel, so it depends on the OS: Windows 10/11 is fine, but Windows 7 needs the KB3140245
   update for WinHTTP to use TLS 1.2. Certificates are checked against the Windows certificate
   store, so a self-signed LAN server should use `ws://` rather than `wss://`. Over `ws://` the session
   token can be sniffed on that network, which is acceptable for a trust community.
9. **HL WON under Wine/Proton (Linux main target):** some Linux runners use plain Wine and some
   Proton, so both are tested. Still to ask: which versions, Steam for Windows in the same prefix,
   and how `Injector.exe` is launched (the `.bat` becomes a shell script). Then verify, in both:
   - WinHTTP's WebSocket API (`WinHttpWebSocket*`) works. Wine implements it, but we need a
     **minimum supported Wine/Proton version**, and we document it;
   - `wss://` validates certificates (Wine uses the host's CA store) and `ws://` works;
   - BCrypt SHA-256, the WndProc subclass, `load` hooking, and file copies in `SAVE/` behave the
     same as on Windows;
   - reading the SteamID through `steam_api.dll` works with Steam for Windows running in the prefix.
10. **CI fit:** the bingo code must pass all existing jobs unchanged: `build-windows`
    (Release/Debug × COF OFF/ON), `build-linux`, and `build-flatpak` (Boost 1.76 headers only, i386
    cross toolchain). So far it's checked locally with the Linux job's compile flags and with a
    32-bit MinGW compiler. The real CI runs once the branch is pushed.
11. **Future (HL Steam), not a priority:** WON saves vs. Steampipe (probably separate saves are
    needed); native Linux transport (Beast/Asio + system OpenSSL, next to the Steam runtime's own
    `libssl`, which needs CI changes, see §4.0); SDL input interception (`SDL_PollEvent` hook vs.
    `SDL_SetEventFilter`) through the existing `SDL` module.

---

## 8. Server responsibilities

The backend is the web side's (`BINGO-WEB.md` §7): a **Cloudflare Worker** at `bingo.jrik.dev`, with
**one Durable Object per game**, **D1** (SQLite) for players, finished games and leaderboards, and
**R2** for files and demos, written in JavaScript. It does:
- Steam OpenID login, personal join codes and session tokens (§2).
- The segment catalog (§3.1) and the content-addressed files (§3.2).
- The game state machine: `lobby → countdown → running → finished`. Downloads and `ready` happen in
  the lobby.
- Result validation (§5.2), then the tile rules and endings (`src/game`, §10), board broadcasts
  with `seq`, and an event log of every attempt, so voids are a replay without them.
- The web pages' API and sockets, results pages, leaderboards (§11) and moderation.

### 8.1 What each Cloudflare piece is
- **Worker:** a function that handles each HTTP request, with no memory between requests. It's
  the front door: login, rate limits, finding the game, handing the socket to the game.
- **Durable Object:** one long-lived object per game. It holds every socket of that game (BXT and
  browsers), handles one message at a time (no locks, no races), keeps its own SQLite storage, and
  sets alarms for the countdown, the time limit and the end of sudden death.
  It can **hibernate** while quiet: the sockets stay open but the memory is dropped, so the game is
  rebuilt from its stored event log when a message wakes it. The exact-text `ping` is answered
  without waking it.
- **D1:** a SQLite database for what outlives a game. **R2:** file storage.

### 8.2 What this repo provides
All of the backend that doesn't need the web side's Cloudflare account. `src/` has no Cloudflare
or Node dependencies, so it's tested with plain Node (`npm test`):
- `src/protocol`: the message shapes (JSDoc types) and `parseClientMessage`, the strict check for
  everything BXT sends (§6).
- `src/game`: the rules as pure logic: claim, steal (strictly faster, ties keep the first time),
  redo own tile, lockout, the 12 lines, time limit, sudden death, the ordered tiebreakers, draws,
  host ends and voids by replaying the log. `nextDeadlineMs()` says when the clock needs looking at.
- `src/room`: one whole game around the rules: players, teams, handicaps, the lobby, each player's
  manifest (their ruleset with single-segment and handicaps), `hello`/`welcome`, ready, the
  countdown, attempts and contesting, result checks (the save hash, `ruleset_ok`, the tile) and
  flags (server clock, reference time, a reported SteamID that doesn't match), acks, event texts,
  board snapshots per player, voids that reopen a game, and a snapshot for the pages. Every call
  returns what has to be sent and stored.
- `src/rules/handicaps.js` and `rules/handicaps.json`: the handicap presets (§10.1).
- `worker/`: the Worker and the game Durable Object (`GameRoom`), with socket hibernation, the
  exact-text ping answered without waking the game, storage of the room and its log, alarms for
  the countdown, the time limit and sudden death, one BXT socket per player (4003 for the old one),
  session tokens stored as hashes, files from R2, and a pages socket (`/ws/games/<id>`).
- `rules/`: the standard rulesets from the whitelist sheet (`npm run whitelist`, §10), and the extra
  files list (`extra-files.json`, with the files themselves in `files/`).
- `catalog/`: the segment catalog, one file per pool (`hl1.json` from the practice kit, §3.1).
- `tools/`: `dev-game.js` (create and run games on the local server), `fake-bxt.js` (a scripted
  BXT that joins, gets ready and plays runs), `echo.js` (a WebSocket echo server for checking BXT's
  WebSockets, e.g. under Wine).

`npm run dev` runs it all at `http://localhost:8787` with no account, BXT connects to
`ws://localhost:8787/bxt`, and `/dev/...` routes stand in for the pages and Steam login (only with
`DEV_ROUTES=true`, which `npm run dev` sets). What the web side adds: Steam login and their own
routes calling the same `GameRoom` methods (`create`, `action`, `snapshot`) after checking who is
asking; join codes in D1 in place of `worker/directory.js`; writing finished games to D1 for the
leaderboards; rate limits; deploying, domains, secrets and the production R2 buckets.

---

## 9. Implementation plan

Definition of done for every step: it works on HL WON on **Windows and on Linux (Wine/Proton)**,
and the PR passes the existing GitHub Actions jobs unchanged (§4.0). Linux is never a follow-up.

There are three tracks. Track A (BXT) is ours. Track B (backend) is the web side's on Cloudflare,
with the protocol, rules and tools from this repo (§8.2). Track C (pages) is the frontend dev's.

```
week →      1        2        3        4        5        6        7
A  BXT   [0][ 1 spikes ][2 skel][ 3 offline bingo ][ 5 net ][6 dl][ 7 evidence ][8]
B  server      [0.2 catalog][ 4 server MVP (no Steam login) ][ Steam login + frontend API ]
C  web                 [ frontend against protocol v1 + mock server ............ ]
```
(The weeks are only there to show ordering and overlap, not estimates.)

### Step 0: before writing BXT code (in parallel, mostly talking)
*Status: the protocol (0.3) and the catalog importer (0.2) are done, in JavaScript since the
backend is.*
1. **Ask the Linux runners how they run HL WON.** Known: some use Wine and some Proton. Still to
   ask: which versions, Steam for Windows in the prefix, how `Injector.exe` is launched. The retry
   save stays `hard` until the community picks another name (§4.3).
2. **Segment catalog:** a script that parses `Half-Life Practice Kit/PracticeCfgs/*.cfg` into
   `segments.json` (§3.1): trigger boxes, save name and SHA-256, label. Write it in this repo
   (`tools/catalog`, Node), next to the rules. Segments that end at the end of the game
   (Nihilanth, where the kit only sets a start trigger and BXT's autostop ends the time) get
   `"end": { "type": "game_end" }` (§3.1), and BXT learns to handle it. Every segment gets `pool`
   and `game` (§3.3): the kit's are `hl1` and `valve`. The server checks a board is one `game`, the
   manifest carries it, and BXT checks it against the game it runs in.
3. **Protocol v1:** §6 as JSDoc types and checks in `src/protocol`. That's the contract the backend,
   the pages and BXT all code against.

### Step 1: spikes (throwaway branch, not merged)
*Status: done on Windows (§7 #1, #3, #8). Wine is still to check.*
Knock out the riskiest unknowns first. Each is small, and each is tested on Windows **and** under
Wine/Proton.
1. **Board input:** subclass the game window's WndProc from BXT, toggle it with a test command, and
   call `ClientDLL::SetMouseState(false/true)`. Log cursor position and clicks with RInput on/off,
   and under Wine. This decides between the three mitigations in §4.4.
2. **Retry load hook:** wrap the engine's `load` and `save` console commands (`Cmd_FindCmd` +
   swapping the handler pointer). In the `load` wrapper, read `Cmd_Argv(1)`, resolve it to
   `<gamedir>/SAVE/<name>.sav`, hash it and log, all *before* calling the original handler. Also
   copy a file over `hard.sav` mid-game and reload it. The `save` wrapper is how we notice a
   `save hard`. (On HL WON the pattern-based `SaveGameSlot` hook isn't found, see §7 #3.)
3. **WinHTTP WebSocket:** from inside `hl.exe`, open a `wss://` echo connection (any public echo
   server, or `npm run echo` in this repo) and a `ws://` one on the worker thread, and print received
   messages via the per-frame queue. Under Wine, this establishes the minimum Wine/Proton version.
4. **Board drawing:** draw a static 5x5 grid with `pfnFillRGBA` + `pfnDrawConsoleString` from
   `hud_custom.cpp` at a few resolutions.

**Outcome:** a short note per spike added to §7. If spike 1 or 3 fails under Wine, we rethink
before building on it.

### Step 2: PR "bingo skeleton" (small, gets maintainers' buy-in on structure)
*Status: skipped. The skeleton went straight into the `bingo` branch with step 3.*
- `BunnymodXT/bingo.hpp/.cpp` (`namespace Bingo`, empty state, `Bingo::Frame()`, platform
  interface), `Windows/bingo_platform.cpp` (empty implementations), `Linux/bingo_platform.cpp` (stub),
  `CMakeLists.txt` entries, `winhttp`/`bcrypt` links.
- Cvars in `cvars.hpp`, and `Cmd_BXT_Bingo_*` commands that just print `bxt_bingo_status`.
- A call to `Bingo::Frame()` from the existing per-frame path (next to `CustomHud::TimePassed`,
  `HwDLL.cpp:~7249`).
- **Goal:** CI green in all jobs (Windows × COF, Linux, Flatpak) with zero behaviour change.

### Step 3: PR(s) "offline bingo" (the core; usable as a practice mode)
*Status: done on the `bingo` branch, plus the rules, handicaps, contesting squares and event sounds
(§1.3, §10). Left over: checking where the player is right after a load (to catch a save swapped
at the very moment it's read, §5.3). Split into two PRs if it gets big:*
- **3a, attempts:**
  - `bxt_bingo_manifest <file>` loads a local manifest JSON (rapidjson) generated from the step 0
    catalog.
  - Bingo triggers: a separate set (with an optional map), updated from the same two places as
    `CustomTriggers::Update` (`HwDLL.cpp`, `ServerDLL.cpp`).
  - BXT's own timer, driven by bingo (§4.3).
  - The attempt state machine (§4.3), `bxt_bingo_play`, copying the tile save to `hard.sav` with
    backup and restore, the hash check in the `load` wrapper, and the rules (§5.1: loads, saves,
    map, commands, cvar ruleset).
  - Results print to the console. The board state is local (first finish colours the tile) purely
    for testing.
- **3b, UI:** the mini-board in `hud_custom.cpp` (`bxt_hud_bingo*`), the interactive board
  (`bxt_bingo_board`) with WndProc input from spike 1, keyboard navigation, and closing the board
  and giving the camera back on tile pick.

### Step 4: server MVP (track B, can start alongside step 3)
*Status: done for local testing (§8.2): the Worker and game Durable Object run with `npm run dev`,
and `npm run dev-game` plus `npm run fake-bxt` play whole games against it. Not yet: demo upload
(step 7), writing results to D1 (web side).*
- A Worker and a game Durable Object, run with `wrangler dev`: a script that creates a game and
  prints join codes (no Steam login yet), join codes and session tokens in the connection headers,
  manifest serving, files, result intake with dedupe, the rules from `src/game`, board broadcasts
  with `seq`, alarms for the clock, and the event log in the Durable Object's storage.
- A small fake BXT client script, so the server is testable before BXT networking exists.

### Step 5: PR "networking"
*Status: written on the `bingo` branch, to test against the local server (`npm run dev`). Not yet:
the demo, the other clocks and `dll_sha256` (step 7), and the SteamID in `hello`.*
- WinHTTP WebSocket transport on the worker thread, and the event queues.
- The join code and session token headers, `hello`/`welcome`, `ping` every 30 s, applying
  `lobby`/`manifest`/`round_start`/`board`/`event`/`game_over`, `tile_selected`, `attempt_started`
  and `attempt_result` with `result_ack`, reconnect with backoff, and unacked results persisted to
  disk.
- Strip control characters from names and event texts before drawing them.
- The offline mode from step 3 stays available (no server = local manifest).

### Step 6: PR "downloads"
*Status: written on the `bingo` branch (§3.2), to test in the game against the local server.*
- The skip-if-hash-matches logic (§3.2), content-addressed HTTP GET, verify after download,
  `download_progress`/`ready`, and the lobby/countdown display.

### Step 7: PR "evidence"
- Three clocks in results (§5.1), per-attempt demo recording, and demo upload on `request_demo`
  (the cvar ruleset from the manifest is already built). Server side: the server-clock check,
  plausibility flags, the demo checks (§5.3), and void in the admin API.

### Step 8: polish + Steam login
- BXT: toasts for server events (the message list under the mini-board is built), countdown,
  labels hidden until start, optional SteamID in `hello`.
- Backend + pages (web side): Steam OpenID, teams from Steam users, moderation, leaderboards (§11).

### Later
HL Steam support (§7 #11), custom map packs (`extra_files`), Steam auth tickets.

### Next (concretely)
1. **Test networking in the game** against the local server (step 5), then show the time left,
   sudden death and how the game ended more clearly if needed.
2. **Test downloads in the game** (step 6).
3. **Test boards from the catalog in the game** (step 0.2), including Nihilanth (`game_end`) and
   AM5.2 (`on_load`).
4. Meanwhile: ask the Linux runners which Wine and Proton versions they use (step 0.1), and try the
   `bingo` branch there.

---

## 10. Lobby options

Checkboxes and settings the lobby creator picks in the frontend. The server turns them into what
it sends each player, so BXT never needs an update when they change.

| Option | What it does | How it reaches BXT |
|---|---|---|
| **Redo own tile** | A team may replay a tile it owns to improve its time. On by default. | `playable_for_you` in the board (§6). |
| **Lockout** | Once claimed, the other team can't steal a tile. | `playable_for_you`, and the `locked` verdict. |
| **Scriptless / scripted** | Scriptless: one command per key press or console line, and scripted-only commands and cvars (`+bxt_tas_autojump`, `bxt_autojump`, `wait`, …) are banned. Scripted: several commands per key are fine, except `+forward`, `+back`, `+left`, `+right`, `+moveleft`, `+moveright`. | The manifest's `ruleset`: `rules/won-scriptless.json` or `rules/won-scripted.json` in the server repo, made from the community whitelist sheet with `npm run whitelist -- Whitelist.ods rules`. |
| **Single-segment** | Loading any save other than the tile's own ends the run, and so does dying. Otherwise saves made during the run can be loaded and the timer keeps running, like segmented runs. | `ruleset.single_segment`. |
| **Show contesting** | Small squares in a tile's top-right corner, one per player who picked it (a click or Enter on the board, or `bxt_bingo_play`, not hovering) while their team may play it, in their team's color (3 squares and a "+N" past 4 players). | `contesting` in each tile of the board. Empty when the option is off. |
| **Time limit** | 15 minutes by default. A full line still wins at any time. When the limit runs out, the team with the most tiles wins. | `clock_ms` and `time_limit_ms` in the board, and `game_over`. |
| **Sudden death** | On by default, for 10 minutes (the length can be changed, or it can be turned off). After the time limit, on a tie, the first team to get ahead wins. | `sudden_death_ms` in the board, and `game_over`. |
| **Tiebreakers** | Any of 5 methods, in the order the lobby creator puts them, for a tie that's still left. Then a draw. | `game_over`. |
| **Handicaps** | Per-player rule changes for balancing, see below. BXT's side is built, the server's and frontend's aren't. | That player's `ruleset`. |

### 10.1 Handicaps

For balancing teams, the lobby creator can loosen or tighten the rules for single players, e.g.
allow autojump and ducktap for a newer player in a scriptless game, take `+attack2` away from
a very strong one, or make them play "No damage%".

The server already sends each player their own manifest, and BXT enforces whatever ruleset it
gets, so a handicap is the server adjusting one player's ruleset before sending it:

- **Allowing something:** add the commands to that player's `commands.allowed` and switch the
  matching cvar rules to `any`. Autojump is `+bxt_tas_autojump` plus `bxt_autojump`,
  `bxt_autojump_prediction` and `bxt_autojump_priority`, ducktap is `+bxt_tas_ducktap` plus
  `bxt_tas_ducktap_priority`. This is what the scripted ruleset already does for them.
- **Taking something away:** take the command out of that player's allowed commands and put it in
  `commands.blocked`. Aliases and configs are expanded before checking, so it can't be sneaked
  through a bind. Blocked commands are dropped from picking the tile on, and a blocked `+command`
  the player was already holding is released when the run starts.
- **Changing the physics:** a cvar rule with op `set` (Jupiter's `sv_gravity 2021.61`). BXT sets
  the cvar while the board is loaded and puts the player's own value back when they leave, and
  the rule keeps it there like `eq`. BXT sets it again every frame, as loading a map resets some
  of them (`sv_gravity`, `sv_stepsize`, and `sv_zmax` from the map's `MaxRange`). Only `sv_`
  cvars, so a manifest can't touch the player's own settings.
- **Single-segment:** `ruleset.single_segment` for that player: loading a save other than the
  tile's own, or dying, cancels the run.
- **Bloodthirsty:** `ruleset.require_kill`. A run only counts if the player killed an enemy monster
  after the start trigger. BXT counts kills in its `CBaseMonster::Killed` hook (found on HL WON's
  `hl.dll` with the existing "Wanted!" pattern): a monster the player's attack killed, including
  their grenades, satchels and tripmines. Scientists, security guards, cockroaches, rats, floaters
  and birds don't count. Monsters that die without that function (turrets, the Apache, the
  Osprey, barnacles) don't count either. A finish without a kill is sent as `attempt_invalidated`.
- **No damage%:** `ruleset.no_damage`. Any drop in health or armor after the start trigger
  invalidates the run the way BXT handles a prevented hornet crash: the timer turns red with
  INVALID and the player can keep playing, but the finish doesn't count. BXT checks health and
  armor every frame, starting over after loads (a loaded save can have less health without any
  damage), so BXT's own damage hooks stay untouched.

Decisions:

1. **Presets, not raw commands.** A `rules/handicaps.json` in the server repo defines named
   handicaps ("Autojump", "Ducktap", "No +attack2", …), each a small patch to a ruleset. The
   frontend offers them as checkboxes per player. Nobody can build a broken ruleset by typing
   command names, and new presets are one entry each.
   Each preset is an **assist**, which makes runs easier (Autojump, Ducktap), or a **handicap**,
   which makes them harder (No +attack2, No damage%). "Handicaps" still names both, as in the
   lobby option. Assists count against the team in the "most handicaps" tiebreaker (§10.2). The
   pages could show them apart, e.g. as "assists" and "handicaps".
2. **Visible to everyone.** The frontend shows each player's handicaps next to their name. BXT
   prints the player's own when they pick a tile and in `bxt_bingo_status`. Results record the
   handicaps they were set under, so a reviewer (§5.2) knows which rules applied.
3. **Blocked, not cancelled.** A banned command normally cancels the run. For a handicap that's too
   harsh, as a stray mouse2 press would throw away a good run. Commands in `commands.blocked` are
   dropped instead: BXT doesn't pass them to the engine, prints a note, and the run carries on.
   This is the one BXT change, in the key and console hook that already checks commands
   (`Bingo::OnPlayerCommand`).

Built:

- Protocol: `CommandRules.blocked` (same patterns as `allowed`, a key or console line that runs a
  blocked command is dropped whole) and `Ruleset.no_damage`.
- BXT: dropping blocked commands in the key and console hook, the damage check, setting `set`
  cvars, the kill count, the death check for single-segment runs, and printing the player's
  handicaps when they pick a tile and in `bxt_bingo_status`. Offline test board:
  `handicaps.json` (scriptless, `+attack2` blocked, no damage).

To build:

- Server (this repo, done): the presets, applying them to each player's manifest, the
  `handicaps` host action, and the tiebreaker count. `rules/handicaps.json` has:

  | Id | Name | Kind | What it does |
  |---|---|---|---|
  | `autojump` | Autojump | assist | allows `+bxt_tas_autojump` and the `bxt_autojump` cvars |
  | `ducktap` | Ducktap | assist | allows `+bxt_tas_ducktap` and `bxt_tas_ducktap_priority` |
  | `no_attack2` | No +attack2 | handicap | blocks `+attack2` |
  | `no_damage` | No damage% | handicap | taking damage invalidates the run |
  | `duckless` | Duckless | handicap | blocks `+duck`, `+bxt_tas_ducktap` and `+bxt_tas_jumpbug` |
  | `jumpless` | Jumpless | handicap | blocks `+jump`, `+bxt_tas_autojump` and `+bxt_tas_jumpbug` |
  | `useless` | Useless | handicap | blocks `+use` |
  | `pacifist` | Pacifist | handicap | blocks `+attack` and `+attack2` |
  | `bloodthirsty` | Bloodthirsty | handicap | the run only counts with a kill |
  | `single_segment` | Single-segment | handicap | loading a save or dying cancels the run |
  | `jupiter` | Jupiter | handicap | `sv_gravity 2021.61` (×2.53) |
  | `mars` | Mars | handicap | `sv_gravity 302.55` (×0.38) |
  | `short_sighted` | Short-sighted | handicap | `sv_zmax 128` |
  | `baby` | Baby | handicap | `sv_stepsize 0` |
  | `reverse` | Reverse | handicap | `sv_airaccelerate -1` and `sv_accelerate -5` |
  | `cs16` | CS 1.6 | handicap | `sv_maxspeed 250` and `sv_accelerate 5` |

  Jumpbug blocks both, as it ducks and jumps. When two of them set the same cvar (Reverse and
  CS 1.6), the later one wins.
- Protocol: the handicaps a player has in results (the lobby has them, `players[].handicaps`).
- Web side: storing them with results in D1.
- Frontend: per-player handicap checkboxes, and showing them in the lobby and on results.

### 10.2 How a game ends

The lobby creator sets all of this in the frontend.

1. **A full row, column or diagonal wins at any time**, including during sudden death.
2. **Time limit** (15 minutes by default): when it runs out, the team with the most tiles wins.
3. **Sudden death**, on by default for 10 minutes: if the teams have the same number of
   tiles at the time limit, the game keeps going, and the first team to get ahead wins straight
   away. Getting ahead means a capture or a steal that breaks the tie.
4. **Tiebreakers**, if the tiles are still even after the time limit (without sudden death) or
   after sudden death runs out. There are **none by default**: the lobby creator picks any of these
   methods and puts them in order. They're checked in that order, and the first one that separates the teams decides the
   winner, so the rest aren't checked:
   - **Highest total time:** the sum of the times on each team's tiles, and the higher sum wins.
     Example: red holds 12.5 s and 8.7 s (21.2 s), blue holds 10.4 s and 15.6 s (26 s), so blue
     wins.
   - **Most steals:** the team that took more tiles from the other team during the game wins.
     Example: red took 4 of blue's tiles and blue took 2 of red's, so red wins.
   - **First to the final score:** the team that first reached the final tile count earlier in the
     game wins, even if it went above that count and came back down later. Example, with a final
     score of 10 each:
     1. 14:33, red captures a free tile: red 10, blue 9.
     2. 14:45, red captures a free tile: red 11, blue 9.
     3. 14:50, blue steals a red tile: red 10, blue 10.

     Red first had 10 tiles at 14:33 and blue at 14:50, so red wins.
   - **Fewest players:** the team with fewer players wins.
   - **Most handicaps:** the team whose players have more handicaps in total (§10.1) wins. Assists
     count against the team: each handicap counts +1 and each assist −1. Example: red has
     No damage% and No +attack2 (+2), blue has No damage% and Autojump (+1 − 1 = 0), so red wins.
5. **Draw:** if the teams are still even after all of the above.

A result that reaches the server at or after the end of the game doesn't count (`game_over`),
even if the run started before.

Built: the rules in `src/game` with tests, the example above among them, the protocol
(`game_over.reason` and `tiebreaker`, the clock in `board`), and the server side: the options as
room settings, the Durable Object's alarm at the time limit and the end of sudden death, and the
team sizes and handicap counts for the tiebreakers.

To build:

- BXT: show the time left on the board and the mini-board, "Sudden death" while it's on, and how
  the game ended.
- Frontend: the options (time limit, sudden death and its length, the tiebreakers and their
  order), the countdown, and how the game ended.

---

## 11. Leaderboards and rating

The web side builds these (`BINGO-WEB.md` §9). Decided so far:

- **All time only, no seasons.** HL speedrunning doesn't have that many players, so seasons would
  feel empty.
- **Only ranked games count.** The host picks ranked or casual when creating the game.
- **Which leaderboards a game counts for** is in its snapshot (`leaderboards`, from
  `Room.leaderboards()`). A game is **handicapped** if any player had at least one handicap or
  assist (§10.1) when it started, or got one during it.
- **Two player leaderboards** (wins, rating): **standard** and **handicapped**. In a scripted or
  single-segment game both teams play under the same rules, so winning still shows skill and
  those games count as standard. Handicaps change who wins, so those games have their own board,
  for players who want to see how they rank when teams are balanced out.
- **Four segment leaderboards** (best times per segment), because the rules change what a time
  means: scripted runs can use autojump and ducktap, and single-segment runs can't load their own
  saves. Mixed together, a list would mostly rank by which rules a game had. Each game's times go
  on one of them:
  1. **Handicapped:** the game was handicapped. This comes first, whatever else is set.
  2. **Single-segment:** the single-segment option was on.
  3. **Scripted:** the scripted ruleset.
  4. **Scriptless:** the standard one.
- **Flagged times count only once accepted,** and voided times never count.
- **Records need a demo:** a time that becomes a segment's best or enters its top 3 gets its demo
  requested automatically.
- **Skill rating: OpenSkill, from team results only.** Ranked games only, and a draw is a tie.
  Everyone on a team gains or loses the same, scaled by how sure the rating is about each player.
  That means a player who only took free tiles and was never contested gains as much as the one
  who carried, which evens out over many games with different teammates. Rating each player's
  contribution was left out on purpose: deciding what counts is hard (defending a tile against
  slower finishes counts, improving your own tile with nobody on it barely does), and any score
  would make players pad stats instead of playing for the line. Instead, each player's captures,
  steals, defenses and improvements are shown next to the rating, not inside it. Revisit once
  there's real data.

## 12. To tell the web side

Decided since `BINGO-WEB.md` was written:

1. **The Worker and the game Durable Object are written here** (§8.2) and run locally. The web side
   adds what needs their account (Steam login, D1, deploying) and their page routes on top.
2. **Contesting follows `tile_selected`**, as they proposed (§6). The board's list is called
   `contesting`.
3. **Endings:** ours, §10.2 (most tiles, then sudden death only on a tie, then the ordered
   tiebreakers, then a draw), not the choice between draw, most tiles and "next capture wins".
4. **Leaderboards:** two for players (standard and handicapped) and four for segment times
   (scriptless, scripted, single-segment and handicapped), §11.
5. **Anyone signed in with the link can join.** The host watches for strangers and kicks or bans
   them. No "accept players" step.
6. **Sudden death is on by default,** for 10 minutes.
7. **Flagged results** keep their real verdict, with `flagged: true` (§6).
8. **Late results don't count:** a run that finishes after the game ended gets `game_over`, even if
   it started before.
9. **The win sound** (`firework.wav`) is hosted like the saves and listed in the manifest's
   `extra_files`. Don't know who made it, came from an HL or AG server years ago and it's very unlikely that someone complains that we're using the sound they made without consent.
10. **Segments that end with the game** (Nihilanth) have `"end": { "type": "game_end" }`.
11. **No tiebreakers by default:** the host adds them and puts them in order (§10.2).
12. **Where BXT downloads files:** the manifest's `files_url`, from the Worker's `FILES_URL`
    variable. Production sets it to the public bucket, e.g. `https://assets.jrik.dev/bingo/files/`.
    Without it, BXT downloads from the Worker's own `/files/<sha256>` (§3.2).
13. **Which segment is on each tile** (their request): the pages get it in a `tiles` message and in
    the snapshot, hidden like the labels, chapter included (§6, "Server → pages").
14. **Pools** (planned, §3.3): the host picks which pools a board is drawn from, and the board
    picker draws from those. Segments get `pool` and `game`, and a board is always one game.
15. The other protocol differences, listed under §6.

Nothing is open right now.
