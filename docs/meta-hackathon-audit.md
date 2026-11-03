# Meta hackathon: Stage A audit (feat/meta-hackathon-reverse-build)

Skill root: `plugins/lego-inventory-build/skills/lego-inventory-build/`.

## Real interfaces (checked in code)

- `lib/core.cjs`: `loadModel(nameOrObject)` (validates, returns `{title, theta, phi, steps, name}`),
  `listModels()`, `bom(model)` -> `[{id, color, qty, name}]`, `checkGeometry`, `fullCheck(model, inv)`.
- Built-in models: `src/models/cat.js` (106 parts, 17 steps), `src/models/microduck.js`.
- `lib/nodefilm.cjs`: `hero(model, {size, upto, trim})` square PNG (Skia, works on Vercel),
  `snap`, `render` (mp4). `lib/film.cjs` picks browser or node renderer.
- `mcp/tools.mjs`: `buildServer({publish, videoCache, onVideo, mediaOrigin})`; card builder
  `card(m, mode, format, name, quality)` returns `structuredContent` for `mcp/player.html`.
  Tools: `model_get`, `model_bom`, `model_preview`, `show_build` (picture/steps/video), `model_render`,
  `parts_from_photo`, `parts_from_pile_photo` and inventory tools.
- `api/mcp.mjs`: hosted MCP, OAuth user scope, analytics via `api/_analytics.mjs` (`events()` + `send()`).

## Design (smallest change)

- New `lib/disassembly.cjs`: pure functions over the stored JSON (`reverseSteps`, `modelAtReverseStep`,
  `explodedScene`, `disassemblyBOM`, `assertReverseInvariant`). Exploded offsets live only in a render copy.
- `nodefilm.hero` gets an optional `explode` / `remaining` option; physical `at` is never passed to `checkGeometry`.
- New MCP tools (two only): `model_disassemble({name, mode})` and `model_analyze_photo({photo, hint})`.
- `player.html`: Build / Disassemble toggle + Exploded when `structuredContent.disassembly` is present.
  Existing picture/steps/video paths untouched.
- `lib/meta.cjs`: Responses API client (`MODEL_API_KEY`, `muse-spark-1.3`, timeout, one retry,
  `META_UNAVAILABLE` / `INVALID_IMAGE` / `INVALID_MODEL_OUTPUT` / `QUOTA_EXCEEDED`).

Files touched: `lib/disassembly.cjs` (new), `lib/meta.cjs` (new), `lib/nodefilm.cjs`, `mcp/tools.mjs`,
`mcp/player.html`, `api/mcp.mjs` (events), `test/disassembly.mjs`, `test/meta-mock.mjs`, `test/meta-live.mjs`, README.

## Baseline tests (before changes, 2026-11-03)

- `OFFLINE=1 npm test`: security + smoke all pass.
- `npm test` online: fails at `parts_from_photo (Brickognize)` assertion (external recogniser returns no
  part for the fixtures). Pre-existing, unrelated to this work.
- `node test/meta-live.mjs`: skipped, `MODEL_API_KEY` is not set locally or in Vercel env yet.
