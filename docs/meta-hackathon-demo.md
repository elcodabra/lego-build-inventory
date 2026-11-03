# LEGO from My Bricks: Meta hackathon demo and submission draft

DRAFT. Not submitted. The Cerebral Valley form is sent only after the owner confirms.

## One-line pitch

Show a photo of a LEGO model you already built: Meta Muse Spark says what it sees and which of your
known models it could be; you confirm, and you get the exact parts list, an exploded view and
step-by-step instructions to take it apart (and to build it again), from the model's real data.

## Problem

Kids and parents rebuild, trade and reuse LEGO all the time, but instructions only go one way
(build). Taking a model apart cleanly, or knowing exactly which parts it holds before reusing them,
means guessing from a photo. A photo alone cannot show hidden or internal bricks, so a reliable
answer has to come from the model's own data, not from the picture.

## What we built during the hackathon (new) vs before (prior work)

Prior work (before 2026-11-03, `main`): MCP server for ChatGPT/Claude with OAuth, inventory from
photos of a pile, idea generation, JSON models with geometry checks, PNG/MP4 rendering, the chat card,
Amplitude analytics, Vercel/Redis/Blob hosting, YouTube pipeline.

New in this hackathon (branch `feat/meta-hackathon-reverse-build`):
- `lib/disassembly.cjs`: reverse steps, remaining model per step, exploded view (render-only), BOM
  parity and invariants.
- `model_disassemble` MCP tool and the card's Build / Disassemble switch, Exploded view, reverse
  step paging (buttons and arrow keys).
- `lib/meta.cjs` + `lib/analyze.cjs`: Meta Model API client (Responses API, structured output),
  photo analysis with a server-side allowlist of model names, Zod validation, model fallback list.
- `model_analyze_photo` MCP tool and the analysis card with explicit user confirmation.
- `lib/budget.cjs`: spend cap (total and daily) shared across instances in Redis, settled to real
  API usage.
- Tests: `test/disassembly.mjs`, `test/disassembly-card.mjs`, `test/meta-mock.mjs`,
  `test/hosted-meta.mjs`, `test/meta-live.mjs`, `test/meta-compare.mjs`, `test/remote-demo.mjs`.

## Meta models used

- `muse-spark-1.3` (Standard mode) via `POST https://api.meta.ai/v1/responses`, image input as a
  JPEG data URL, `text.format` JSON schema, `reasoning.effort: low`.
- Fallback list `muse-spark-1.3,muse-spark-1.2` (switch with `META_MODELS`).
- Not used: SAM 3.1 (P1, not started), Contributor mode (would let Meta train on user photos).

## Exact vs estimated (what the card says)

| Label in the card | Source | Guarantee |
|---|---|---|
| `AI estimate` | Muse Spark on the photo | visible colours, rough part categories and counts, possible matches. An estimate |
| `Based on exact model JSON` | the saved model the user confirmed | exact parts list, geometry, steps |
| `Физическая извлекаемость деталей не проверена` (physical removal not checked) | reverse of the build steps | consistent with the data, not tested by hand |

## Demo script (2-3 min)

1. ChatGPT (or Claude) with the "Lego from My Bricks" app connected (https://lego-mcp.vercel.app/mcp).
2. Upload a photo of the built cat: "что это за модель и как её разобрать?"
3. The card "Что на фото" appears: AI estimate tag, `muse-spark-1.3`, visible colours, rough parts,
   what is hidden; "Возможное совпадение: подтверди" with the button "Это Котик · 106 дет."
4. Press it: the Disassemble card, with "Based on exact model JSON" and the warning tag, 106 parts.
5. Press "Exploded": the model separated by build steps (illustration only).
6. "Шаги разборки": page 1 → 3 with the arrows; each step outlines the parts to take off.
7. Switch to "Build": the same parts, build steps 1..17.
8. Negative case: upload a photo of a loose pile. "Совпадений среди известных моделей нет"
   with suggested angles; nothing is invented.

Backup without the UI (same production server, prints the real response id):
```bash
cd plugins/lego-inventory-build/skills/lego-inventory-build
node --use-system-ca test/remote-demo.mjs "https://lego-mcp.vercel.app/mcp?key=<key>" [photo.jpg] [cat]
```

## Verified so far (2026-11-03)

- Production (deploy `lego-lnaekwkvs`, alias lego-mcp.vercel.app), via an MCP client:
  analysis `muse-spark-1.3` 16.6 s, response `resp_6aea0ffa45ce89cc728a4512`, top match `cat` (high)
  → disassembly 106 parts, exploded and 17 reverse-step pictures reachable → Build again.
  Logs: no `amplitude_error`, no `meta_error`, all 200.
- The photo in that run was a RENDER of the cat, not a photo of a physical model.
- Model comparison (`test/results/meta-compare-2026-11-03-15-51.json`): 2 renders, spark 1.3/1.2/1.1
  all matched 2/2; avg 9.6 s / 6.8 s / 4.5 s; $0.61 / $0.65 / $0.50 per 100 analyses.
  Too few, synthetic photos: not a claim about accuracy.
- Second demo model `cottage` (38 parts, 6 steps, house shape): renders of cat, microduck and cottage at
  a different camera angle, spark 1.3/1.2/1.1 each matched 3/3 (`test/results/meta-compare-2026-11-03-19-02.json`).
  Prod: cottage render → `cottage` (high), `resp_6aea2fef51291391de5243be` → 38-part disassembly, 6 reverse steps.
- Live negative case: a photo of a loose pile → no match (`resp_6aea039a6a2f807beb3a403b`).

Still to do before submitting: real photos of the physical models, a comparison on them, the
recording in the ChatGPT/Claude UI.

## Cost and limits

About $0.005-0.007 per analysis (real usage from the API). Caps: `META_BUDGET_USD=100`,
`META_DAILY_BUDGET_USD=20`, plus the per-user daily photo quota. Spent during development: about $0.08.

## Limitations (say these out loud)

- One photo cannot show hidden or internal bricks: the AI never produces geometry, only an estimate
  and a choice among KNOWN models. Unknown builds get no instructions.
- Disassembly order = build steps reversed. Consistent with the model data, not physically tested.
- Exploded view is an illustration (layers lifted apart), not an extraction path.
- Matching is limited to the built-in examples (cat, microduck, cottage) and the user's saved models (12 candidates per call).
- Not built: Duplo, Arduino / Raspberry Pi, SAM 3.1 segmentation, reconstruction of unknown models.

## Links (fill in)

- Repo: https://github.com/elcodabra/lego-build-inventory (branch `feat/meta-hackathon-reverse-build`, not pushed yet)
- Live MCP server: https://lego-mcp.vercel.app/mcp
- Video: draft `promo/hackathon/demo-en.mp4` (1:01, English, recorded on production by `test/record-demo.mjs`; real photo response `resp_6aea46d3694c9a9d090e4061`, render `resp_6aea46df28ea09ed7cc443bf`). Not uploaded yet.
- Track: Indie Developer (check against the form). Eligibility and rules: check in the signed-in form.

## Real photos (2026-11-03 20:09 CET)

Two iPhone photos of physical LEGO builds that are NOT among the known models (a plum-blossom bonsai
and a Minecraft Ender Dragon): spark 1.3 / 1.2 / 1.1 all returned no match on both (6/6 correct
"none", `test/results/meta-compare-2026-11-03-19-09.json`). The descriptions were specific and
right (e.g. "LEGO Minecraft Ender Dragon figure with outstretched membraned wings"), with honest
uncertainties and suggested extra angles. Prod: the raw HEIC → status ok, 0 candidates
(`resp_6aea31de3240c465285241cb`). Found and fixed: a HEIC labelled image/jpeg failed to decode.

Still missing: a real photo of a model that IS known (cat / microduck / cottage) for the positive case.
