# bxt-bingo-server

The backend for BXT Bingo: a Trackmania-Bingo-style community game for Half-Life speedrunning,
played in-game through [BunnymodXT](https://github.com/YaLTeR/BunnymodXT) with web pages on
jrik.dev. It runs on Cloudflare: a Worker, one Durable Object per game, and a D1 database for
players, sign-ins, join codes and the games played. Everything runs locally too. The full design lives in `BINGO.md`.
The web side's is `BINGO-WEB.md`, kept by the frontend dev.

This has been done mostly with AI as you can probably tell from how things are formatted, but it's been
tweaked and reviewed by real developers and thoroughly playtested. Of course it still might have
bugs and things to be polished, but just letting you know that it's not a one-prompt vibe-coded app.

## Layout

| Path | What |
|---|---|
| `src/protocol` | Wire protocol: BXT ⇄ server messages as JSDoc types, tile ids, segment and ruleset shapes, and `parseClientMessage`, the strict check for everything BXT sends. |
| `src/game` | Game rules as pure logic: capture, steal (strictly faster, ties keep the first time), redo own tile, lockout, the 12 lines, time limit, sudden death, tiebreakers, draws, host ends, and voids by replaying the event log. |
| `src/room` | One whole game around the rules: players, lobby, manifests, attempts, result checks and flags, board snapshots, events. Pure logic too: every call returns what to send and store. |
| `src/rules` | Handicaps: applying the presets from `rules/handicaps.json` to a player's ruleset. |
| `worker/` | The Worker (routes) and the game Durable Object (`GameRoom`): sockets with hibernation, storage, alarms. |
| `worker/web.js` | The routes the web pages call (§ Web routes): Steam sign-in, making and joining games, the host's actions. With `steam.js` (checking Steam's sign-in answers, names and avatars), `auth.js` (sessions in a cookie, the private test server's allowlist, which pages may call), `codes.js` (join codes), `settings.js` (checking a host's lobby options), `records.js` (each game in D1: its state, ending, players and results) and `db.js` (the D1 tables, made on first use). |
| `rules/` | The standard rulesets made from the community's whitelist sheet, the handicap presets, and the list of extra files. |
| `files/` | Extra files the game downloads, like the win sound, as listed in `rules/extra-files.json`. |
| `catalog/` | The segment catalog, one file per pool: `hl1.json`, made from the Half-Life Practice Kit. |
| `boards/` | Test boards: BXT's offline manifests, also used by `dev-game create`. |
| `tools/dev-game.js` | Creates and runs games on the local server, standing in for the web pages. |
| `tools/fake-bxt.js` | A scripted BXT: joins with a code, gets ready and plays runs. |
| `tools/catalog` | Makes `catalog/hl1.json` from the practice kit: `npm run catalog -- "<Half-Life Practice Kit folder>"`. |
| `tools/whitelist` | Makes `rules/` from the sheet (exported as .ods, the colors matter): `npm run whitelist -- Whitelist.ods rules`. |
| `tools/echo.js` | WebSocket echo server for checking BXT's WebSockets (e.g. under Wine): `npm run echo`, listens on `ws://127.0.0.1:8765`. |
| `test/` | Tests for `src/`, the catalog importer and the whitelist tool. |

`src/` has no dependencies and no Cloudflare or Node APIs, so it runs in a Worker, in Node and in
the browser.

## Development

Needs Node 22 or later.

```sh
npm install     # only wrangler, for the local server
npm test
```

The code is plain JavaScript with JSDoc types. `jsconfig.json` makes editors like VS Code check
them. The tests of sessions, join codes and game records use `node:sqlite` in place of D1, from Node
22.13; on older versions they're skipped.

## Playing locally

### 1. Start the server

```sh
npm run dev
```

It runs the whole backend at `http://localhost:8787`, with no Cloudflare account. Games and files
are kept in `.wrangler/` between runs. Leave it running, and use a second terminal for the rest.
It reloads by itself when a file in the repo changes, and connected games reconnect.

### 2. Make a game

```sh
# 25 random segments from the catalog, with the saves so BXT can download them
npm run dev-game -- create catalog --players red:naz,blue:bot --saves "../Half-Life Practice Kit/SAVE"
```

It prints the game's id, the board, and one line per player, with their steamid64 and join code:

```
game cb3f1fd5683dfea9
  A1 NIHI1    B1 AM5.2    C1 OAR2.1   D1 APP4     E1 BP4.1
  ...
red   naz              76561101611194284  bxt_bingo_join NJ33-CC
blue  bot              76561107401299059  bxt_bingo_join R58K-AD
```

Every `create` makes a new game, with new steamid64s for the players, so use the ones it just
printed. Instead of `catalog`, a board file works too: `boards/` has the three test boards
(§ Offline play below). The options:

| Option | What it does |
|---|---|
| `--pools hl1` | Only segments from these pools (with `catalog`). |
| `--segments nihi-1-0,oar-2-1` | These segments first, from A1 on, and the rest at random (with `catalog`). |
| `--players red:naz,blue:bot` | Players to add, as `team:name`. `none:name` adds one without a team. |
| `--ruleset scripted` | The rules: `scriptless` (the default) or `scripted`, from `rules/`. |
| `--saves <folder>` | Uploads the board's saves from this folder (e.g. `valve_WON/SAVE`), so BXT can download the ones a player doesn't have. |
| `--settings name=value,...` | The lobby options below. |
| `--server http://...` | Another server than `http://localhost:8787`. |

| Setting | Default | What it does |
|---|---|---|
| `timeLimitMs` | `900000` (15 min) | When it runs out, the team with more tiles wins. `null` turns it off. |
| `suddenDeathMs` | `600000` (10 min) | Sudden death after the time limit when the tiles are even. `null` turns it off. |
| `tiebreakers` | none | In order: `total_time`, `steals`, `first_to_final_score`, `fewest_players`, `most_handicaps` (BINGO.md §10.2). |
| `redoOwnTile` | `true` | A team may replay its own tile to improve the time. |
| `lockout` | `false` | A claimed tile can't be stolen. |
| `singleSegment` | `false` | Loading a save or dying cancels a run. |
| `hideLabels` | `false` | Tile labels stay hidden until the game starts. |
| `showContesting` | `true` | Players see who's playing which tile. |
| `countdownMs` | `5000` | The countdown before the start. |
| `maxPlayers` | `16` | |

Some examples:

```sh
# A short game to test the ending: 2 minutes, then 1 minute of sudden death, then the tiebreakers
npm run dev-game -- create boards/scriptless.json --players red:naz,blue:bot --settings timeLimitMs=120000,suddenDeathMs=60000,tiebreakers=total_time,steals

# Scripted rules, lockout, no time limit, labels hidden until the start
npm run dev-game -- create boards/scripted.json --ruleset scripted --players red:naz,blue:bot --settings lockout=true,timeLimitMs=null,hideLabels=true

# Nihilanth on A1, to test a segment that ends with the game
npm run dev-game -- create catalog --segments nihi-1-0 --players red:naz --saves "../Half-Life Practice Kit/SAVE"

# One of the test boards, with the saves from your game's SAVE folder
npm run dev-game -- create boards/scriptless.json --players red:naz --saves ../valve_WON/SAVE
```

### 3. Join

In the game: `bxt_bingo_server localhost:8787` once, then `bxt_bingo_join <code>` with the player's
code. A code works once and for 10 minutes; `code` gives a new one (below).

A fake player stands in for the other team. It joins, gets ready, and plays when the game runs:

```sh
npm run fake-bxt -- R58K-AD --runs 3
# Options: --tiles A1,B1 (which tiles, in order), --time 30000 (the time it reports, in ms),
# --wait 1000 (how long each run takes), --quiet
```

### 4. Start and watch

```sh
npm run dev-game -- start cb3f1fd5683dfea9
# Or without waiting for everyone to be ready:
npm run dev-game -- start cb3f1fd5683dfea9 force=true

npm run dev-game -- show cb3f1fd5683dfea9
```

`show` prints the whole game: the settings, the players with their steamid64s
(`lobby.players`), the board, every result with its `attempt_id` (`results`), the banned players
and how it ended.

### 5. Host actions

Each one is `npm run dev-game -- <action> <game> name=value ...`. With `cb3f1fd5683dfea9` as the
game and `76561101611194284` as a player:

```sh
# Players
npm run dev-game -- player cb3f1fd5683dfea9 blue edd                       # add a player, prints their code
npm run dev-game -- code cb3f1fd5683dfea9 76561101611194284                # a new join code for a player
npm run dev-game -- move cb3f1fd5683dfea9 steamid64=76561101611194284 team=blue
npm run dev-game -- move cb3f1fd5683dfea9 steamid64=76561101611194284 team=null   # off the teams
npm run dev-game -- kick cb3f1fd5683dfea9 steamid64=76561101611194284
npm run dev-game -- kick cb3f1fd5683dfea9 steamid64=76561101611194284 ban=true    # can't join again
npm run dev-game -- unban cb3f1fd5683dfea9 steamid64=76561101611194284
npm run dev-game -- player cb3f1fd5683dfea9 red naz 76561101611194284      # back in, after unban
npm run dev-game -- lock cb3f1fd5683dfea9 locked=true                      # no new players

# Handicaps, by id from rules/handicaps.json. An empty list takes them away
npm run dev-game -- handicaps cb3f1fd5683dfea9 steamid64=76561101611194284 handicaps=jupiter,pacifist
npm run dev-game -- handicaps cb3f1fd5683dfea9 steamid64=76561101611194284 handicaps=

# Results, by attempt_id from `show`
npm run dev-game -- void cb3f1fd5683dfea9 attempt_id=4ccb54de-0379-4e72-8fa2-33618b4c27b2
npm run dev-game -- accept cb3f1fd5683dfea9 attempt_id=4ccb54de-0379-4e72-8fa2-33618b4c27b2

npm run dev-game -- end cb3f1fd5683dfea9                                   # end the game now
```

Once a game is over, players can't be added, moved, kicked or given handicaps, but `void` and
`accept` still work. The handicap ids:

| Assists | Handicaps |
|---|---|
| `autojump`, `ducktap` | `no_attack2`, `no_damage`, `duckless`, `jumpless`, `useless`, `pacifist`, `bloodthirsty`, `single_segment`, `jupiter`, `mars`, `short_sighted`, `baby`, `reverse`, `cs16` |

What each one does is in BINGO.md §10.1.

## Web routes

The pages (on jrik.dev, or served by this Worker on the private test server) call these. Actions
need a signed-in player and must come from the pages: this Worker's own origin, or one listed in
`PAGE_ORIGINS` (e.g. `https://jrik.dev`), which also get CORS with credentials.

| Route | What |
|---|---|
| `GET /auth/steam/login?return=<page>` | To Steam's sign-in page, and back to `<page>` after (a path here, or a page on `PAGE_ORIGINS`). |
| `GET /auth/steam/callback` | Steam's answer: it must come back to the browser that asked (a cookie), Steam confirms it (`check_authentication`), each answer works once, then the player is stored (Steam name and avatar with `STEAM_API_KEY`) and signed in with a session cookie (`__Host-`, `HttpOnly`, `Secure`, `SameSite=Lax`; only its hash is stored). |
| `POST /auth/logout` | Ends the session. |
| `GET /api/me[?game=<id>]` | Who is signed in, whether this is a private server, and for a game: whether they host it and their lobby entry. |
| `GET /api/me/games` | The 50 latest games they host or are in: state, how it ended, tiles per team, board, players, their team. Up to 10 of them that D1 has as unfinished are checked with their game first, which writes its record again if D1 is behind. |
| `GET /api/boards` | The boards a game can be made with: `random` (with the catalog's pools and the rulesets) and the two test boards. |
| `POST /api/games` | `{ board, settings }`: makes a game, hosted by whoever made it. The settings are checked key by key (`worker/settings.js`). A random board also takes `ruleset` (`scriptless` or `scripted`) and `pools` (e.g. `["hl1"]`): 25 different segments drawn from those pools (`worker/boards.js`, one game only). The test boards' tiles are the catalog's segments (same label, save and triggers), so they get the catalog's ids and chapters. |
| `POST /api/games/<id>/join` | `{ team }` (`red`, `blue` or `null`): joins, or changes team before the start, and gives a join code for `bxt_bingo_join`. |
| `POST /api/games/<id>/code` | A new join code for a player of the game. |
| `POST /api/games/<id>/host/<action>` | The host only: `start` `{ force }`, `end`, `move` `{ steamid64, team }`, `kick` `{ steamid64, ban }`, `unban`, `lock` `{ locked }`, `handicaps` `{ steamid64, handicaps }`, `void` / `accept` `{ attempt_id }`. |

Games made through these routes are kept in D1 as they go (`worker/records.js`): the game writes its
row (state, start and end, winner, how it ended, tiles per team, which leaderboards it counts for)
and its players after each change that alters them, and once it's finished every result (voided and
flagged ones marked), for the game lists now and the leaderboards later. Recording never stops the
game: a write that fails is tried again at the next change, or when a game list asks. A void that reopens a game
sets it back to running until it ends again. Games made with the dev routes aren't kept.

Join codes are in D1: single use, 10 minutes, one player, stored as hashes. Typing codes into BXT
is rate limited per address, as are sign-ins, joins, new games and host actions (per player).
`GET /api/games/<id>` is public and has `Access-Control-Allow-Origin: *`. Browser sockets
(`/ws/games/<id>`) from other sites' pages are refused.

Testing pages locally without Steam: with `npm run dev`, open
`http://localhost:8787/dev/login?steamid64=<17 digits>&name=<name>&return=<page>` to be signed in as
anyone (only on localhost). Pages on another local port, or opened from disk, may call the local
server.

## The private test server

`env.staging` in `wrangler.toml` is a private copy at `bingo-staging.jrik.dev`, with its own
storage, for real games between testers. Only the SteamIDs in its `ALLOWED_STEAMIDS` secret can sign
in, and without signing in nothing but BXT's socket, the files and the sign-in itself answers. With
an `ACCESS` service binding (another Worker of the same account with an RPC method
`allowed(steamid64)`), that Worker decides instead of the secret, at every sign-in and request, and
nobody gets in while it can't be asked; this one asks the member list of jrik.dev. It
serves the web pages too, from the `bingo-pages-staging` bucket (`bingo/index.html`,
`bingo/game/index.html`...), after checking who is signed in; putting a new file there updates a page
without a deploy. The first deploy makes the D1 database, and the Worker makes its tables on first
use.

```sh
npx wrangler login
npx wrangler r2 bucket create bingo-files-staging
npx wrangler r2 bucket create bingo-pages-staging
npx wrangler deploy --env staging
npx wrangler secret put ALLOWED_STEAMIDS --env staging   # without ACCESS: e.g. 76561197960000000,76561198000000000
npx wrangler secret put STEAM_API_KEY --env staging      # from steamcommunity.com/dev/apikey
# The pages
npx wrangler r2 object put bingo-pages-staging/bingo/index.html --file <page> --content-type "text/html; charset=utf-8" --remote
# The board's saves and the extra files from files/, each under its SHA-256
npx wrangler r2 object put bingo-files-staging/<sha256> --file <file> --content-type application/octet-stream --remote
```

## Offline play

BXT can play a board without a server: `bxt_bingo_manifest <file>` loads one from the Half-Life
folder or the game folder, and `bxt_bingo_leave` puts it away. `boards/` has three to copy into
`valve_WON`: `scriptless.json`, `scripted.json`, and `handicaps.json` (scriptless, with `+attack2`
blocked and no damage).

A board alone isn't enough: BXT loads each tile from its own copy of the save, in `SAVE` as
`bingo_<the first 12 characters of the save's sha256>.sav`. The easiest way to get them is to play
one online game with that board, as BXT downloads them then. The saves aren't in this repo, as
they're the practice kit's.

The boards carry a copy of the rules from `rules/`. `npm run whitelist` doesn't update them, so
copy the new rules in when the whitelist changes. Online games draw from the catalog instead.

## The catalog

`catalog/hl1.json` has every segment of the Half-Life Practice Kit that bingo can use (197), with
its triggers, label, chapter and save hash. To make it again, e.g. after the kit changes:

```sh
npm run catalog -- "../Half-Life Practice Kit"
```

It lists the cfgs it left out and why. A segment whose save or triggers changed should get a new
id (BINGO.md §3.1), as the leaderboards key times by segment id.

## Protocol basics

- Every message is one JSON text message with a snake_case `type`, e.g. `{"type": "tile_selected", "tile": "B3"}`.
- Tiles are `A1`..`E5`: the letter is the column, the number is the row.
- Times are whole milliseconds. `attempt_id` is a UUID made by BXT. Resending a result with the
  same id is safe, the server dedupes it.
- `PROTOCOL_VERSION` in `src/protocol/messages.js` is bumped on breaking changes.
