# ChatGPT App Directory submission

Everything the submission form asks for, in one place. Submit at platform.openai.com (Apps → Submit for review) from a **verified** organisation (Settings → Organization → Verification).

## Status checklist

| Item | Status |
|---|---|
| Public MCP server over HTTPS: `https://lego-mcp.vercel.app/mcp` | done |
| OAuth 2.1 (DCR + CIMD, PKCE S256, RFC 9207 `iss`) at `https://lego-auth.vercel.app` | done |
| Tool annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`, `idempotentHint`) on every tool | done |
| Widget CSP (`openai/widgetCSP`, media domain only, no `connect_domains`) | done |
| Privacy policy: `https://lego-mcp.vercel.app/privacy.html` | done |
| Terms of use: `https://lego-mcp.vercel.app/terms.html` | done |
| Test account for reviewers (login + password, no MFA, no passkey) | done, enable with `AUTH_REVIEW_PASSWORD` on `lego-auth` |
| Display name without the LEGO trademark: **My Bricks Builder** | done |
| Organisation verification on platform.openai.com | owner (manual) |
| Icon 512×512 PNG, screenshots | see below |

## Listing

- **Name:** My Bricks Builder
- **Subtitle (short description):** What to build from the bricks you own, with step-by-step instructions
- **Category:** Education & Research
- **Description:**
  Tell the app which bricks you have (a photo of the pile, a parts list or set numbers) and it suggests models you can build right now from exactly those parts, then draws step-by-step instructions in the style of a printed booklet, with a short build video on request. Every model is checked: nothing floats, nothing overlaps, and every part is one you own. Ideas that are almost buildable come with the exact list of missing parts. Works with DUPLO too: a house, a tower and a pyramid at real DUPLO scale. You can also photograph a model you already built and get the exact way to take it apart and rebuild something new. Free, no ads. Not affiliated with the LEGO Group.
- **Website:** https://github.com/elcodabra/lego-build-inventory
- **Support:** https://github.com/elcodabra/lego-build-inventory/issues
- **Privacy policy:** https://lego-mcp.vercel.app/privacy.html
- **Terms:** https://lego-mcp.vercel.app/terms.html

### Starter prompts

1. What can I build from my bricks? Here is a photo of my pile.
2. I have sets 31058 and 10696, what can I build from them?
3. Show me how to take apart the built-in cat model, then what else I can build from its parts.
4. I have DUPLO bricks: 20 red 2x4, 10 blue 2x2 and some blue roof slopes. What can my toddler build?

## Test account and test cases for reviewers

**Connect:** MCP URL `https://lego-mcp.vercel.app/mcp`, authentication OAuth. On the sign-in page open **"App reviewer? Sign in with the test account"**.

- Login: `reviewer`
- Password: the value of `AUTH_REVIEW_PASSWORD` on the `lego-auth` Vercel project (paste it into the form, never commit it)

The test account is a separate account (`u_app_review`), it never sees real users' data. Sign-in attempts are rate limited (5 per minute per IP).

| # | Prompt | Expected |
|---|---|---|
| 1 | "Use My Bricks Builder: my parts are 10 red 2x4 bricks, 8 white 2x2 bricks and 6 blue 2x2 slopes. What can I build?" | `inventory_import`, then `ideas_suggest`: a card with pictures of buildable ideas drawn from these parts, plus close ideas with missing parts |
| 2 | Press **Собрать / Build** on an idea, or "Build the house" | `idea_build` + `show_build`: the model card with steps |
| 3 | "Show me how to take apart the built-in cat" | `model_disassemble`: card with parts list, exploded view and reverse steps |
| 4 | "I have DUPLO: 20 red 3011, 10 blue 3437, 6 red 4199, 1 green 4672, 10 blue 6474. What can I build?" | DUPLO ideas only (house, tower, pyramid) |
| 5 | "Clear my parts list" | `inventory_clear` (marked destructive, ChatGPT asks to confirm) |

## Tool annotations justification

- Read-only (`readOnlyHint: true`): `lego_guide`, `lego_catalog`, `inventory_show`, `lego_photo_guide`, `ideas_suggest`, previews and cards.
- Write to the user's own data (`destructiveHint` true where data is replaced or removed): `inventory_import` (replace), `inventory_update` (negative qty removes), `inventory_undo`, `inventory_clear`, `model_save`.
- Open world (`openWorldHint: true`): `inventory_add_set` (Rebrickable), `parts_from_photo` / `parts_from_pile_photo` (Brickognize), video publishing (YouTube, unlisted, the app's own channel).

## Screenshots

`docs/img/chatgpt-disassemble-card.png` (ChatGPT, real UI) plus new ones to take with the reviewer account: ideas card, build steps card, DUPLO house card. 

## Before pressing Submit

1. `npx vercel env add AUTH_REVIEW_PASSWORD production --sensitive` in `auth/` (24+ random chars), then deploy `auth/` with the CLI.
2. Sign in once with the reviewer account in a clean ChatGPT developer-mode connector and run test cases 1 to 5.
3. Check Vercel logs for `amplitude_error` (none expected).
