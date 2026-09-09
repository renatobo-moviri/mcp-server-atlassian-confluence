# Field notes: the write path

**Date:** 2026-09-09
**Source:** a documentation session that made ~15 storage-format page writes against the
`uxenginelatest` space on `contentwise.atlassian.net` (tables, `<ac:image>` embeds,
`<ac:structured-macro>` panels). Reads went through `conf_get` and were trouble-free; every
point below is about `conf_post` / `conf_put` / `conf_patch`.

Nothing here has been filed upstream. Point 1 looks upstream-worthy
(`@aashari/mcp-server-atlassian-confluence`); point 2 is a doc line that could go either way;
point 3 is probably fork-local.

**Status (2026-09-09).** Points 1 and 2 are fixed on branch `fix/write-path-hardening`; point 3
is deliberately deferred. Still nothing filed upstream. See the per-point status lines below and
`docs/superpowers/specs/2026-09-09-write-path-fixes-plan.md` for the implementation plan.

| Point | Status | Commit |
|---|---|---|
| 1. Stringified body rejected | Fixed | `6eaab6d` |
| 2. Watcher notification cannot be suppressed | Documented | `fe659cf` |
| 3. Pre-write check for dropped macros | Deferred - needs a design decision | - |

One bug not in these notes was found while implementing them and fixed in the same branch
(`3969ef6`): `convertImgToAcImage` interpolated the attachment filename into `ri:filename="..."`
without XML escaping. The same commit wraps `decodeURIComponent` against malformed percent
sequences and stops `IMG_TAG_RE` swallowing a self-closing slash into the last unquoted
attribute. See point 4 below for what that unescaped output actually does against the live API -
it is **not** the 400 the code review predicted.

---

## 1. A stringified body is rejected before the request is ever made

> **Fixed** in `6eaab6d`. The `z.preprocess` form below was applied as written, with the
> `.describe()` text extended to mention that a JSON-encoded string is accepted. Covered by
> the new `src/tools/atlassian.api.types.test.ts`; the behavior table below was reproduced
> exactly. The inferred output type and the advertised JSON schema are unchanged.

**Where:** `src/tools/atlassian.api.types.ts:65`

```ts
const bodyField = z.record(z.string(), z.unknown())
```

`RequestWithBodyArgs` is aliased by `PostApiToolArgs`, `PutApiToolArgs` and `PatchApiToolArgs`,
so all three behave identically.

When a client sends `body` as a JSON **string** rather than an object, Zod rejects it at the
tool boundary. Reproduced against this repo's own zod (4.1.13):

```
$ node -e "const {z}=require('zod'); \
  console.log(z.record(z.string(),z.unknown()).safeParse('{\"a\":1}').error.issues[0].message)"
Invalid input: expected record, received string
```

This is reported to occur with large page bodies, where the client serializes the argument
instead of passing a structure. I did not reproduce the client-side stringification itself in
this session; the code path and the resulting error message are what is verified here. The
error is confusing in practice because it names a schema mismatch while the caller believes
they passed valid JSON, and it gives no hint that re-sending the same content as an object
would work.

**Suggested fix.** Coerce a JSON string to an object before the record check:

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

Tested against this repo's zod:

| Input | Result |
|---|---|
| `{spaceId: '1'}` | passes through unchanged |
| `'{"spaceId":"1"}'` | parsed to an object, accepted |
| `'{not json'` | `Invalid input: expected record, received string` |
| `'[1,2]'` | `Invalid input: expected record, received array` |

A `z.union([...])` with a `.transform` also works and was tested, but zod 4 collapses a failing
union member's custom message to a bare `Invalid input`, which is less useful than the messages
above. `preprocess` is both shorter and clearer at the failure site.

The downstream contract is unaffected: `preprocessStorageBody` and
`atlassianApiService.request` already take `Record<string, unknown>`, which is what preprocess
yields.

---

## 2. Watcher notifications cannot be suppressed, and the tool description should say so

> **Done** in `fe659cf`. Added as a `**Watchers:**` line in `CONF_PUT_DESCRIPTION`
> (`src/tools/atlassian.api.tool.ts`), next to the existing image-handling note. Note that the
> round-trip editing note this doc pointed at lives in `CONF_GET_DESCRIPTION`, not the PUT one.
> `README.md` was left unchanged - the nearby prose is generic to all three write tools.

Not a bug in this server. Confluence Cloud accepts `version.minorEdit` in the request body,
echoes it back in the PUT response, and then neither persists nor acts on it. Verified on
2026-09-09 across two pages and both endpoints (`/wiki/api/v2/pages/{id}` and
`/wiki/rest/api/content/{id}`): the stored version reads `minorEdit: false` in every case, and
watchers are notified. There is no `notifyWatchers` query parameter on Cloud; the "notify
watchers" checkbox is editor-only.

Worth one line in the `conf_put` description, next to the existing round-trip editing note, so
the next agent does not spend a turn discovering this. Something like: *watcher notification
cannot be suppressed through the API; `minorEdit` is accepted and ignored.*

Relevant when a space has external watchers. `GET /wiki/rest/api/space/{key}/watch` lists them.

---

## 3. Optional pre-write check for dropped macros and attachments

> **Deferred**, by decision on 2026-09-09: this is a design question, not a mechanical fix,
> and it was explicitly held back from the `fix/write-path-hardening` branch.

A whole-body `conf_put` that omits an element deletes it silently, with a 200 and no signal.
This is a Confluence-universal footgun rather than anything specific to this server, and it is
the reason the session in question routed its writes through a local helper script instead of
`conf_put`.

The generic, space-agnostic part worth considering here: before a PUT, fetch the live body and
compare counts of `<ac:image>`, `ri:attachment` and `<ac:structured-macro>` against the
outgoing body. If the new body has fewer, fail with a message naming what would be lost, unless
an explicit `allowLoss: true` is passed.

Deliberately **not** proposed: table-cell uniformity checks, forbidden cross-space link rules,
space-ID assumptions. Those are house style for one space and do not belong in a general
server.

Opt-in would be safest, since a legitimate delete is a normal edit.

---

## 4. What unescaped `ri:filename` actually does (measured, not predicted)

A code review claimed that an unescaped `&` in `ri:filename` produces malformed storage XML and
a 400 on write. **That is wrong.** Measured 2026-09-09 against `contentwise.atlassian.net`, on a
scratch page in a personal space, with real attachments uploaded and the page deleted afterwards:

| Filename char | Unescaped (pre-fix output) | Escaped (post-fix output) |
|---|---|---|
| `&` in `Q&A.png` | HTTP 200, stored as `Q&amp;A.png`, image resolves | HTTP 200, byte-identical stored result |
| `<` `>` in `x<y>.png` | HTTP 200, stored as `x&lt;y&gt;.png`, image resolves | HTTP 200, byte-identical stored result |
| `"` in `a"b.png` | HTTP 200, **silently truncated to `ri:filename="a"`** - reference destroyed | HTTP 200, `a&quot;b.png` preserved |

The storage-format parser is lenient: it repairs a bare `&`, `<` or `>` in an attribute value on
ingest, so for those characters the pre-fix and post-fix bodies are stored identically and there
was never a 400. The double quote is the real defect, and it fails in the worse direction - a
200 with the filename silently cut at the quote, which is the same class of silent-loss footgun
as point 3.

Two further observations from the same run:

- Confluence stores an attachment whose name contains `"` under the percent-encoded title
  `a%22b.png`, so a `ri:filename="a&quot;b.png"` reference does not resolve to it even when the
  XML is correct. Escaping is necessary but not sufficient for quote-bearing names.
- The `decodeURIComponent` hardening in the same commit is unrelated to Confluence's leniency: a
  malformed percent sequence threw a `URIError` client-side and aborted the whole conversion
  pass before any request was made. That one was a genuine crash.

**Net:** the escaping fix is correct and worth keeping - it stops relying on a lenient parser and
prevents the `"` truncation - but its severity was overstated. It is hygiene plus one real
silent-corruption case, not a fix for failing writes.
