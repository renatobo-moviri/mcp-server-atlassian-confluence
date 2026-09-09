# Design: write-path fixes (`ri:filename` escaping, `IMG_TAG_RE`, stringified `body`, watcher note) + conservative dependency refresh

**Date:** 2026-09-09
**Status:** Proposed

## Baseline (verified 2026-09-09)

- Branch `main`, clean except untracked `docs/2026-09-09-field-notes-write-path.md`.
- `npx jest --silent`: 7 suites, 86 tests pass. `npm run lint`: clean. `npx prettier --check 'src/**/*.ts' 'scripts/**/*.js'`: clean. `npx tsc --noEmit`: clean.
- zod installed: 4.1.13. MCP SDK installed: 1.23.0.
- Prettier config (`.prettierrc`): `singleQuote: true`, `semi: true`, `useTabs: true`, `tabWidth: 4`, `printWidth: 80`, `trailingComma: "all"`. ESLint runs `prettier/prettier: error`, so unformatted code fails `npm run lint`, not just `format`. Run `npm run format` before lint on every step.
- Commit convention is conventional commits (semantic-release): `fix:`, `feat:`, `chore(deps):`, `docs:`, `style:`.

## Premise corrections (source differs from the original brief)

1. **Fix D placement.** The "existing round-trip editing note" is in `CONF_GET_DESCRIPTION` (`src/tools/atlassian.api.tool.ts:183`), not in `CONF_PUT_DESCRIPTION`. The PUT description (lines 231-251) has "Note: PUT replaces entire resource. Version number must be incremented." (247) and "**Image handling:**" (249). The watcher line belongs in the PUT description next to those, not next to the GET note.
2. **Line numbers.** Fix A template string is at line 64 (not 63). Fix C `bodyField` starts at line 67 (field notes said 65). Fix B line 23 is correct. `minorEdit` at `src/services/vendor.atlassian.api.service.ts:364` is confirmed as the attachment-upload form field and is out of scope.
3. **Fix B scope is narrower than described.** Verified with the old regex: `<img src=/wiki/download/attachments/1/a.png />` (space before `/>`) already works, because `getAttr`'s `(\S+)` stops at the space. Only the no-space form `...a.png/>` yields `a.png/`. The lazy regex fixes that and produced identical captures on every quoted / single-quoted / `></img>` / no-slash case (tested all 13 existing test inputs' shapes).
4. **Fix C type claim is half right.** `z.infer` (output) of the preprocess pipe is still `Record<string, unknown>`, so `RequestWithBodyArgsType` is unchanged. `z.input` becomes `unknown`; nothing in the repo uses `z.input`, so no effect. Verified `.description` survives `.describe()` on the pipe, and `z.toJSONSchema(..., {io:'input'})` (which is what the SDK's `toJsonSchemaCompat` uses, `zod-json-schema-compat.js:50-52`) still emits `{"type":"object", "description": ..., "propertyNames": {...}, "additionalProperties": {}}`, i.e. the tool's advertised schema is unchanged. The SDK passes `parseResult.data` to the handler (`mcp.js:105`), so the coerced object is what `createWriteHandler` and the controller receive.
5. **No test file exists for the tool schemas.** `src/tools/` has no `*.test.ts`; Fix C needs a new `src/tools/atlassian.api.types.test.ts`.
6. **Dependency refresh: nothing security-relevant needs a major.** `npm audit` reports 30 advisories (2 critical, 18 high, 6 moderate, 4 low), all marked "fix available via `npm audit fix`" with no `--force`. The dry run: "added 8, removed 25, changed 125 packages". Caveat: 9 advisories live in packages **bundled inside `npm@11.6.4`** (transitive via `@semantic-release/npm`), which `npm audit fix` warns it "cannot fix automatically". `@semantic-release/npm` allows `npm@^11.6.2` and 11.19.1 is published, so `npm update npm` after `audit fix` should clear them in-range. Verify with a second `npm audit`.

## Fix A - escape XML attribute values in `convertImgToAcImage`

File: `src/utils/confluence-storage.util.ts`

- Add a module-private helper above `convertImgToAcImage`:
  `function escapeXmlAttr(value: string): string` replacing `&` -> `&amp;`, `<` -> `&lt;`, `>` -> `&gt;`, `"` -> `&quot;`, `'` -> `&apos;` (do `&` first). Order matters only for `&`.
- Apply to `filename` in the `ri:filename="..."` template (line 64) **and** to `width`/`height` in the `ac:width`/`ac:height` pushes (lines 61-62). Decision: cover width/height too. Cost is two wrapped calls; it closes the same attribute-termination class of bug (`width='1"'` from a single-quoted source), and there is no case where a legitimate width/height value contains a character that escaping would change.
- Do not escape before `decodeURIComponent`; decode first, then escape (a `%26amp%3B` in a URL must not double-encode). Note that `decodeURIComponent` can throw on malformed `%` sequences (e.g. `%E0%A4%A`); currently it would propagate and break the whole `replace`. Out of scope for this fix unless the team wants it; if included, wrap in try/catch and fall back to the raw match (leave the `<img>` untouched). Flagged as optional.

Tests to add in `src/utils/confluence-storage.util.test.ts` under `restoreAcImageMacros`:
- `Q%26A.png` -> `ri:filename="Q&amp;A.png"`.
- `a%22b.png` -> `ri:filename="a&quot;b.png"`.
- `x%3Cy%3E.png` -> `ri:filename="x&lt;y&gt;.png"`.
- Filename already containing a literal `&` in the URL (not encoded) -> escaped once, not `&amp;amp;`.
- Width containing a quote (single-quoted source `width='10"'`) -> `ac:width="10&quot;"`.
- Existing `my file (1).png` test must still pass unchanged (parentheses and spaces are not escaped).
- Optionally, if the decode try/catch is included: malformed `%E0%A4%A` leaves the `<img>` untouched.

## Fix B - lazy attribute capture in `IMG_TAG_RE`

File: same as A, line 23. Change to:

```ts
const IMG_TAG_RE = /<img\b([^>]*?)\/?>(?:<\/img>)?/gi;
```

Verified results with the lazy form: captured attrs no longer include the trailing `/` for `.../>`, ` .../>` (space preserved, harmless), single-quoted, `></img>`, and no-slash forms; full match spans are identical to the old regex in every case, so replacement boundaries do not move. Update the doc comment on lines 19-22 to mention the self-closing slash is excluded from the capture.

Tests to add:
- `<img src=/wiki/download/attachments/1/a.png/>` -> `ri:filename="a.png"` (the regression case; currently yields `a.png/`).
- `<img src=/wiki/download/attachments/1/a.png />` -> `a.png` (guards the already-working space form).
- Unquoted `width=300/>` -> `ac:width="300"` (same class of bug on width).
- The existing 13 `restoreAcImageMacros` tests are the regression net for quoted attributes; no changes needed.

A and B touch the same function and the same test file; they can be one commit (`fix: escape ac:image attribute values and stop capturing self-closing slash`) or two. They are independent in logic.

## Fix C - coerce a stringified `body` at the tool boundary

File: `src/tools/atlassian.api.types.ts`, lines 67-71.

Replace `bodyField` with the `z.preprocess(...)` form, keeping the exact `.describe()` string:

```ts
const bodyField = z
	.preprocess((v) => {
		if (typeof v !== 'string') return v;
		try {
			return JSON.parse(v);
		} catch {
			return v; // fall through to the record error below
		}
	}, z.record(z.string(), z.unknown()))
	.describe(/* unchanged */);
```

Verified on zod 4.1.13:

| Input | Result |
|---|---|
| `{spaceId:'1'}` | passes through, identity |
| `'{"spaceId":"1"}'` | parsed, accepted |
| `'{not json'` | `body: Invalid input: expected record, received string` |
| `'[1,2]'` | `body: Invalid input: expected record, received array` |
| `5`, `null`, `undefined` | `expected record, received number/null/undefined` |

Also update the JSDoc above it (lines 64-66) to note that a JSON string is accepted and parsed. Consider appending to the `.describe()` text: "(a JSON-encoded string is also accepted)". This changes the advertised schema description only; safe, optional.

Downstream untouched: `createWriteHandler` (`atlassian.api.tool.ts:81-120`) and `handleRequest` (`atlassian.api.controller.ts:57-95`) receive the parsed object because the SDK passes `parseResult.data`.

New test file `src/tools/atlassian.api.types.test.ts` (imports from `'./atlassian.api.types.js'`, `@jest/globals`, matching the `.js` suffix convention used by every other test):
- `RequestWithBodyArgs.safeParse({path:'/x', body:{a:1}})` -> success, `data.body` deep-equals input.
- Stringified object -> success, `data.body` is the parsed object.
- `'{not json'` -> failure, issue path `['body']`, message contains `expected record, received string`.
- `'[1,2]'` -> failure, message contains `received array`.
- Missing `body` -> failure (required).
- `PostApiToolArgs === PutApiToolArgs === PatchApiToolArgs === RequestWithBodyArgs` (identity, guards the aliasing).
- `RequestWithBodyArgs.shape.body.description` equals the describe text (guards the "describe survives" claim).
- Optional: `z.toJSONSchema(RequestWithBodyArgs, {io:'input'}).properties.body.type === 'object'` (guards the advertised schema).

Commit: `fix: accept a JSON-encoded string for the body argument of conf_post/conf_put/conf_patch`.

## Fix D - document that watcher notification cannot be suppressed

File: `src/tools/atlassian.api.tool.ts`, `CONF_PUT_DESCRIPTION` (lines 231-251).

Insert after line 247 ("Note: PUT replaces entire resource...") or as a new bolded item after **Image handling** (249), one line:

> **Watchers:** watcher notification cannot be suppressed through the API; `version.minorEdit` is accepted in the body and echoed back but ignored (Confluence Cloud). There is no notifyWatchers parameter.

Backticks inside the template literal must be escaped, matching the surrounding lines. No test needed (description string). Optionally mirror one sentence in `README.md` near line 156 ("Tools that accept a request body"). Do not touch `vendor.atlassian.api.service.ts:364`.

Commit: `docs: note that conf_put cannot suppress watcher notifications`.

## Dependency refresh (separate step, separable commit)

Survey (`npm outdated`, 2026-09-09).

In-range (wanted == a minor/patch inside the current caret) - take all:
`@eslint/js` 9.39.1->9.39.5, `@modelcontextprotocol/sdk` 1.23.0->1.30.0, `@semantic-release/github` 12.0.2->12.0.9, `@semantic-release/npm` 13.1.2->13.1.5, `@toon-format/toon` 2.0.1->2.3.1, `@types/express` 5.0.5->5.0.6, `@types/node` 24.10.1->24.13.3, `@typescript-eslint/*` and `typescript-eslint` 8.48.0->8.70.0, `commander` 14.0.2->14.0.3, `cors` 2.8.5->2.8.6, `dotenv` 17.2.3->17.4.2, `eslint` 9.39.1->9.39.5, `eslint-plugin-prettier` 5.5.4->5.5.6, `express` 5.1.0->5.2.1, `jest` 30.2.0->30.5.1, `nodemon` 3.1.11->3.1.14, `npm-check-updates` 19.1.2->19.6.6, `prettier` 3.7.3->3.9.6, `semantic-release` 25.0.2->25.0.9, `ts-jest` 29.4.5->29.4.12, `turndown` 7.2.2->7.2.4, `zod` 4.1.13->4.5.4.

Majors available - **flagged, not folded in** (none is required by any audit finding):
`@eslint/js` 10.0.1, `eslint` 10.10.0 (flat-config API changes; pairs with `typescript-eslint`), `@semantic-release/changelog` 7.0.0, `@semantic-release/git` 11.0.1, `@toon-format/toon` 4.1.1 (runtime dep; check encoder API before ever bumping), `@types/node` 26.5.0 (engines says `>=18`; CI uses Node 22), `commander` 15.0.0, `npm-check-updates` 23.1.0, `typescript` 7.0.2.

Procedure:

1. `npm update` (respects caret ranges, rewrites `package-lock.json`, leaves `package.json` alone). Prefer `npm update`, then `npm audit fix`, then `npm update npm`.
2. `npm audit`. Expect the 9 bundled-`npm` advisories (brace-expansion, minimatch x2, diff, picomatch, @isaacs/brace-expansion, @sigstore/core, ip-address, pacote, sigstore, tar, postcss-selector-parser under `node_modules/npm/`) to clear once `npm` moves to 11.19.x; if any remain, they are dev-only (release tooling) and should be listed in the commit body rather than forced.
3. Because `prettier` moves 3.7->3.9, run `npm run format` and inspect `git diff --stat src` - a formatter change can reformat files unrelated to this work. If it does, put that in its own `style:` commit (precedent: `6e55bfd style: apply prettier formatting`).
4. `@modelcontextprotocol/sdk` 1.23->1.30 fixes three advisories including "DNS rebinding protection not enabled by default" (GHSA-w48q-cv73-mx4w). `src/index.ts:100` constructs `StreamableHTTPServerTransport({ sessionIdGenerator: undefined, ... })` without `enableDnsRebindingProtection`/`allowedHosts`. Check the 1.30 changelog for whether the default flipped; if it did, HTTP mode may start rejecting requests whose `Host` is not localhost. Smoke test: `TRANSPORT_MODE=http node dist/index.js` after a build, then curl the `/mcp` endpoint (or `npm run mcp:inspect`). stdio mode is unaffected. SDK 1.30 peer range is `zod ^3.25 || ^4.0`, so zod 4.5.4 is fine.
5. `@toon-format/toon` 2.3.1 fixes prototype pollution in **decode**; this server only encodes (`src/utils/toon.util.ts`), so exposure is nil, but the bump is a patch-level formality. `src/utils/toon.util.test.ts` covers the output.
6. Full verification (below), then commit `chore(deps): update in-range dependencies and apply npm audit fixes` with the "left at major" list in the body.

This step touches only `package-lock.json` (and possibly formatting), so it can be committed before, after, or instead of the code fixes.

## Order and independence

| Step | Files | Depends on |
|---|---|---|
| 1. Fix A + B | `confluence-storage.util.ts`, its test | none |
| 2. Fix C | `atlassian.api.types.ts`, new `atlassian.api.types.test.ts` | none |
| 3. Fix D | `atlassian.api.tool.ts` (+ optional README) | none |
| 4. Deps | `package-lock.json` (+ possible `style:` commit) | none, but run last so the code fixes are validated against the currently locked toolchain first, then re-validated after the bump |

Steps 1-3 are independent of one another and of step 4. Recommended commit order: 1, 2, 3, 4 (four or five commits). If the prettier bump reformats files, do step 4 first in a separate branch/PR instead, so the fix diffs stay small.

## Verification commands (run after each step and at the end)

```
npm run format          # prettier --write 'src/**/*.ts' 'scripts/**/*.js'
npm run lint            # eslint (includes prettier/prettier: error)
npx tsc --noEmit        # type check without writing dist/ (npm run build = tsc, writes dist/)
npm test                # jest; expect 86 + new tests, 8 suites
npm run test:coverage   # optional; confirms confluence-storage.util.ts and atlassian.api.types.ts lines are covered
npm audit               # step 4 only; expect 0 or a documented dev-only remainder
git diff --stat         # step 4: confirm only package-lock.json changed (plus intended formatting)
```

Manual (optional, needs credentials): `conf_put` a scratch page whose storage body contains `<img src=".../attachments/{id}/Q%26A.png"/>`; expect 200 and `<ac:image><ri:attachment ri:filename="Q&amp;A.png"/></ac:image>` in the stored body.

## Out of scope

- Field-notes item 3 (pre-write dropped-macro check) - separate design.
- `decodeURIComponent` throw hardening (flagged as optional in Fix A).
- Any major dependency bump listed above.

## Critical files

- `src/utils/confluence-storage.util.ts` (Fix A, Fix B)
- `src/utils/confluence-storage.util.test.ts` (tests for A/B)
- `src/tools/atlassian.api.types.ts` (Fix C; new sibling `atlassian.api.types.test.ts`)
- `src/tools/atlassian.api.tool.ts` (Fix D, `CONF_PUT_DESCRIPTION` lines 231-251)
- `package.json` / `package-lock.json` (dependency refresh; `src/index.ts:100` for the SDK HTTP-transport smoke check)
