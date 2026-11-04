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
| claude-opus-5-5 | **16/16** | 13/13 | 3/3 | 16/16 | 5.0 s | 6.1 s | $0.0177 |
| **muse-spark-1.3 (low)**, production | **15/16** | 12/13 | 3/3 | 16/16 | 11.7 s | 16.7 s | $0.0054 |
| muse-spark-1.2 (low) | 14/16 | 11/13 | 3/3 | 16/16 | 4.8 s | 5.6 s | $0.0053 |
| muse-spark-1.2 (minimal) | 14/16 | 11/13 | 3/3 | 16/16 | 2.8 s | 3.9 s | $0.0031 |
| claude-sonnet-5-5 | 14/16 | 11/13 | 3/3 | 16/16 | 3.8 s | 4.4 s | $0.0090 |
| gpt-4.1 | 13/16 | 10/13 | 3/3 | 16/16 | 3.0 s | 3.5 s | $0.0047 |
| muse-spark-1.1 (low) | 12/16 | 9/13 | 3/3 | 16/16 | 3.7 s | 4.8 s | $0.0041 |
| gpt-5.6-sol (low) | 11/16 | 8/13 | 3/3 | 16/16 | 6.4 s | 7.0 s | $0.0138 |
| claude-haiku-5-5 | 11/16 | 8/13 | 3/3 | 16/16 | 4.7 s | 6.2 s | $0.0006 |
| gpt-4.1-mini | 11/16 | 8/13 | 3/3 | 16/16 | 3.3 s | 4.7 s | $0.0011 |
| gpt-5.6-luna (low) | 9/16 | 6/13 | 3/3 | 16/16 | 4.8 s | 6.6 s | $0.0007 |

Other providers ran through their own APIs with the same prompt, the same JSON schema (OpenAI
`text.format` strict, Anthropic `output_config.format`) and the same downscaled photos. Costs use each
provider's list prices on Nov 4, 2026.

Easier setup (3 saved models, 12 photos): every Meta model and effort scored **12/12**
(1.3 low/minimal, 1.2 low/minimal, 1.1 low).

What it shows:
- **Muse Spark 1.3 is second only to Claude Opus 5.5** (15/16 vs 16/16) at **~1/3 of Opus's cost**, and
  ahead of Claude Sonnet 5.5, GPT-4.1, GPT-5.6 Sol and every small model. Its only miss is the safe
  kind: a spaceship render answered "no match" (no wrong instructions shown).
- The common hard case is the **cottage vs the generated house** (both small houses): Muse 1.3, Sonnet
  and Opus get it; Haiku, GPT-5.6 and Muse 1.1 confuse them. Microduck vs robot trips GPT models.
- **No model of any provider invented a model name or matched an unknown build** (3/3 everywhere): the
  enum in the schema plus Zod validation hold. 100% schema-valid JSON on all 256 calls.
- **Trade-off for production:** 1.3 low is the default for accuracy; 1.2 minimal is ~4× faster at
  ~60% of the cost with one more miss. Switchable without code changes: `META_MODELS`, `META_EFFORT`.
- Weak spot of Muse 1.3: latency (11.7 s p50, the slowest here). Muse 1.2 minimal (2.8 s) is the
  fastest model in the table with 14/16.

Other providers: run them with `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` and `BENCH_OPENAI`,
`BENCH_ANTHROPIC` (comma-separated model ids), e.g.
`BENCH_DISTRACTORS=1 BENCH_ANTHROPIC=claude-opus-5-5 node --use-system-ca test/bench-models.mjs --providers anthropic`.

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

Total spend for all benchmarks today: about $0.52 Meta, $0.32 OpenAI, $0.45 Anthropic.
