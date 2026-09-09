import {
	createApiError,
	createNotFoundError,
	getDeepOriginalError,
} from './error.util.js';
import { Logger } from './logger.util.js';

/**
 * Standard error codes for consistent handling
 */
export enum ErrorCode {
	NOT_FOUND = 'NOT_FOUND',
	INVALID_CURSOR = 'INVALID_CURSOR',
	ACCESS_DENIED = 'ACCESS_DENIED',
	VALIDATION_ERROR = 'VALIDATION_ERROR',
	UNEXPECTED_ERROR = 'UNEXPECTED_ERROR',
	NETWORK_ERROR = 'NETWORK_ERROR',
	RATE_LIMIT_ERROR = 'RATE_LIMIT_ERROR',
	CONFLUENCE_CQL_ERROR = 'CONFLUENCE_CQL_ERROR',
	CONFLUENCE_CONTENT_ERROR = 'CONFLUENCE_CONTENT_ERROR',
}

/**
 * Context information for error handling
 */
export interface ErrorContext {
	/**
	 * Source of the error (e.g., file path and function)
	 */
	source?: string;

	/**
	 * Type of entity being processed (e.g., 'Space', 'Page')
	 */
	entityType?: string;

	/**
	 * Identifier of the entity being processed
	 */
	entityId?: string | Record<string, string>;

	/**
	 * Operation being performed (e.g., 'listing', 'creating')
	 */
	operation?: string;

	/**
	 * Additional information for debugging
	 */
	additionalInfo?: Record<string, unknown>;
}

/**
 * Helper function to create a consistent error context object
 * @param entityType Type of entity being processed
 * @param operation Operation being performed
 * @param source Source of the error (typically file path and function)
 * @param entityId Optional identifier of the entity
 * @param additionalInfo Optional additional information for debugging
 * @returns A formatted ErrorContext object
 */
export function buildErrorContext(
	entityType: string,
	operation: string,
	source: string,
	entityId?: string | Record<string, string>,
	additionalInfo?: Record<string, unknown>,
): ErrorContext {
	return {
		entityType,
		operation,
		source,
		...(entityId && { entityId }),
		...(additionalInfo && { additionalInfo }),
	};
}

/**
 * Detect specific error types from raw errors
 * @param error The error to analyze
 * @param context Context information for better error detection
 * @returns Object containing the error code and status code
 */
export function detectErrorType(
	error: unknown,
	context: ErrorContext = {},
): { code: ErrorCode; statusCode: number } {
	const methodLogger = Logger.forContext(
		'utils/error-handler.util.ts',
		'detectErrorType',
	);
	methodLogger.debug(`Detecting error type`, { error, context });

	const errorMessage = error instanceof Error ? error.message : String(error);
	const statusCode =
		error instanceof Error && 'statusCode' in error
			? (error as { statusCode: number }).statusCode
			: undefined;

	// Network error detection
	if (
		errorMessage.includes('network error') ||
		errorMessage.includes('fetch failed') ||
		errorMessage.includes('ECONNREFUSED') ||
		errorMessage.includes('ENOTFOUND') ||
		errorMessage.includes('Failed to fetch') ||
		errorMessage.includes('Network request failed')
	) {
		return { code: ErrorCode.NETWORK_ERROR, statusCode: 500 };
	}

	// Rate limiting detection
	if (
		errorMessage.includes('rate limit') ||
		errorMessage.includes('too many requests') ||
		statusCode === 429
	) {
		return { code: ErrorCode.RATE_LIMIT_ERROR, statusCode: 429 };
	}

	// Confluence-specific error detection
	if (
		error instanceof Error &&
		'originalError' in error &&
		error.originalError
	) {
		const originalError = getDeepOriginalError(error.originalError);

		if (originalError && typeof originalError === 'object') {
			const oe = originalError as Record<string, unknown>;

			// Confluence API error with title/detail structure
			if (oe.title || oe.detail) {
				methodLogger.debug(
					'Found Confluence title/detail error structure',
					oe,
				);

				const title = oe.title ? String(oe.title).toLowerCase() : '';
				const detail = oe.detail ? String(oe.detail).toLowerCase() : '';
				const status =
					typeof oe.status === 'number' ? oe.status : undefined;

				// Not Found errors
				if (
					title.includes('not found') ||
					detail.includes('not found') ||
					title.includes('does not exist') ||
					detail.includes('does not exist') ||
					status === 404
				) {
					return { code: ErrorCode.NOT_FOUND, statusCode: 404 };
				}

				// Access/Permission errors
				if (
					title.includes('permission') ||
					detail.includes('permission') ||
					title.includes('access') ||
					detail.includes('access') ||
					title.includes('unauthorized') ||
					detail.includes('unauthorized') ||
					status === 401 ||
					status === 403
				) {
					return {
						code: ErrorCode.ACCESS_DENIED,
						statusCode: status || 403,
					};
				}

				// Validation errors
				if (
					title.includes('invalid') ||
					detail.includes('invalid') ||
					title.includes('validation') ||
					detail.includes('validation') ||
					status === 400 ||
					status === 422
				) {
					return {
						code: ErrorCode.VALIDATION_ERROR,
						statusCode: status || 400,
					};
				}

				// Rate limit errors
				if (
					title.includes('rate limit') ||
					detail.includes('rate limit') ||
					status === 429
				) {
					return {
						code: ErrorCode.RATE_LIMIT_ERROR,
						statusCode: 429,
					};
				}
			}

			// Check for errors array format
			if (Array.isArray(oe.errors) && oe.errors.length > 0) {
				methodLogger.debug(
					'Found Confluence errors array structure',
					oe.errors,
				);

				const firstError = oe.errors[0] as Record<string, unknown>;
				const errorMsg = firstError.message
					? String(firstError.message).toLowerCase()
					: '';
				const errorTitle = firstError.title
					? String(firstError.title).toLowerCase()
					: '';
				const errorStatus =
					typeof firstError.status === 'number'
						? firstError.status
						: undefined;

				// CQL syntax errors for search
				if (
					errorMsg.includes('cql') ||
					errorMsg.includes('query syntax') ||
					errorTitle.includes('cql') ||
					errorTitle.includes('query syntax')
				) {
					return {
						code: ErrorCode.CONFLUENCE_CQL_ERROR,
						statusCode: 400,
					};
				}

				// Not found errors
				if (
					errorMsg.includes('not found') ||
					errorTitle.includes('not found') ||
					errorStatus === 404
				) {
					return { code: ErrorCode.NOT_FOUND, statusCode: 404 };
				}

				// Access/Permission errors
				if (
					errorMsg.includes('permission') ||
					errorTitle.includes('permission') ||
					errorMsg.includes('access') ||
					errorTitle.includes('access') ||
					errorStatus === 401 ||
					errorStatus === 403
				) {
					return {
						code: ErrorCode.ACCESS_DENIED,
						statusCode: errorStatus || 403,
					};
				}

				// Content errors (like trying to access a draft or trashed content)
				if (
					errorMsg.includes('content') ||
					errorTitle.includes('content')
				) {
					return {
						code: ErrorCode.CONFLUENCE_CONTENT_ERROR,
						statusCode: errorStatus || 400,
					};
				}
			}

			// Check for message field (common in some Confluence errors)
			if (oe.message) {
				const errorMsg = String(oe.message).toLowerCase();

				if (
					errorMsg.includes('not found') ||
					errorMsg.includes("doesn't exist")
				) {
					return { code: ErrorCode.NOT_FOUND, statusCode: 404 };
				}

				if (
					errorMsg.includes('permission') ||
					errorMsg.includes('authorized')
				) {
					return { code: ErrorCode.ACCESS_DENIED, statusCode: 403 };
				}

				if (errorMsg.includes('cql')) {
					return {
						code: ErrorCode.CONFLUENCE_CQL_ERROR,
						statusCode: 400,
					};
				}
			}
		}
	}

	// Not Found detection
	if (
		errorMessage.includes('not found') ||
		errorMessage.includes('does not exist') ||
		statusCode === 404
	) {
		return { code: ErrorCode.NOT_FOUND, statusCode: 404 };
	}

	// Access Denied detection
	if (
		errorMessage.includes('access') ||
		errorMessage.includes('permission') ||
		errorMessage.includes('authorize') ||
		errorMessage.includes('authentication') ||
		statusCode === 401 ||
		statusCode === 403
	) {
		return { code: ErrorCode.ACCESS_DENIED, statusCode: statusCode || 403 };
	}

	// Invalid Cursor detection
	if (
		(errorMessage.includes('cursor') ||
			errorMessage.includes('startAt') ||
			errorMessage.includes('page')) &&
		(errorMessage.includes('invalid') || errorMessage.includes('not valid'))
	) {
		return { code: ErrorCode.INVALID_CURSOR, statusCode: 400 };
	}

	// Validation Error detection
	if (
		errorMessage.includes('validation') ||
		errorMessage.includes('invalid') ||
		errorMessage.includes('required') ||
		statusCode === 400 ||
		statusCode === 422
	) {
		return {
			code: ErrorCode.VALIDATION_ERROR,
			statusCode: statusCode || 400,
		};
	}

	// Default to unexpected error
	return {
		code: ErrorCode.UNEXPECTED_ERROR,
		statusCode: statusCode || 500,
	};
}

/**
 * Create user-friendly error messages based on error type and context
 * @param code The error code
 * @param context Context information for better error messages
 * @param originalMessage The original error message
 * @returns User-friendly error message
 */
export function createUserFriendlyErrorMessage(
	code: ErrorCode,
	context: ErrorContext = {},
	originalMessage?: string,
): string {
	const methodLogger = Logger.forContext(
		'utils/error-handler.util.ts',
		'createUserFriendlyErrorMessage',
	);
	const { entityType, entityId, operation } = context;

	// Format entity ID for display
	let entityIdStr = '';
	if (entityId) {
		if (typeof entityId === 'string') {
			entityIdStr = entityId;
		} else {
			// Handle object entityId (like SpaceKey/PageId)
			entityIdStr = Object.values(entityId).join('/');
		}
	}

	// Determine entity display name
	const entity = entityType
		? `${entityType}${entityIdStr ? ` ${entityIdStr}` : ''}`
		: 'Resource';

	let message: string;

	switch (code) {
		case ErrorCode.NOT_FOUND:
			message = `${entity} not found${entityIdStr ? `: ${entityIdStr}` : ''}. Verify the ID is correct and that you have access to this ${entityType?.toLowerCase() || 'resource'}.`;

			// Confluence-specific guidance
			if (entityType === 'Space') {
				message += ` Make sure the space key is correct (including case sensitivity) and that it exists.`;
			} else if (entityType === 'Page' || entityType === 'Content') {
				message += ` Ensure the content ID is valid and that it hasn't been deleted or moved to trash.`;
			}
			break;

		case ErrorCode.ACCESS_DENIED:
			message = `Access denied for ${entity.toLowerCase()}${entityIdStr ? ` ${entityIdStr}` : ''}. Verify your credentials and permissions.`;

			// Confluence-specific guidance
			message += ` Ensure your Atlassian API token has sufficient privileges and that your Confluence user has access to this ${entityType?.toLowerCase() || 'resource'}.`;
			break;

		case ErrorCode.INVALID_CURSOR:
			message = `Invalid pagination cursor. Use the exact cursor string returned from previous results.`;
			break;

		case ErrorCode.VALIDATION_ERROR:
			message =
				originalMessage ||
				`Invalid data provided for ${operation || 'operation'} ${entity.toLowerCase()}.`;
			break;

		case ErrorCode.NETWORK_ERROR:
			message = `Network error while ${operation || 'connecting to'} the Confluence API. Please check your internet connection and try again.`;
			break;

		case ErrorCode.RATE_LIMIT_ERROR:
			message = `Confluence API rate limit exceeded. Please wait a moment and try again, or reduce the frequency of requests.`;
			break;

		case ErrorCode.CONFLUENCE_CQL_ERROR:
			message = `Invalid CQL syntax in search query. Please check your query syntax and try again.`;
			if (originalMessage) {
				message += ` Error details: ${originalMessage}`;
			}
			break;

		case ErrorCode.CONFLUENCE_CONTENT_ERROR:
			message = `Error accessing Confluence content. The content may be in an invalid state (draft, trashed, etc.).`;
			if (originalMessage) {
				message += ` Error details: ${originalMessage}`;
			}
			break;

		default:
			message = `An unexpected error occurred while ${operation || 'processing'} ${entity.toLowerCase()}.`;
	}

	// Include original message details if available and appropriate
	if (
		originalMessage &&
		code !== ErrorCode.NOT_FOUND &&
		code !== ErrorCode.ACCESS_DENIED &&
		code !== ErrorCode.CONFLUENCE_CQL_ERROR &&
		code !== ErrorCode.CONFLUENCE_CONTENT_ERROR
	) {
		message += ` Error details: ${originalMessage}`;
	}

	methodLogger.debug(`Created user-friendly message: ${message}`, {
		code,
		context,
	});
	return message;
}

/**
 * Handle controller errors consistently
 * @param error The error to handle
 * @param context Context information for better error messages
 * @returns Never returns, always throws an error
 */
export function handleControllerError(
	error: unknown,
	context: ErrorContext = {},
): never {
	const methodLogger = Logger.forContext(
		'utils/error-handler.util.ts',
		'handleControllerError',
	);

	// Extract error details
	const errorMessage = error instanceof Error ? error.message : String(error);
	const statusCode =
		error instanceof Error && 'statusCode' in error
			? (error as { statusCode: number }).statusCode
			: undefined;

	// Detect error type using utility
	const { code, statusCode: detectedStatus } = detectErrorType(
		error,
		context,
	);

	// Combine detected status with explicit status
	const finalStatusCode = statusCode || detectedStatus;

	// Format entity information for logging
	const { entityType, entityId, operation } = context;
	const entity = entityType || 'resource';
	const entityIdStr = entityId
		? typeof entityId === 'string'
			? entityId
			: JSON.stringify(entityId)
		: '';
	const actionStr = operation || 'processing';

	// Log detailed error information
	methodLogger.error(
		`Error ${actionStr} ${entity}${
			entityIdStr ? `: ${entityIdStr}` : ''
		}: ${errorMessage}`,
		error,
	);

	// Create user-friendly error message for the response
	const message =
		code === ErrorCode.VALIDATION_ERROR
			? errorMessage
			: createUserFriendlyErrorMessage(code, context, errorMessage);

	// Throw an appropriate error based on the detected error code
	if (code === ErrorCode.NOT_FOUND) {
		throw createNotFoundError(message, error);
	} else {
		throw createApiError(message, finalStatusCode, error);
	}
}
