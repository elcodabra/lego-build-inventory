# Submission pack: LEGO from My Bricks

Meta Global AI Developer Hackathon · DRAFT, not submitted. Submit only after the owner's explicit OK.

Deadline: **Nov 4, 9:00 PM ET = Nov 5, 03:00 CET**. Internal freeze: Nov 4, 18:00 CET.
Form: https://cerebralvalley.ai/e/meta-ai-developer-hackathon/hackathon/submit (needs sign-in; the
field list below is a best guess from typical Cerebral Valley forms: copy each block into the matching
field, and check the real form for anything missing).

---

## Track and theme

- **Track:** Indie developer (one builder). Judged on creativity, technical ambition, and whether it works.
- **Theme:** Build for Your World (a problem I know firsthand: a family's box of mixed bricks and
  half-forgotten builds). Also touches "Push the Frontier" (physical objects + vision).

## Project name

LEGO from My Bricks

## Tagline (one line, ~100 chars)

Photograph a LEGO build: Meta AI recognises it, then shows exactly how to take it apart and what else to build.

## Short description (2-3 sentences)

Snap a photo of a LEGO model you already built. Meta SAM 3.1 outlines it and Muse Spark 1.3 describes
what it sees and suggests which of your saved models it is; you confirm, and the app shows the exact
parts list, an exploded view, step-by-step disassembly and a disassembly film, straight from the model's
real data. Then it turns the same bricks into new models (cat → spaceship) and lists any missing parts
as a BrickLink wanted list. It runs inside ChatGPT and Claude as an MCP app.

## Problem

Kids and parents rebuild, trade and reuse LEGO constantly, but instructions only go one way. Taking a
model apart cleanly, knowing exactly which bricks it holds, or deciding what else those bricks can
become means guessing. A photo alone cannot see hidden or internal bricks, so the honest answer has
to come from the model's own data, with AI doing what it is good at: recognising and describing.

## What it does (demo flow)

1. Photo (up to 3 angles) of a built model in ChatGPT or Claude.
2. **Meta SAM 3.1** outlines the model and boxes the visible bricks on the photo.
3. **Meta Muse Spark 1.3** (structured output) describes visible colours and parts and picks up to 3
   possible matches **only** from the user's saved models (server-side allowlist). Marked "AI estimate".
4. The user confirms the match. No confirmation, no instructions.
5. Exact data from the saved model JSON: parts list, exploded view, reverse steps, disassembly film,
   one switch back to Build. Marked "Based on exact model JSON" and "Physical removal not verified".
6. Rebuild: new models from the same bricks only; ideas that are close get a BrickLink wanted list.
7. Unknown build (e.g. a real photo of a dragon): honest "no match", no made-up steps, and how to add it.

## How Meta models are used

| Model | Where | Why it matters |
|---|---|---|
| `muse-spark-1.3` (Responses API, `text.format` JSON schema, `reasoning.effort: low`) | `lib/meta.cjs`, `lib/analyze.cjs` | Visual description + match among the user's own models; up to 3 angles in one request; model names constrained by an enum and re-validated with Zod; fallback chain `muse-spark-1.3 → 1.2` |
| `sam-3.1` (Responses API, `one_bit` masks, confidence) | `lib/segment.cjs` + `@meta-sam/parser` | "LEGO model" outlines the build, "LEGO brick" boxes visible bricks; overlay shown in the card |

Muse Spark and SAM run in parallel on the same downscaled photo. Every call is capped by a spend budget
shared across serverless instances (Redis), reserved at worst case and settled to real `usage`.

## Technical highlights

- Exact vs estimated, by design: the AI never produces geometry; it only proposes a known model.
- Deterministic disassembly with tested invariants (reverse is an involution, monotone part count,
  full → empty, BOM parity, exploded offsets never touch physical coordinates).
- Production MCP server (OAuth, multi-user, quotas) serving ChatGPT and Claude; one card UI
  (MCP Apps) in English or Russian, mobile-safe, keyboard paging.
- Cost and safety: spend caps, per-user photo/video quotas, SSRF-safe image loading, HEIC handled by
  content sniffing, no photos/prompts/AI text in analytics or logs.
- Model comparison harness (`test/meta-compare.mjs`): real accuracy, latency, tokens and cost per model.

## Built during the hackathon vs before

Everything before git tag `pre-hackathon` (commit ff47a9d, Oct 19, 2026) existed before the event:
the MCP server, OAuth, inventory from photos of a pile, idea generators, the renderer, build films,
analytics, hosting. New in the hackathon (branch `feat/meta-hackathon-reverse-build`,
21 commits, 32 files, +2,659 lines in the app, 20 new files):

- Meta Model API client with model fallback, structured output, validation, spend budget.
- Photo → Muse Spark analysis → confirm → exact disassembly (`model_analyze_photo`, `model_disassemble`).
- SAM 3.1 overlay; multi-angle analysis; disassembly film; exploded view; reverse steps.
- Rebuild loop from a model's own parts; BrickLink wanted list; English card; second demo model.
- Tests: mock Meta/SAM API, hosted handler, browser card, live smoke, production demo flow, recorder.

## Honest limits

- One photo cannot show hidden bricks: unknown builds get a description, not instructions.
- Disassembly order = build steps reversed; consistent with the data, not physically tested.
- SAM boxes are visible regions, not part identification.
- Matching is among the user's saved models plus built-in examples (12 candidates per call).
- The positive match in the video uses a render of the built-in cat; the "no match" case uses real
  iPhone photos. No accuracy numbers are claimed beyond the comparison file in the repo.

## Results (real, from production and live calls)

- Production flow (lego-mcp.vercel.app): render → `cat` (high) → 106-part disassembly → 17 reverse
  steps → Build; real dragon photo → no match with SAM outline.
- Renders of 3 models at a new angle: spark 1.3 / 1.2 / 1.1 each matched 3/3. Real photos of 2 unknown
  builds: 6/6 correct "no match". (`test/results/`)
- Cost: about $0.006 per Muse analysis, $0.005 per SAM overlay; total spent building: about $0.55.

## Links

- Live MCP server: https://lego-mcp.vercel.app/mcp (connect in ChatGPT / Claude)
- Code: https://github.com/elcodabra/lego-build-inventory, branch `feat/meta-hackathon-reverse-build`
  (pushed)
- Video: `promo/hackathon/demo-en.mp4` (0:42) → upload unlisted (YouTube or Loom), paste the URL here
- Diff vs pre-hackathon: `https://github.com/elcodabra/lego-build-inventory/compare/pre-hackathon...feat/meta-hackathon-reverse-build`
  (live)

## Checklist before pressing Submit (owner)

- [ ] Sign in to Cerebral Valley; open the submit form; compare its fields with this file.
- [ ] Read the Official Rules (pre-existing code, open source, IP, publicity) and the waiver.
- [ ] Eligibility: country of residence not excluded (the public page excludes Belarus, China,
      Russia, Ukraine, Syria and sanctioned regions; check your own case), not a Meta/CV employee or
      family, not government-affiliated.
- [ ] Trademark: "LEGO" is a trademark of the LEGO Group. The product name already uses it and the
      video description should say "Not affiliated with, sponsored or endorsed by the LEGO Group".
- [x] Branch pushed; repo public; tag `pre-hackathon` on GitHub.
- [ ] Upload the video (unlisted), paste link.
- [ ] Optional: one live run in ChatGPT/Claude UI and a screenshot.
- [ ] Submit before Nov 5, 03:00 CET.
