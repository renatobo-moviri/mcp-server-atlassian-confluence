import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Logger } from '../utils/logger.util.js';
import { formatErrorForMcpTool } from '../utils/error.util.js';
import { truncateForAI } from '../utils/formatter.util.js';
import {
	GetApiToolArgs,
	type GetApiToolArgsType,
	RequestWithBodyArgs,
	type RequestWithBodyArgsType,
	DeleteApiToolArgs,
	AttachApiToolArgs,
	type AttachApiToolArgsType,
} from './atlassian.api.types.js';
import {
	handleGet,
	handlePost,
	handlePut,
	handlePatch,
	handleDelete,
	handleAttach,
} from '../controllers/atlassian.api.controller.js';

// Create a contextualized logger for this file
const toolLogger = Logger.forContext('tools/atlassian.api.tool.ts');

// Log tool initialization
toolLogger.debug('Confluence API tool initialized');

/**
 * Creates an MCP tool handler for GET/DELETE requests (no body)
 *
 * @param methodName - Name of the HTTP method for logging
 * @param handler - Controller handler function
 * @returns MCP tool handler function
 */
function createReadHandler(
	methodName: string,
	handler: (
		options: GetApiToolArgsType,
	) => Promise<{ content: string; rawResponsePath?: string | null }>,
) {
	return async (args: Record<string, unknown>) => {
		const methodLogger = Logger.forContext(
			'tools/atlassian.api.tool.ts',
			methodName.toLowerCase(),
		);
		methodLogger.debug(`Making ${methodName} request with args:`, args);

		try {
			const result = await handler(args as GetApiToolArgsType);

			methodLogger.debug(
				'Successfully retrieved response from controller',
			);

			return {
				content: [
					{
						type: 'text' as const,
						text: truncateForAI(
							result.content,
							result.rawResponsePath,
						),
					},
				],
			};
		} catch (error) {
			methodLogger.error(`Failed to make ${methodName} request`, error);
			return formatErrorForMcpTool(error);
		}
	};
}

/**
 * Creates an MCP tool handler for POST/PUT/PATCH requests (with body)
 *
 * @param methodName - Name of the HTTP method for logging
 * @param handler - Controller handler function
 * @returns MCP tool handler function
 */
function createWriteHandler(
	methodName: string,
	handler: (
		options: RequestWithBodyArgsType,
	) => Promise<{ content: string; rawResponsePath?: string | null }>,
) {
	return async (args: Record<string, unknown>) => {
		const methodLogger = Logger.forContext(
			'tools/atlassian.api.tool.ts',
			methodName.toLowerCase(),
		);
		methodLogger.debug(`Making ${methodName} request with args:`, {
			path: args.path,
			bodyKeys: args.body ? Object.keys(args.body as object) : [],
		});

		try {
			const result = await handler(args as RequestWithBodyArgsType);

			methodLogger.debug(
				'Successfully received response from controller',
			);

			return {
				content: [
					{
						type: 'text' as const,
						text: truncateForAI(
							result.content,
							result.rawResponsePath,
						),
					},
				],
			};
		} catch (error) {
			methodLogger.error(`Failed to make ${methodName} request`, error);
			return formatErrorForMcpTool(error);
		}
	};
}

// Create tool handlers
const get = createReadHandler('GET', handleGet);
const post = createWriteHandler('POST', handlePost);
const put = createWriteHandler('PUT', handlePut);
const patch = createWriteHandler('PATCH', handlePatch);
const del = createReadHandler('DELETE', handleDelete);

/**
 * MCP tool handler for uploading a local file as a page attachment.
 * Uses a dedicated arg shape (pageId/filePath/comment) rather than path/body.
 */
const attach = async (args: Record<string, unknown>) => {
	const methodLogger = Logger.forContext(
		'tools/atlassian.api.tool.ts',
		'attach',
	);
	methodLogger.debug('Uploading attachment with args:', {
		pageId: args.pageId,
		filePath: args.filePath,
	});

	try {
		const result = await handleAttach(args as AttachApiToolArgsType);

		methodLogger.debug('Successfully received response from controller');

		return {
			content: [
				{
					type: 'text' as const,
					text: truncateForAI(result.content, result.rawResponsePath),
				},
			],
		};
	} catch (error) {
		methodLogger.error('Failed to upload attachment', error);
		return formatErrorForMcpTool(error);
	}
};

// Tool descriptions
const CONF_GET_DESCRIPTION = `Read any Confluence data. Returns TOON format by default (30-60% fewer tokens than JSON).

**IMPORTANT - Cost Optimization:**
- ALWAYS use \`jq\` param to filter response fields. Unfiltered responses are very expensive!
- Use \`limit\` query param to restrict result count (e.g., \`limit: "5"\`)
- If unsure about available fields, first fetch ONE item with \`limit: "1"\` and NO jq filter to explore the schema, then use jq in subsequent calls

**Schema Discovery Pattern:**
1. First call: \`path: "/wiki/api/v2/spaces", queryParams: {"limit": "1"}\` (no jq) - explore available fields
2. Then use: \`jq: "results[*].{id: id, key: key, name: name}"\` - extract only what you need

**Output format:** TOON (default, token-efficient) or JSON (\`outputFormat: "json"\`)

**Common paths:**
- \`/wiki/api/v2/spaces\` - list spaces
- \`/wiki/api/v2/pages\` - list pages (use \`space-id\` query param)
- \`/wiki/api/v2/pages/{id}\` - get page details
- \`/wiki/api/v2/pages/{id}/body\` - get page body (\`body-format\`: storage, atlas_doc_format, view)
- \`/wiki/rest/api/search\` - search content (\`cql\` query param)

**Round-trip editing:** When reading a page to modify and write back, use \`body-format: "storage"\` to get Confluence storage format. This preserves \`<ac:image>\`, \`<ac:structured-macro>\`, and other Confluence-specific XML elements needed for correct rendering.

**JQ examples:** \`results[*].id\`, \`results[0]\`, \`results[*].{id: id, title: title}\`

API reference: https://developer.atlassian.com/cloud/confluence/rest/v2/`;

const CONF_POST_DESCRIPTION = `Create Confluence resources. Returns TOON format by default (token-efficient).

**IMPORTANT - Cost Optimization:**
- Use \`jq\` param to extract only needed fields from response (e.g., \`jq: "{id: id, title: title}"\`)
- Unfiltered responses include all metadata and are expensive!

**Output format:** TOON (default) or JSON (\`outputFormat: "json"\`)

**Common operations:**

1. **Create page:** \`/wiki/api/v2/pages\`
   body: \`{"spaceId": "123456", "status": "current", "title": "Page Title", "parentId": "789", "body": {"representation": "storage", "value": "<p>Content</p>"}}\`

2. **Create blog post:** \`/wiki/api/v2/blogposts\`
   body: \`{"spaceId": "123456", "status": "current", "title": "Blog Title", "body": {"representation": "storage", "value": "<p>Content</p>"}}\`

3. **Add label:** \`/wiki/api/v2/pages/{id}/labels\` - body: \`{"name": "label-name"}\`

4. **Add comment:** \`/wiki/api/v2/pages/{id}/footer-comments\`

**File uploads:** This tool is JSON-only and cannot upload files. To attach a local file (image, PDF, etc.) to a page, use the \`conf_attach\` tool instead.

API reference: https://developer.atlassian.com/cloud/confluence/rest/v2/`;

const CONF_ATTACH_DESCRIPTION = `Upload a local file to a Confluence page as an attachment (create-or-update by filename). Returns TOON format by default.

Reads the file from the filesystem of the machine running the MCP server (\`filePath\` is an absolute or CWD-relative path), so binary data never passes through the model context. If an attachment with the same filename already exists on the page it is updated in place (new version); otherwise a new attachment is created. The response includes a \`status\` field of \`"created"\` or \`"updated"\`.

**Why this tool:** \`conf_post\`/\`conf_put\` are JSON-only and CANNOT upload files. Use \`conf_attach\` for any binary/file upload (images, PDFs, etc.).

**Arguments:**
- \`pageId\` - target page ID (e.g., "456789")
- \`filePath\` - path to the local file (e.g., "./diagram.png")
- \`comment\` - optional attachment version comment
- \`jq\` / \`outputFormat\` - standard response formatting (default compact \`{id, title, status, fileSize}\`)

**Embedding in the page body is a separate step:** uploading only attaches the file. To display it, fetch the page body with \`conf_get\` (\`body-format: "storage"\`), insert \`<ac:image><ri:attachment ri:filename="name.png" /></ac:image>\` referencing the attachment by filename, then write it back with \`conf_put\`.

**Deleting an attachment:** use \`conf_delete\` with \`/wiki/api/v2/attachments/{id}\`.

Note: The server may run in HTTP transport mode; \`filePath\` is always read from the server's filesystem.`;

const CONF_PUT_DESCRIPTION = `Replace Confluence resources (full update). Returns TOON format by default.

**IMPORTANT - Cost Optimization:**
- Use \`jq\` param to extract only needed fields from response
- Example: \`jq: "{id: id, version: version.number}"\`

**Output format:** TOON (default) or JSON (\`outputFormat: "json"\`)

**Common operations:**

1. **Update page:** \`/wiki/api/v2/pages/{id}\`
   body: \`{"id": "123", "status": "current", "title": "Updated Title", "spaceId": "456", "body": {"representation": "storage", "value": "<p>Content</p>"}, "version": {"number": 2}}\`
   Note: version.number must be incremented

2. **Update blog post:** \`/wiki/api/v2/blogposts/{id}\`

Note: PUT replaces entire resource. Version number must be incremented.

**Image handling:** When updating with \`representation: "storage"\`, any \`<img>\` tags pointing to Confluence attachment URLs are automatically converted back to \`<ac:image>\` macros for correct rendering.

**Watchers:** watcher notification cannot be suppressed through the API; \`version.minorEdit\` is accepted in the body and echoed back but ignored by Confluence Cloud, and there is no \`notifyWatchers\` parameter.

**Whole-body replacement:** Replaces the entire page body. Any \`<ac:image>\`, \`<ri:attachment>\` or \`<ac:structured-macro>\` present on the live page and absent from this body is deleted, with a 200 and no warning. Fetch the current body with \`conf_get\` and edit that, rather than composing a body from scratch.

API reference: https://developer.atlassian.com/cloud/confluence/rest/v2/`;

const CONF_PATCH_DESCRIPTION = `Partially update Confluence resources. Returns TOON format by default.

**IMPORTANT - Cost Optimization:** Use \`jq\` param to filter response fields.

**Output format:** TOON (default) or JSON (\`outputFormat: "json"\`)

**Common operations:**

1. **Update space:** \`/wiki/api/v2/spaces/{id}\`
   body: \`{"name": "New Name", "description": {"plain": {"value": "Desc", "representation": "plain"}}}\`

2. **Update comment:** \`/wiki/api/v2/footer-comments/{id}\`

Note: Confluence v2 API primarily uses PUT for updates.

API reference: https://developer.atlassian.com/cloud/confluence/rest/v2/`;

const CONF_DELETE_DESCRIPTION = `Delete Confluence resources. Returns TOON format by default.

**Output format:** TOON (default) or JSON (\`outputFormat: "json"\`)

**Common operations:**
- \`/wiki/api/v2/pages/{id}\` - Delete page
- \`/wiki/api/v2/blogposts/{id}\` - Delete blog post
- \`/wiki/api/v2/pages/{id}/labels/{label-id}\` - Remove label
- \`/wiki/api/v2/footer-comments/{id}\` - Delete comment
- \`/wiki/api/v2/attachments/{id}\` - Delete attachment

Note: Most DELETE endpoints return 204 No Content on success.

API reference: https://developer.atlassian.com/cloud/confluence/rest/v2/`;

/**
 * Register generic Confluence API tools with the MCP server.
 * Uses the modern registerTool API (SDK v1.22.0+) instead of deprecated tool() method.
 */
function registerTools(server: McpServer) {
	const registerLogger = Logger.forContext(
		'tools/atlassian.api.tool.ts',
		'registerTools',
	);
	registerLogger.debug('Registering API tools...');

	// Register the GET tool using modern registerTool API
	server.registerTool(
		'conf_get',
		{
			title: 'Confluence GET Request',
			description: CONF_GET_DESCRIPTION,
			inputSchema: GetApiToolArgs,
		},
		get,
	);

	// Register the POST tool using modern registerTool API
	server.registerTool(
		'conf_post',
		{
			title: 'Confluence POST Request',
			description: CONF_POST_DESCRIPTION,
			inputSchema: RequestWithBodyArgs,
		},
		post,
	);

	// Register the PUT tool using modern registerTool API
	server.registerTool(
		'conf_put',
		{
			title: 'Confluence PUT Request',
			description: CONF_PUT_DESCRIPTION,
			inputSchema: RequestWithBodyArgs,
		},
		put,
	);

	// Register the PATCH tool using modern registerTool API
	server.registerTool(
		'conf_patch',
		{
			title: 'Confluence PATCH Request',
			description: CONF_PATCH_DESCRIPTION,
			inputSchema: RequestWithBodyArgs,
		},
		patch,
	);

	// Register the DELETE tool using modern registerTool API
	server.registerTool(
		'conf_delete',
		{
			title: 'Confluence DELETE Request',
			description: CONF_DELETE_DESCRIPTION,
			inputSchema: DeleteApiToolArgs,
		},
		del,
	);

	// Register the attachment upload tool using modern registerTool API
	server.registerTool(
		'conf_attach',
		{
			title: 'Confluence Upload Attachment',
			description: CONF_ATTACH_DESCRIPTION,
			inputSchema: AttachApiToolArgs,
		},
		attach,
	);

	registerLogger.debug('Successfully registered API tools');
}

export default { registerTools };
