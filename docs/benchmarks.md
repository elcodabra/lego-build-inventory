# Benchmarks (Nov 4, 2026)

All numbers are measured, not estimated. Raw results (no images, no AI text) are in
`plugins/lego-inventory-build/skills/lego-inventory-build/test/results/bench-*.json`.

## 1. Photo → "which saved model is it" (the Meta step)

Same prompt, same strict JSON schema, same downscaled photos for every model; scored against the known
answer. Harder setup: the user's shelf has **12 saved models** (3 built-in + 9 generated: house, tower,
robot, rocket, tree, mushroom, spaceship, fire truck, rover), so the model must pick among similar
brick builds.

Photos: 13 renders of saved models from new angles (cat, microduck, cottage ×3 angles; house, tower,
robot, spaceship ×1) and 3 real iPhone photos of builds the app does not know (correct answer: no match).
Renders are labelled as renders; the "no match" photos are real.

| Model (reasoning effort) | Accuracy | Known models | Unknown → no match | Valid JSON | p50 latency | p90 latency | Cost / photo |
|---|---|---|---|---|---|---|---|
| **muse-spark-1.3 (low)**, production | **15/16** | 12/13 | 3/3 | 16/16 | 11.7 s | 16.7 s | $0.0054 |
| muse-spark-1.2 (low) | 14/16 | 11/13 | 3/3 | 16/16 | 4.8 s | 5.6 s | $0.0053 |
| muse-spark-1.2 (minimal) | 14/16 | 11/13 | 3/3 | 16/16 | 2.8 s | 3.9 s | $0.0031 |
| muse-spark-1.1 (low) | 12/16 | 9/13 | 3/3 | 16/16 | 3.7 s | 4.8 s | $0.0041 |

Easier setup (3 saved models, 12 photos): every Meta model and effort scored **12/12**
(1.3 low/minimal, 1.2 low/minimal, 1.1 low).

What it shows:
- **Muse Spark 1.3 is the most accurate** when the shelf has look-alike builds (the only miss: a
  spaceship render it answered "no match", the safe failure). 1.1 confuses the cottage with the house.
- **No model ever invented a model name or matched an unknown build** (3/3 everywhere): the enum in the
  schema plus Zod validation hold. 100% schema-valid JSON on all 112 calls.
- **Trade-off for production:** 1.3 low is the default for accuracy; 1.2 minimal is ~4× faster at
  ~60% of the cost with one more miss. Switchable without code changes: `META_MODELS`, `META_EFFORT`.

Other providers: the harness (`test/bench-models.mjs`) also calls OpenAI (gpt-4.1-mini, gpt-4.1) and
Anthropic (claude-haiku-4-5) with the same schema, but the accounts available had no API credit on the
day, so **no cross-provider numbers are claimed**. Rerun with `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` set.

## 2. Pile of loose parts (SAM 3.1 experiment, not shipped)

49 known parts on one table photo (`test/fixtures/pile-table-edge.jpg`), part number + colour must both
match:

| Method | Correct |
|---|---|
| Current classic segmentation + Brickognize | 17/49 |
| SAM 3.1 boxes + Brickognize | 14–17/49 |
| Both merged | 15–16/49 |
| SAM 3.1 + Muse Spark referee over Brickognize options | 16/49 |

SAM 3.1 finds the parts well (51 boxes for 49 parts after de-duplication, ~3 s, $0.0025); the bottleneck
is part-number recognition (20/49 right even ignoring colour). Not shipped because it did not improve
the result. Code on branch `dev` (`lib/referee.cjs`, `test/pile-sam-accuracy.cjs`).

## 3. Production latency (what the user waits for)

`lego-mcp.vercel.app`, 5 runs each, measured from a client over the internet (`test/bench-latency.mjs`):

| Tool | p50 | p90 |
|---|---|---|
| model_analyze_photo (Muse Spark 1.3 + SAM 3.1 in parallel) | 11.6 s | 12.4 s |
| model_disassemble (card with exact data) | 0.44 s | 0.62 s |
| model_disassemble steps | 1.9 s | 2.0 s |
| ideas_suggest from_model (rebuild ideas) | 3.2 s | 3.2 s |

Everything after the photo step is deterministic and fast; the Meta call is the only multi-second step,
and SAM runs in parallel with Muse so it adds no wait.

Total Meta spend for all benchmarks today: about $0.52.
