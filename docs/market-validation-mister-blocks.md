# Market validation: LEGO from My Bricks vs Mister Blocks and Brickit

**Research date:** 2026-11-19  
**Purpose:** Assess demand, acquisition, retention, monetization, competitive positioning and unit economics.  
**Status:** Competitive research and experiments to run. This is **not** evidence of product-market fit or verified competitor revenue.  
**Scope:** Post-hackathon growth and validation (do not change the submitted Meta competition entry).

## Executive readout

- **Demand signal is real but early for direct AI generation.** Mister Blocks attracted initial visitors and public engagement in its first launch week. Stronger category evidence comes from Brickit's >5M Android installations, but app installs are neither active users nor revenue.
- **There is an underserved job:** “I have a random box of bricks; what can I actually build?” A second job, “How do I understand, take apart, and reuse a model?”, is our distinctive angle but needs its *own* validation.
- **Distribution may dominate features.** Mister Blocks' creator reported a Reddit-driven spike, subsequent search discovery, and a catalog of >100 publicly discoverable models. Search-friendly catalog pages may bring recurring organic traffic at lower acquisition cost than repeated launches.
- **Cost is a strategic axis.** Mister Blocks' maker reports *a few dollars* of model-generation API cost, potentially using ~500k AI tokens. Our Meta photo analysis for a known-model match was about $0.01 per photo **but this is not an apples-to-apples comparison**: it does not generate arbitrary equivalent-quality models.
- **Monetization is unproven.** Mister Blocks was free and had a no-charge “pre-order” interest test; no sales, conversion to paid or retained-user numbers were disclosed.

## 1. Evidence ledger (keep dates, sources and confidence)

| Metric / fact | Observed or reported value | Window / provenance | Confidence / caveat |
|---|---:|---|---|
| Mister Blocks launch | Nov 11, 2026 | Product Hunt | High (public launch) |
| Product Hunt upvotes | 83 points | PH page checked Nov 19 | High as snapshot; can change |
| Product Hunt rank | #20 of the launch day | PH page | High as snapshot; not a market-share metric |
| Product Hunt followers | 88 | PH page checked Nov 19 | High as snapshot; not customers |
| PH comments | 8–10 across independent snapshots | hunted.space / launchindex.ai | Medium; different capture times and counting |
| Early Mister Blocks site users | 918 visitors | Reported by founder for first 2–3 days | Self-reported; unique-user methodology unknown |
| Early page views | 3,780 | Same interview | Self-reported; ~4.12 views per visitor, not sessions |
| Peak concurrent visitors | 48 | Same interview | Self-reported |
| Reddit exposure | 21,400 post views in first 12h | Reported by founder | Self-reported; not website clicks |
| Reddit social proof | +116 post votes on one r/ClaudeCode thread | Reddit snapshot | Platform-dependent, separate from PH |
| Expected daily volume | 500–600 visitors in a day | Founder expectation Nov 17 | **Forecast**, not verified actual |
| Mister Blocks catalog | >100 models | Founder interview | Self-reported; catalog may change |
| Mister Blocks cost per generated model | A few dollars, up to ~500k AI tokens | Founder interview and maker comment | Rough estimate; no full cost accounting |
| Mister Blocks revenue | No monetization yet | Founder interview | No disclosed paid customers/revenue |
| Brickit Google Play installation bracket | 5M+ | Google Play (Nov 2026) | Official floor, Android only |
| Brickit modeled install volume | ~6M Android lifetime; ~73k / 30d | AppBrain third-party tracker, Oct-Nov 2026 | Estimated, not audited |
| Brickit review volume | ~18.7k, score ~4.4 | Google Play | Public snapshot; may change |
| Our photo AI analysis | ~$0.006 Muse + ~$0.005 SAM / photo | Existing Meta hackathon submission estimates | Internal scope: recognition/matching and segmentation **not equivalent to full arbitrary build generation** |

### Sources

- Product Hunt: https://www.producthunt.com/products/mister-blocks
- Launch snapshots: https://www.hunted.space/dashboard/mister-blocks and https://launchindex.ai/product/119724
- Creator interview (Nov 17): https://dev.ua/en/news/lego-1794894571
- Reddit launch discussion (Nov 10): https://www.reddit.com/r/ClaudeCode/comments/1xsxn63/i_built_a_site_that_turns_a_photo_of_your_loose/
- Brickit official Google Play publisher: https://play.google.com/store/apps/dev?id=5858968469659056480
- Brickit independent Android tracker: https://www.appbrain.com/app/brickit-your-brick-collection/com.brickit.brickit
- Our recorded Meta submission and production tests: docs/meta-hackathon-submission.md, docs/meta-hackathon-demo.md

**Interpretation rule:** Never convert Product Hunt votes, Reddit views, app installations or page views into paying users. No public MAU, D1/D7 retention, conversion-to-paid, ARPU, CAC, LTV or revenues were verified for Mister Blocks.

## 2. Product comparison and defensible differentiation

| User job / capability | Mister Blocks (reported) | LEGO from My Bricks (our existing implementation / claim to test) | What to validate |
|---|---|---|---|
| Photograph loose parts | Yes, Claude extracts parts | Yes, pile/part-photo inventory | Count & color accuracy with real messy piles |
| Generate from available parts | Yes, AI-created custom builds | Existing inventory-constrained ideas + agent-generated JSON | Diversity and *actually buildable* outcomes |
| Prompt-only open generation | Yes | Possible via agent model design, not equivalent ready-to-use UX | Demand vs cost and reliability |
| Interactive rotatable 3D guide | Yes | Rendered steps/video, exploded/disassembly UI | Whether 3D rotate/zoom raises build completion |
| Print / PDF / offline | Yes | Existing PNG/MP4; PDF/offline parity not assumed | User demand; prioritize after core metrics |
| Disassemble a known built model | Layer decomposition supported | Confirmed known-model match → exact BOM/reversed steps/video | Distinctive value beyond generic exploded view |
| Analyze photo of *unknown* build | Description, AI proposals | Honest uncertainty / no fabricated exact hidden geometry | Users' tolerance for partial analysis |
| Catalog & SEO | >100 publicly viewable models | Current catalog/discovery to audit | Organic impressions → CTR → activated sessions |
| Distribution | Standalone website | MCP in ChatGPT/Claude, existing hosting | Whether MCP channel is enough for families |
| Commerce | Non-charging interest test on sets | BrickLink wanted-list export | Qualified purchase leads / willingness to pay |

**Risk:** Competitor has interactive 3D, prompt-only generation, PDF/print/offline and public catalog. Differentiation cannot be “we show an exploded view” alone. Emphasize exact/estimated provenance, verified geometry from known models, inventory continuity, reverse/rebuild loop, cost discipline and trust. Test the claim with users rather than assuming superiority.

## 3. Research questions to resolve — priority order

### P0: Is the core problem frequent and valuable?
- Interview **15–20 parents / adult LEGO hobbyists**, including at least 5 not recruited through AI/developer communities. Ask about last real build, existing parts, children’s age with guardian consent, why instructions are lost, what they tried, where they quit, and whether they come back.
- Run a **5-second preference test**: (A) photo pile → build suggestions, (B) photo built model → understand/disassemble/rebuild, (C) browse model catalog. Ask participants to select one *before* revealing features.
- Have **10 participants** use their own physical bricks; measure whether they can complete one build without manual developer intervention. Separate official-like render samples from physical build photos.
- Report raw counts, recruitment channel, and selection bias. Interview enthusiasm is not willingness to pay.

### P0: Funnel measurement (use Amplitude per AGENTS.md)
Define anonymous-to-signed-in identity consistently and privacy-safely. Do not send images, part lists, model JSON, raw text, secrets or identifiable children to analytics.

Track at minimum: `landing_viewed`, `catalog_opened`, `catalog_model_opened`, `photo_upload_started`, `photo_analysis_completed`, `photo_analysis_failed`, `inventory_confirmed`, `ideas_generated`, `idea_selected`, `model_generation_started`, `model_generation_completed`, `model_generation_failed`, `build_steps_opened`, `build_completed_self_reported`, `disassembly_started`, `disassembly_completed`, `rebuild_started`, `project_shared`, `purchase_interest_clicked`, `purchase_interest_submitted`, `price_test_viewed`.

Allowed properties: platform, acquisition source/UTM, session age bucket, template/custom, model family, step count bucket, duration_ms, status/error code, cost band, cache hit, photo count, input family (pile/model), known/unknown match; no raw image or model contents.

Compute weekly by source/cohort:
1. **Activation:** visitors who obtain at least one usable *rendered* suggestion/instruction divided by eligible visitors; report both total and photo-uploaders.
2. **Photo→result conversion:** completed analyses / uploads started; separate intentional cancels from errors.
3. **Verified usefulness:** self-reported physical build success / respondents and / all started builds (both with missing-response rate).
4. **Retention:** D1, D7, D30 returning activated users (cohort + denominator explicitly defined; cross-device caveat).
5. **Repeat value:** 2nd build/disassemble within 7/30d and total successfully completed guides/user.
6. **Referral:** shares, shared link opens, resulting activations per sharer.
7. **Unit economics:** average, p50/p95 Meta/LLM spend per successful model; cost for failed attempts, retries, media rendering/storage and caching.
8. **SEO:** Google Search Console non-branded impressions, clicks, CTR, landing-page activations; differentiate impressions from actual visitors.

### P0: Reliability and model quality benchmark
- Collect a consented benchmark of 30–50 real photos across lighting, clutter, viewpoint, mixed part sizes, backgrounds and device types (no identifiable faces).
- Human-annotate visible part families and counts with uncertainty, and for known models the authoritative model JSON; measure precision/recall where meaningful and top-1/top-3 *known-model* match accuracy.
- Compare Brickognize, Muse, and their combination; keep segmentation separate from part ID prediction.
- Track build validity in three levels: (1) formal geometry/inventory check, (2) human feasible assembly / removal, (3) physically completed build. Do not equate these.
- Explicitly measure "honest no-match" behavior for unknown builds.

### P1: Acquisition and content strategy
- Test public SEO indexable model pages (at least 20 high-quality, permission-safe models) with stable URL, preview, parts, complexity, FAQ and real instructions. Follow normal SEO practices; no thin AI-generated doorway pages.
- Two small distribution tests: (A) relevant maker/parent LEGO communities with community rules and genuine demo, (B) Product Hunt. Record post impressions, clicks/UTMs, signups, activations and 7-day returns; do not optimize for upvotes alone.
- Compare “browse first” vs “photo first” landing variants, with at least directional numbers before making product roadmap decisions.
- Ask for opt-in user-submitted builds with visible moderation, copyright/trademark safeguards and no identifiable child photos.

### P1: Monetization tests, with consent
- Test 3 paid value propositions independently: (1) premium guide export/print, (2) more custom generations, (3) matching missing bricks / affiliate purchase. Do **not** treat a non-charging interest button as actual revenue.
- Price test (illustrative hypotheses, not market data): €2–4 one-off premium export; €5–9/month creator tier; paid custom build packs. Measure clicks → email/checkout intent → **real payments** only if/when launched, including refunds.
- Before a paid LLM-generation tier, calculate gross margin: `revenue - LLM inference - image parsing - rendering - hosting - payment fees - support`. Estimate cost per successful build, not per API call.
- Consider product constraints: child protection, parental accounts, rights to uploaded images, affiliate disclosures, brand/trademark disclaimer.

### P2: Backlog to explore only after signals
- Interactive rotate/zoom 3D vs existing instruction film (A/B or task completion observation).
- PDF printing, offline access and repeat printing.
- Duplo geometry (separate size system), Arduino/Raspberry Pi educational construction (electrical safety and real BOM checks), original reverse engineering from multiple photos (much harder than known-model matching).
- Third-party creator marketplace, commissioned designs, purchases of missing parts, physical kits.

## 4. Suggested validation gates (hypotheses, not industry benchmarks)

After 4 weeks or a minimum viable sample, review these **illustrative** thresholds:
- At least 100 **qualified** unique visitors from outside the founder/dev community.
- At least 30 successful end-to-end photo→usable-guide attempts.
- At least 10 physical build sessions independently attempted by parents/builders; >= 7 finish successfully. If fewer, investigate geometry UX, photos and instructions before acquisition.
- At least 20 users return for a second meaningful action within 30 days, **or** document why the true job is intentionally infrequent.
- At least 10 qualified users take a pricing/commerce action, followed by direct willingness-to-pay interviews. Not proof of conversion to revenue.

Report the denominator behind every % and note tiny samples. Do not treat thresholds as validated benchmarks or automatic PMF.

## 5. Agent work orders

- **RESEARCH-01**: Collect 10 additional competitors across AI LEGO generators, brick inventory, instruction platforms and part marketplaces. For each: prices, explicit features, social proof, traffic/app-store proxies, sources, last checked, reliability flags. Start with Brickit, Rebrickable and BrickLink.
- **RESEARCH-02**: Trace Mister Blocks founder's public statements and posts. Separate first-week traffic, later search growth and forecasts, and verify whether payment or actual user cohorts were subsequently disclosed. Do not scrape protected analytics.
- **DATA-01**: Audit existing Amplitude events in code. Propose a minimal event-gap plan that reuses current helpers and honors AGENTS.md privacy rules. Do not emit PII, photos, free text or raw part inventories.
- **DATA-02**: Generate funnel/retention/cost dashboard spec with precise denominators and dimensions; make available in repo as a separate artifact; note missing instrumentation.
- **UX-01**: Benchmark the existing build/disassemble user journey on actual devices/photos; capture errors and time to usable first result.
- **GROWTH-01**: Create 20 high-quality model pages / gallery plan, with indexing and canonical rules, plus two controlled acquisition experiments.
- **MONETIZATION-01**: Design ethical intent and price tests with unit-economics spreadsheet; **no live charge or misleading checkout** without owner approval.
- **VALIDATION-01**: Draft a short parent/hobbyist interview script and a consent-safe 10-person physical-build protocol.

## 6. Decision summary

Near-term priority order:
1. **Measure activation + genuine physical build success** before adding more generator complexity.
2. **Public browseable catalog + SEO**, informed by Mister Blocks maker's observations, but validate with our users.
3. **Reduce time and inference cost per successful build**; do not compare Meta matching cost with Claude end-to-end generation cost.
4. **Test whether reverse-build is a real differentiated job** vs browse/build.
5. **Only then** choose monetization and larger scope (Duplo, electronics, creator marketplace).

## 7. Source and verification hygiene
Store snapshots and dates if metrics are revisited. Do not conflate inferred installs with officially displayed install buckets; or PH engagement with visits, revenue or PMF. External figures are quoted/reported as of 2026-11-19 and may change.
