# LEGO from my bricks

[![M8ven Score](https://m8ven.ai/badge/mcp/elcodabra-lego-build-inventory-nwdiqy?v=c6a6ea638e77bd9534bf8ded1479b9e0)](https://m8ven.ai/mcp/elcodabra-lego-build-inventory-nwdiqy?s=readme)

A Skill plus an MCP server for Claude and ChatGPT. It designs LEGO models **only from the parts you actually own**, checks that the model holds together and that you have enough of every part, and renders step-by-step instructions in the style of an official booklet (PNG, mp4 1080×1920 / 1920×1080).

**Main scenario: photograph your parts → get ideas for what you can build → get the instructions.**

```
📷 photo of one part  → Brickognize (part number + colour) ─┐
📷 photo of a pile    → Claude/ChatGPT reads it by eye → CSV ─┼→ inventory → ideas_suggest → idea_build → preview / mp4
sets / CSV / BrickLink                                    ─┘
```

Ideas are parametric models: house, tree, mushroom, rocket, robot, tower, heart, pyramid. Each is built from your parts: it picks the largest size that fits, the colours you have, and the part lengths available. Every proposed model passes the check (no overlaps, nothing floating, all parts in the inventory). Alongside the ideas that build now, it lists the ones that are close, with the exact parts missing. On top of the ideas, the agent can design any custom model from the same parts.

Built on the [siliconbag/lego-build](https://github.com/siliconbag/lego-build) engine (MIT). On top of it this repo adds an inventory, a check against the inventory with substitute suggestions, JSON models, the MCP server, and packaging for Claude Code, claude.ai, Claude Desktop, Codex and ChatGPT.

```
.claude-plugin/marketplace.json        Claude Code marketplace
.agents/plugins/marketplace.json       ChatGPT desktop / Codex marketplace
plugins/lego-inventory-build/
  .claude-plugin/plugin.json           Claude plugin: skill + MCP (stdio)
  plugin.json, mcp.json                portable Agent Plugins manifest (OpenAI)
  skills/lego-inventory-build/         self-contained skill: SKILL.md, engine, CLI, MCP server
scripts/install.sh                     installing and packaging
```

## Which option to pick

| Where | What to connect | How |
|---|---|---|
| **Claude Code** | plugin (skill + MCP) | `scripts/install.sh claude-code` or `/plugin marketplace add <repo>` → `/plugin install lego-inventory-build@lego-tools` |
| **claude.ai** (web/app) | skill zip | `scripts/install.sh zip` → Settings → Capabilities → Skills → Upload. Needs code execution. No network in the sandbox, so rendering is local only |
| **Claude Desktop** | MCP (stdio) | `scripts/install.sh desktop` prints the JSON for `claude_desktop_config.json` |
| **Codex CLI / ChatGPT desktop** | plugin (skill + MCP) | `codex plugin marketplace add <repo>` → `codex plugin add lego-inventory-build@lego-tools` (or `scripts/install.sh codex`) |
| **ChatGPT web** | remote MCP (HTTP) | see below |

On first launch the MCP server runs `npm install` and fetches Chromium for Playwright by itself (~100 MB, once). You also need **Node 20+** and **ffmpeg** (only for mp4).

### ChatGPT (web, developer mode)

ChatGPT only connects to MCP servers over a public HTTPS URL.

```bash
cd plugins/lego-inventory-build/skills/lego-inventory-build
npm run setup
LEGO_MCP_TOKEN=$(openssl rand -hex 16) PUBLIC_URL=https://<your-tunnel> npm run mcp:http   # :8787/mcp
# in another terminal: cloudflared tunnel --url http://localhost:8787   (or ngrok http 8787)
```

1. ChatGPT → Settings → Security and login → **Developer mode**.
2. chatgpt.com/plugins → **+** → URL `https://<tunnel>/mcp?key=<LEGO_MCP_TOKEN>`, auth: No Authentication.
3. In the chat: **+** → Developer mode → LEGO. Prompt: *"Use the lego app. Here are my sets 31058 and 10696, what can I build?"*

The token in `?key=` is simple protection for personal use. For a public service you'd need OAuth and your own hosting (Fly.io, Render, any VPS with Chromium and ffmpeg). Links to mp4/PNG are served from `PUBLIC_URL/files/...`.

## MCP tools

| Tool | What it does |
|---|---|
| `parts_from_photo` | photos of single parts → part number and colour (Brickognize), `add=true` adds them to the inventory. In ChatGPT it accepts uploaded files (`openai/fileParams`) |
| `lego_photo_guide` | how to read a pile of parts from a photo by eye and write a CSV |
| `ideas_suggest` / `idea_build` | what can be built from the inventory right now and what is close; generate the chosen idea |
| `inventory_show` / `inventory_import` / `inventory_add_set` / `inventory_update` / `inventory_clear` | parts inventory: CSV, Rebrickable CSV, BrickLink XML, JSON, set numbers (needs `REBRICKABLE_API_KEY`) |
| `lego_guide`, `lego_catalog` | modelling rules, parts and colours the engine can draw |
| `model_check` | overlaps, floating parts, parts missing from the inventory plus spare substitutes |
| `model_bom` | parts list (CSV for a BrickLink wanted list) |
| `model_save` / `model_list` / `model_get` | saved models and the examples (cat, microduck) |
| `model_preview` | PNG frames straight into the chat (the model can see them and fix things) |
| `model_render` | mp4 of the build |

Data lives in `~/.lego-build/` (`LEGO_DATA_DIR`) and is shared between the skill CLI and the MCP server.

## CLI (what the skill uses)

```bash
cd plugins/lego-inventory-build/skills/lego-inventory-build
node tools/photo.cjs --add --qty 4 part1.jpg part2.jpg   # photos of single parts → inventory
node tools/ideas.cjs                             # what can be built now and what is close
node tools/ideas.cjs build house                 # → models/house.json (already checked)
node tools/snap.cjs final --model models/house.json
node tools/inventory.cjs add-set 31058          # or: import my.csv / add 3001 red 4
node tools/inventory.cjs show
node tools/model-json.cjs microduck > models/duck.json
node tools/check-model.cjs models/duck.json      # geometry + inventory
node tools/inventory.cjs fit models/duck.json    # what's missing and substitutes
node tools/snap.cjs 3 final --model models/duck.json
node tools/render.cjs --model models/duck.json
npm test                                         # e2e: CLI + MCP stdio + MCP HTTP (add --render for mp4)
```

## Limitations

- **Photos.** Brickognize recognises one part per photo (the most prominent one) and needs network access. A pile is read by the chat model itself (Claude/ChatGPT vision): that works, but the count is approximate and similar parts (1×4 vs 1×6, light vs dark grey) can get mixed up, so the agent shows the list for confirmation. Best results: parts laid out on a plain background, not overlapping, in daylight. HEIC must be converted to JPEG.
- **Ideas.** There are 8 parametric templates. Anything beyond them the agent designs by hand, and the check applies all the same.
- The engine draws 47 common parts (bricks, plates, tiles, slopes, round parts, SNOT 87087, Technic 3700/3701). Other parts from the inventory are kept but not used in models. New parts go into `src/lego.js` (see `reference/modeling.md`).
- Palette of 34 colours with BrickLink/Rebrickable id mapping. Import reports the colours it skipped.
- The check is geometric. Strength, clutch power and balance are not checked, so a model "passes the check" but isn't "tested by hand".
- LEGO® is a trademark of the LEGO Group. This project is not affiliated with it.

## Checking a deployed server

```bash
cd plugins/lego-inventory-build/skills/lego-inventory-build
node test/remote.mjs "https://<app>/mcp?key=<key>" --render              # all tools, live
node test/make-test-photos.cjs ~/Desktop/lego-test                        # test photos + answer CSV for the pile
node test/chatgpt-sim.mjs "https://<app>/mcp?key=<key>" <photo URL>...    # photos in ChatGPT's format (files: download_url)
node test/chatgpt-flow.mjs "https://<app>/mcp?key=<key>" pile.csv --render # pile → ideas → build → preview → video
vercel logs --follow --json | grep '"ev"'                                  # which tools ChatGPT calls, time taken, errors
```
