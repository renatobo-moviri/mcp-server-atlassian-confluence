# Field notes: the write path

**Date:** 2026-09-09
**Source:** a documentation session that made ~15 storage-format page writes against an
internal Confluence Cloud space (tables, `<ac:image>` embeds, `<ac:structured-macro>` panels). Reads went through `conf_get` and were trouble-free; every
point below is about `conf_post` / `conf_put` / `conf_patch`.

Nothing here has been filed upstream. Point 1 looks upstream-worthy
(`@aashari/mcp-server-atlassian-confluence`); point 2 is a doc line that could go either way;
point 3 is probably fork-local.

**Status (2026-09-09).** Points 1 and 2 are fixed on branch `fix/write-path-hardening`; point 3
is deliberately deferred. Still nothing filed upstream. See the per-point status lines below and
`docs/superpowers/specs/2026-09-09-write-path-fixes-plan.md` for the implementation plan.

| Point | Status | Commit |
|---|---|---|
| 1. Stringified body rejected | Fixed | `8627905` |
| 2. Watcher notification cannot be suppressed | Documented | `1a22af2` |
| 3. Pre-write check for dropped macros | Deferred - needs a design decision | - |

One bug not in these notes was found while implementing them and fixed in the same branch
(`d74b7eb`): `convertImgToAcImage` interpolated the attachment filename into `ri:filename="..."`
without XML escaping. The same commit wraps `decodeURIComponent` against malformed percent
sequences and stops `IMG_TAG_RE` swallowing a self-closing slash into the last unquoted
attribute. See point 4 below for what that unescaped output actually does against the live API -
it is **not** the 400 the code review predicted.

---

## 1. A stringified body is rejected before the request is ever made

> **Fixed** in `8627905`. The `z.preprocess` form below was applied as written, with the
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

> **Done** in `1a22af2`. Added as a `**Watchers:**` line in `CONF_PUT_DESCRIPTION`
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

## 3 (decided). Split it: build the format lint, skip the diff-against-live check

Answering the open design question, 2026-09-09, after the escaping measurements in point 4.

**The line I would draw: the server enforces format, the caller enforces intent.** A general
server should make *malformed* writes impossible and leave *unwise* writes to whoever knows what
the edit was for. That splits the original proposal in two, and the two halves land on opposite
sides of the line.

### Worth building: a lint for a raw `"` inside an `ri:filename` already in the outgoing body

Not redundant with the escaping fix, though the overlap is easy to assume. `escapeXmlAttr` is
reached only from `convertImgToAcImage`, i.e. only for filenames the server *reconstructs* from an
`<img>` tag pointing at a Confluence attachment URL. `preprocessStorageBody` never inspects an
`<ri:attachment>` that the caller wrote itself. So this body:

```xml
<ac:image><ri:attachment ri:filename="a"b.png"/></ac:image>
```

passes through untouched today and hits the truncation in point 4's table: HTTP 200,
`ri:filename="a"`, reference destroyed, no signal. For a server whose callers are language models
hand-writing storage XML, that is the realistic path to the failure, not the `<img>` path that is
already covered.

Scope it to exactly that gap: scan the outgoing body for `ri:filename="…"` values containing a raw
`"`, and reject with a message naming the filename. Stateless, no extra API call, and there is no
legitimate unescaped double quote inside a double-quoted attribute, so a false positive is not
reachable on a well-formed body.

**Frame it as fail-fast, not as corruption-prevention.** Point 4 establishes that Confluence stores
a quote-bearing attachment under the percent-encoded title `a%22b.png`, so the reference does not
resolve even when the XML is correct. Escaping is necessary and insufficient. The honest value of
the lint is that it turns a name that can never work into a loud error at write time instead of a
silently broken image discovered weeks later.

### Not worth building: comparing macro and attachment counts against the live page

This is the half I originally proposed, and I now think it does not belong in this server.

1. **It makes a write tool secretly a read tool.** The check needs a GET before every PUT: double
   the requests, added latency, and a surprising interaction with rate limits.
2. **"Loss" is an intent judgment, not a correctness one.** Deleting an image is an ordinary edit.
   The check is therefore only usable with an override, and the caller has to know its own intent
   to set the override, at which point the caller is the right place for the whole check.
3. **Counts are a crude proxy.** They cannot separate a deliberate removal from an accidental one,
   and they miss the case that actually bites: a body whose counts match but whose elements were
   swapped.
4. **An escape hatch that is always available gets passed reflexively.** Our own helper has
   `--allow-loss`, and what keeps it honest is a written rule never to use it, not the flag.
   Shipping that dynamic to every consumer of a general server makes the guard decorative.

### Cheaper and better than either: one sentence in `CONF_PUT_DESCRIPTION`

The root cause is that callers do not know `conf_put` replaces the whole body. Say so where they
will read it, next to the watcher line that just went in:

> Replaces the entire page body. Any `<ac:image>`, `<ri:attachment>` or `<ac:structured-macro>`
> present on the live page and absent from this body is deleted, with a 200 and no warning. Fetch
> the current body with `conf_get` and edit that, rather than composing a body from scratch.

Zero runtime cost, no false positives, and it addresses the actual failure, which is a caller who
did not know the semantics rather than a caller who knew and slipped.

### What stays on our side

The count-diff guard remains in the caller (`scripts/conf_page.py` in the documentation repo),
along with the space-specific rules that were already excluded from this proposal. That is the
right home for it: it knows the editorial intent of each edit, and it is used by one team that can
hold a convention about the override flag.

---

## 4. What unescaped `ri:filename` actually does (measured, not predicted)

A code review claimed that an unescaped `&` in `ri:filename` produces malformed storage XML and
a 400 on write. **That is wrong.** Measured 2026-09-09 against Confluence Cloud, on a
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
