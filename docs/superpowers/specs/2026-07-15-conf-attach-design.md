# Design: `conf_attach` — upload file attachments to Confluence pages

**Date:** 2026-07-15
**Status:** Approved

## Problem

The server's five generic tools (`conf_get`/`conf_post`/`conf_put`/`conf_patch`/`conf_delete`) all flow through `fetchAtlassian()` in `src/utils/transport.util.ts`, which hardcodes `Content-Type: application/json` and `JSON.stringify(body)`. Confluence attachment uploads require `multipart/form-data` with binary file content plus the CSRF-bypass header `X-Atlassian-Token: nocheck`. As a result, images cannot be uploaded or updated through this MCP server today; users fall back to `curl` scripts (see internal doc "Uploading images on confluence pages (custom script)", page 4610097196).

Since the server runs on the same machine as the user's files (stdio transport), it can read image files directly from disk — binary data never passes through the model's context.

## Decisions (made with user)

1. **New dedicated tool `conf_attach`** — not an extension of `conf_post`, not base64 args.
2. **Upsert semantics** — automatically update the attachment if a file with the same name already exists on the page, else create it (mirrors the behavior of the existing `upload_screenshots.py` workflow).
3. **Upload only** — embedding the image into the page body via `<ac:image>` remains a separate `conf_get` + `conf_put` step; not in scope.

## Tool interface

Tool name: `conf_attach`

| Arg | Type | Required | Description |
|---|---|---|---|
| `pageId` | string | yes | ID of the target Confluence page |
| `filePath` | string | yes | Absolute or CWD-relative path to the file, read from the filesystem of the machine running the MCP server |
| `comment` | string | no | Attachment version comment (multipart `comment` field) |
| `jq` | string | no | JMESPath filter, same as other tools |
| `outputFormat` | `'toon' \| 'json'` | no | Same as other tools (TOON default) |

Response (after jq/TOON formatting, same pipeline as other tools): the attachment API response, augmented with a top-level `status` field of `"created"` or `"updated"`. When no `jq` is given, default to a compact object: `{ id, title, status, fileSize }` extracted from the API response rather than the full raw payload (attachment responses are verbose).

## API mechanics (Confluence REST v1 — v2 has no upload endpoint)

| Scenario | Endpoint | Method |
|---|---|---|
| Check existing | `/wiki/rest/api/content/{pageId}/child/attachment?filename={name}` | GET |
| Not present yet | `/wiki/rest/api/content/{pageId}/child/attachment` | POST |
| Already present | `/wiki/rest/api/content/{pageId}/child/attachment/{attId}/data` | POST |

All uploads: basic auth (existing credentials), `multipart/form-data` body with a `file` part (and optional `comment` part), header `X-Atlassian-Token: nocheck`. Success is HTTP 200. The create endpoint returns `{results: [...]}`; the update endpoint returns the attachment object directly — normalize both to a single attachment object.

## Architecture — follow the existing 4-layer pattern

### 1. Transport (`src/utils/transport.util.ts`)

Make `fetchAtlassian()` multipart-aware:

- When `options.body instanceof FormData`:
  - pass it to `fetch` as-is (no `JSON.stringify`);
  - do **not** set `Content-Type` (fetch/undici sets `multipart/form-data; boundary=...` itself — setting it manually breaks the boundary);
  - keep `Authorization` and `Accept: application/json`;
  - caller-supplied `options.headers` still merge in (this is how `X-Atlassian-Token: nocheck` arrives).
- JSON path is unchanged for every existing caller.

Node 18+ provides global `fetch`, `FormData`, and `Blob` — no new dependencies.

### 2. Service (`src/services/vendor.atlassian.api.service.ts`)

New exported `uploadAttachment(pageId: string, filePath: string, comment?: string)`:

1. Validate credentials (existing `validateCredentials()`).
2. Read the file with `node:fs/promises` `readFile`; resolve the path with `path.resolve` against CWD. Throw a clear `McpError` (bad-request style) if the file is missing or unreadable, **before** any network call.
3. GET the existence-check endpoint with `filename=basename(filePath)` (URL-encoded via existing `appendQueryParams`).
4. Build `FormData`: `file` part from `new Blob([buffer])` with the filename (`formData.append('file', blob, filename)`); infer a reasonable MIME type from the extension (a tiny inline map for common image types — png, jpg/jpeg, gif, svg, webp, pdf — falling back to `application/octet-stream`); append `comment` part if provided; append `minorEdit=true`.
5. POST to the create or update endpoint per the table above, with header `X-Atlassian-Token: nocheck`, via `fetchAtlassian`.
6. Normalize the response to one attachment object and return it together with `status: 'created' | 'updated'` and the transport's `rawResponsePath`.

### 3. Controller (`src/controllers/atlassian.api.controller.ts`)

New `handleAttach(options)`:

- Calls `uploadAttachment`, merges `status` into the result object, then reuses the existing `applyJqFilter` + `toOutputString` pipeline and `handleControllerError` wrapping — identical formatting behavior to the other five handlers.
- Default (no `jq`) output: compact `{ id, title, status, fileSize }`.

### 4. Tool layer (`src/tools/atlassian.api.types.ts` + `src/tools/atlassian.api.tool.ts`)

- New zod schema `AttachApiToolArgs`: `pageId`, `filePath`, optional `comment`, plus the shared `jq`/`outputFormat` fields (no `path`/`queryParams` — the endpoint is fixed).
- Register `conf_attach` via `server.registerTool` like the others. Description must state:
  - uploads a **local file** as a page attachment (create-or-update by filename);
  - `filePath` is read from the filesystem of the machine running the MCP server;
  - `conf_post`/`conf_put` **cannot** upload files (JSON-only) — use this tool;
  - embedding in the page body is a separate step: reference the attachment by filename with `<ac:image><ri:attachment ri:filename="name.png" /></ac:image>` via `conf_put`;
  - to delete an attachment use `conf_delete` with `/wiki/api/v2/attachments/{id}`.

## Error handling

- File missing/unreadable → `McpError` with the resolved absolute path in the message, thrown before any network call.
- API failures (403 stale token, 404 bad pageId, 413 too large) flow through the existing `fetchAtlassian` error mapping and `handleControllerError`.

## Testing

- **Transport** (`transport.util.test.ts` additions): with a mocked global `fetch`, assert that a `FormData` body is passed through un-stringified, `Content-Type` is absent from headers, `Authorization`/`Accept` are present, extra headers merge; and that the JSON path is unchanged.
- **Service** (new `vendor.atlassian.api.service.test.ts` or colocated): mock `fetch`; assert upsert routing (existing attachment → `/data` endpoint; none → create endpoint), the `X-Atlassian-Token: nocheck` header, `status` values, and the missing-file error (no fetch performed).
- Follow existing Jest patterns in `src/utils/*.test.ts`.
- Post-implementation manual verification: upload a small PNG to a scratch page twice; expect `created` then `updated`, and verify via `conf_get` on `/wiki/rest/api/content/{pageId}/child/attachment`.

## Out of scope

- Embedding images into page bodies (existing `conf_put` + storage-format handling covers it).
- Base64 upload path for remote/HTTP deployments.
- CLI subcommand for upload (can be added later if wanted).

## Notes

- The server also supports HTTP transport mode; `filePath` is always read from the **server's** filesystem. In the user's deployment (local stdio) this is the same machine. The tool description states this.
- Also update `README.md` (tool list) and the `CONF_POST_DESCRIPTION` (add one line pointing file uploads at `conf_attach`).
