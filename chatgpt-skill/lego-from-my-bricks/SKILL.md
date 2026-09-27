---
name: lego-from-my-bricks
description: Suggests what to build from the user's own LEGO bricks and gives step-by-step build pictures. Use when the user shows photos of their LEGO parts or lists their parts/sets and asks what they can build, wants ideas, instructions or a parts list for a small model (house, tree, rocket, robot, tower, mushroom, heart, pyramid, or a custom one). Triggers — "что собрать из моих деталей", "вот мои лего детали", "сфоткал лего, что можно сделать", "инструкция из моих кубиков", "what can I build with these LEGO bricks", "build ideas from my parts". Not for buying sets, prices or official LEGO instructions.
---

# LEGO from my bricks

The user wants to build something from the LEGO parts they actually have. The result is a short answer with **pictures shown inline in the chat**: the finished model first, step pictures only when asked. Explicit user instructions override anything here.

**Show images, don't attach them.** Always display generated PNGs inline (as images in the reply). Never answer with a list of file attachments or links to `.svg` files, and never just link a video: if you cannot display something inline, say so in one line.

## Two ways to run

**A. With the MCP app "LEGO из моих деталей" connected** (tools like `parts_from_pile_photo`, `ideas_suggest`, `show_build`): use the tools, they do recognition, building and rendering on the server. Follow the "MCP flow" below.

**B. Without the app** (only this skill): run the Node scripts in `scripts/` in the code sandbox. They need only Node, no npm install. Follow the "Script flow".

Check which tools are available first; prefer A.

## MCP flow

1. **Parts.**
   - Photo with many parts → call `parts_from_pile_photo` with the uploaded file (`files`). Do not describe the photo yourself first.
   - Photos with one part each → `parts_from_photo` (`add: true`, `qty` = how many of that part the user has).
   - A text list, a set number → `inventory_import` / `inventory_add_set`.
   - Show the recognised parts as a compact table and ask only about lines marked unsure. Fix with `inventory_update`.
2. **Ideas.** `ideas_suggest`. Offer 2–4 buildable ideas in one short list (name, size, part count). Mention at most one "almost" idea with what is missing.
3. **Build.** After the user picks: `idea_build` → `show_build` (mode `picture`). The card shows the model and its parts: answer in one sentence, do not retell parts or steps.
4. **On request only:** `show_build` mode `steps` (step pictures) or mode `video`. Always use `show_build` for these (it plays the video inside the card); do not use `model_render`/`model_preview`, which only return links.
5. **Own design** (the user wants something not in the ideas): read `lego_guide`, design a model JSON from the inventory, `model_check` until ok, `model_save`, `show_build`.

## Script flow (no app)

Work in a folder, e.g. `/mnt/data/lego`. `S` = path to this skill's `scripts/`.

1. **Parts.** From photos, read the parts yourself following `references/photos.md` (count studs, tell plates from bricks, name colours by key). Write `parts.csv` (`part,color,qty`), show it to the user as a table and let them correct it. Be honest that counting from a photo is approximate.
   ```
   node $S/tools/inventory.cjs import parts.csv --inv inventory.json
   node $S/tools/inventory.cjs show --inv inventory.json
   ```
2. **Ideas.** `node $S/tools/ideas.cjs --inv inventory.json` → offer 2–4 of the "Можно собрать" lines, plus at most one "Почти".
3. **Build and picture.**
   ```
   node $S/tools/ideas.cjs build <idea> [size] --inv inventory.json --out models/<idea>.json
   node $S/tools/draw.cjs models/<idea>.json --out out
   ```
   Display `out/<idea>-model.png` inline, with a compact parts list (`node $S/tools/inventory.cjs bom models/<idea>.json`). One or two sentences of text. `draw.cjs` makes the PNG itself (pure Node), no converter is needed.
4. **Steps on request.** `node $S/tools/draw.cjs models/<idea>.json --sheet --out out` → display the single picture `out/<idea>-steps.png` (all steps in a numbered grid; new parts of each step are outlined in yellow). Under it, one short line per step ("2 — 4 кирпича 1×2, 2 плитки"). Use `--steps` (separate `<idea>-step1..N.png`) only if the user wants them one by one.
5. **Video.** Not available without the app: say that the build video comes with the "LEGO из моих деталей" app, and offer the step pictures instead.
6. **Own design.** Follow `references/modeling.md`; check with `node $S/tools/check-model.cjs models/<name>.json --inv inventory.json` until it says `no overlaps, everything is held, all parts are in the inventory`.

## Rules

- Use only parts the user has. If something is missing, say exactly what (part, colour, count) instead of silently substituting.
- Only real LEGO parts and colours; no invented printed parts.
- Keep answers short: pictures carry the model. No long step lists in text.
- A model that passes the check was not built by hand: do not promise it is sturdy.
- LEGO is a trademark of the LEGO Group; do not present results as official instructions.

## Files

- `scripts/tools/inventory.cjs` — import/show/fit/bom of the parts list.
- `scripts/tools/ideas.cjs` — ideas that fit the inventory; `build` writes a checked model JSON.
- `scripts/tools/draw.cjs` — model picture, step sheet, single step pictures (PNG, pure Node).
- `scripts/tools/check-model.cjs` — overlaps, floating parts, parts missing from the inventory.
- `references/photos.md` — how to read parts from photos. `references/modeling.md` — model format and building rules. `references/parts.md` — part numbers and colour keys.
