import atlassianApiService from '../services/vendor.atlassian.api.service.js';
import { Logger } from '../utils/logger.util.js';
import { handleControllerError } from '../utils/error-handler.util.js';
import { ControllerResponse } from '../types/common.types.js';
import {
	AttachApiToolArgsType,
	GetApiToolArgsType,
	RequestWithBodyArgsType,
} from '../tools/atlassian.api.types.js';
import { applyJqFilter, toOutputString } from '../utils/jq.util.js';
import { preprocessStorageBody } from '../utils/confluence-storage.util.js';

/**
 * @namespace AtlassianApiController
 * @description Controller for handling generic Confluence API requests.
 *              Orchestrates calls to the Atlassian API service and handles
 *              response formatting (JQ filtering, TOON/JSON output).
 *
 * Architecture:
 * - Tool → Controller (this file) → Service → Transport
 * - Controller handles: JQ filtering, output formatting, error context
 * - Service handles: Credentials, path normalization, API calls
 */

// Logger instance for this module
const logger = Logger.forContext('controllers/atlassian.api.controller.ts');

/**
 * Output format type
 */
type OutputFormat = 'toon' | 'json';

/**
 * Base options for all API requests
 */
interface BaseRequestOptions {
	path: string;
	queryParams?: Record<string, string>;
	jq?: string;
	outputFormat?: OutputFormat;
}

/**
 * Options for requests that include a body (POST, PUT, PATCH)
 */
interface RequestWithBodyOptions extends BaseRequestOptions {
	body?: Record<string, unknown>;
}

/**
 * Shared handler for all HTTP methods
 *
 * @param method - HTTP method (GET, POST, PUT, PATCH, DELETE)
 * @param options - Request options including path, queryParams, body (for non-GET), and jq filter
 * @returns Promise with formatted response content
 */
async function handleRequest(
	method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
	options: RequestWithBodyOptions,
): Promise<ControllerResponse> {
	const methodLogger = logger.forMethod(`handle${method}`);

	try {
		methodLogger.debug(`Making ${method} request`, {
			path: options.path,
			...(options.body && { bodyKeys: Object.keys(options.body) }),
		});

		// For write operations, fix <img> tags that should be <ac:image> macros
		// in storage format content (round-trip editing fix)
		const body =
			options.body && (method === 'PUT' || method === 'POST')
				? preprocessStorageBody(options.body)
				: options.body;

		// Call the service layer (returns TransportResponse with data and rawResponsePath)
		const response = await atlassianApiService.request<unknown>(
			options.path,
			{
				method,
				queryParams: options.queryParams,
				body,
			},
		);

		methodLogger.debug('Successfully received response from service');

		// Apply JQ filter if provided, otherwise return raw data
		const result = applyJqFilter(response.data, options.jq);

		// Convert to output format (TOON by default, JSON if requested)
		const useToon = options.outputFormat !== 'json';
		const content = await toOutputString(result, useToon);

		return {
			content,
			rawResponsePath: response.rawResponsePath,
		};
	} catch (error) {
		throw handleControllerError(error, {
			entityType: 'API',
			operation: `${method} request`,
			source: `controllers/atlassian.api.controller.ts@handle${method}`,
			additionalInfo: { path: options.path },
		});
	}
}

/**
 * Generic GET request to Confluence API
 *
 * @param options - Options containing path, queryParams, and optional jq filter
 * @returns Promise with raw JSON response (optionally filtered)
 */
export async function handleGet(
	options: GetApiToolArgsType,
): Promise<ControllerResponse> {
	return handleRequest('GET', options);
}

/**
 * Generic POST request to Confluence API
 *
 * @param options - Options containing path, body, queryParams, and optional jq filter
 * @returns Promise with raw JSON response (optionally filtered)
 */
export async function handlePost(
	options: RequestWithBodyArgsType,
): Promise<ControllerResponse> {
	return handleRequest('POST', options);
}

/**
 * Generic PUT request to Confluence API
 *
 * @param options - Options containing path, body, queryParams, and optional jq filter
 * @returns Promise with raw JSON response (optionally filtered)
 */
export async function handlePut(
	options: RequestWithBodyArgsType,
): Promise<ControllerResponse> {
	return handleRequest('PUT', options);
}

/**
 * Generic PATCH request to Confluence API
 *
 * @param options - Options containing path, body, queryParams, and optional jq filter
 * @returns Promise with raw JSON response (optionally filtered)
 */
export async function handlePatch(
	options: RequestWithBodyArgsType,
): Promise<ControllerResponse> {
	return handleRequest('PATCH', options);
}

/**
 * Generic DELETE request to Confluence API
 *
 * @param options - Options containing path, queryParams, and optional jq filter
 * @returns Promise with raw JSON response (optionally filtered)
 */
export async function handleDelete(
	options: GetApiToolArgsType,
): Promise<ControllerResponse> {
	return handleRequest('DELETE', options);
}

/**
 * Upload a local file to a Confluence page as an attachment (create-or-update).
 *
 * @param options - Options containing pageId, filePath, optional comment, and jq/outputFormat
 * @returns Promise with formatted response content
 */
export async function handleAttach(
	options: AttachApiToolArgsType,
): Promise<ControllerResponse> {
	const methodLogger = logger.forMethod('handleAttach');

	try {
		methodLogger.debug('Uploading attachment', {
			pageId: options.pageId,
			filePath: options.filePath,
		});

		// Call the service layer (reads the file and performs the upsert)
		const { attachment, status, rawResponsePath } =
			await atlassianApiService.uploadAttachment(
				options.pageId,
				options.filePath,
				options.comment,
			);

		methodLogger.debug(`Attachment ${status} successfully`);

		// When a jq filter is supplied, run it against the full attachment
		// object augmented with the upsert status. Otherwise return a compact
		// summary since raw attachment payloads are verbose.
		let result: unknown;
		if (options.jq) {
			result = applyJqFilter({ ...attachment, status }, options.jq);
		} else {
			const extensions = attachment.extensions as
				| Record<string, unknown>
				| undefined;
			result = {
				id: attachment.id,
				title: attachment.title,
				status,
				fileSize: extensions?.fileSize ?? attachment.fileSize,
			};
		}

		// Convert to output format (TOON by default, JSON if requested)
		const useToon = options.outputFormat !== 'json';
		const content = await toOutputString(result, useToon);

		return {
			content,
			rawResponsePath,
		};
	} catch (error) {
		throw handleControllerError(error, {
			entityType: 'API',
			operation: 'attach',
			source: 'controllers/atlassian.api.controller.ts@handleAttach',
			additionalInfo: {
				pageId: options.pageId,
				filePath: options.filePath,
			},
		});
	}
}
