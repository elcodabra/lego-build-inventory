# Rules for coding agents in this repository

Applies to every agent working here (Claude Code, Codex, Jcode, Cursor...). `CLAUDE.md` points here.

## Analytics: every new service and feature is wired to Amplitude

Usage analytics is not optional. When you add a server, an endpoint, an MCP tool, a page or a user flow, add Amplitude events for it **in the same change**, and test them.

**Where it goes**
- One Amplitude project for the whole product ("лего", US region, HTTP API `https://api2.amplitude.com/2/httpapi`). EU projects use `https://api.eu.amplitude.com/2/httpapi` via `AMPLITUDE_ENDPOINT`.
- The key is only an environment variable: `AMPLITUDE_API_KEY` on each Vercel project (`lego-mcp`, `lego-auth`, and any new one). Never in code, commits, logs or chat. Add it with `npx vercel env add AMPLITUDE_API_KEY production --sensitive` (copy the value from an existing project's settings or ask the owner). Without the variable, analytics must be a silent no-op.

**How to send**
- Reuse the existing helpers, don't add an SDK:
  - MCP server: `plugins/lego-inventory-build/skills/lego-inventory-build/api/_analytics.mjs` (`events()` + `send()`, called via `waitUntil`).
  - Sign-in server: `auth/lib/analytics.ts` (`track(event, props, accountId?)`, sent with Next.js `after()`).
  - A new service: copy the same pattern (plain `fetch` to the HTTP API, 3 s timeout, errors only logged as `{"ev":"amplitude_error"}`).
- Send **after** the response. Analytics must never slow down, block or fail a user request.

**Who the user is (must join up across services)**
- Signed-in users: `user_id = "a" + first 24 hex chars of sha256(account id)`. Both servers already compute exactly this (`analyticsUserId()` in `auth/lib/analytics.ts`, `userOf()` in `api/mcp.mjs`). A new service must use the same formula so the funnel sign-up → connect → tool calls stays one person.
- Owner key: `owner`. Anonymous steps before sign-in: a random `device_id`, no `user_id`.

**What to send**
- `event_type` in snake_case, past tense or noun: `signup`, `app_connected`, `tool_call`, `model_saved`.
- `event_properties`: small, non-personal facts: client (`chatgpt` / `claude` / `other`), tool or step name, status/HTTP code, duration in ms, error code, counts (parts, steps), mode.
- `platform`: the service (`mcp`, `auth`, ...).

**Never send**
Tokens, codes, refresh tokens, passkeys, keys or secrets, account ids in clear, names, e-mails, IP addresses, photos, part lists, model JSON, media URLs, free text typed by the user.

**Done means tested**
- Point `AMPLITUDE_ENDPOINT` at a local mock server in the test, run the real flow, and assert: the new events arrive, `user_id` has the right format and matches across services, and none of the forbidden values appear in the raw payloads. Example: `auth/test/e2e.mjs` (section "analytics") and `plugins/.../test/open-mode.mjs`.
- After deploying, check the Vercel logs show no `amplitude_error`.
- List the new events in the README "Analytics" paragraph.

## Other house rules

- Never commit secrets. `.chatgpt-connector-url.txt`, `.env*` and test certificates stay out of git.
- Deploy with `npx vercel@latest deploy --prod --yes --scope angry-team` from the project folder; push to GitHub after tests pass.
- Storage on Vercel Hobby is metered: prefer Redis (`api/_store.mjs`) over Blob operations, and keep media uploads deduplicated.
