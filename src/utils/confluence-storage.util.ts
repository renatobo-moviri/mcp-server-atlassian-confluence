import { Logger } from './logger.util.js';

const logger = Logger.forContext('utils/confluence-storage.util.ts');

/**
 * Pattern to match Confluence attachment download URLs.
 * Captures the filename from the URL path.
 *
 * Matches URLs like:
 * - https://site.atlassian.net/wiki/download/attachments/12345/filename.png
 * - https://site.atlassian.net/wiki/download/thumbnails/12345/filename.png
 * - /wiki/download/attachments/12345/filename.png (relative)
 *
 * The filename may be URL-encoded and may include query parameters (e.g., ?version=1).
 */
const CONFLUENCE_ATTACHMENT_URL_RE =
	/(?:https?:\/\/[^/]+)?\/wiki\/download\/(?:attachments|thumbnails)\/\d+\/([^?"'\s]+)/;

/**
 * Pattern to match <img> tags that reference Confluence attachment URLs.
 * Captures the full tag for replacement. The attribute capture is lazy and
 * explicitly excludes a trailing self-closing slash (matched separately by
 * the optional `\/?`), so a no-space self-closing form like `.../a.png/>`
 * does not have the slash swallowed into the last attribute's value.
 */
const IMG_TAG_RE = /<img\b([^>]*?)\/?>(?:<\/img>)?/gi;

/**
 * Pattern to extract a named attribute value from an HTML tag's attribute string.
 */
function getAttr(attrs: string, name: string): string | null {
	// Match both single and double quoted attribute values, and unquoted values
	const re = new RegExp(
		`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|(\\S+))`,
		'i',
	);
	const m = re.exec(attrs);
	if (!m) return null;
	return m[1] ?? m[2] ?? m[3] ?? null;
}

/**
 * Escape a string for safe inclusion inside a double-quoted XML attribute
 * value. `&` must be escaped first so the entities produced for the other
 * characters are not themselves re-escaped.
 */
function escapeXmlAttr(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

/**
 * Convert a single <img> tag pointing to a Confluence attachment URL
 * into a Confluence storage format <ac:image> macro.
 *
 * @param imgTag - The full <img ...> tag string
 * @param attrs - The attribute string inside the tag
 * @returns The <ac:image> macro string, or null if the img is not a Confluence attachment
 */
function convertImgToAcImage(_imgTag: string, attrs: string): string | null {
	const src = getAttr(attrs, 'src');
	if (!src) return null;

	const urlMatch = CONFLUENCE_ATTACHMENT_URL_RE.exec(src);
	if (!urlMatch) return null;

	// Decode the filename (may be URL-encoded). Decode first, then escape,
	// so an already-encoded entity in the URL is not double-escaped. A
	// malformed percent sequence throws a URIError; leave the tag untouched
	// rather than let it break the whole replace pass.
	let decodedFilename: string;
	try {
		decodedFilename = decodeURIComponent(urlMatch[1]);
	} catch {
		return null;
	}
	const filename = escapeXmlAttr(decodedFilename);

	// Build <ac:image> attributes from width/height if present
	const acAttrs: string[] = [];
	const width = getAttr(attrs, 'width');
	const height = getAttr(attrs, 'height');
	if (width) acAttrs.push(` ac:width="${escapeXmlAttr(width)}"`);
	if (height) acAttrs.push(` ac:height="${escapeXmlAttr(height)}"`);

	return `<ac:image${acAttrs.join('')}><ri:attachment ri:filename="${filename}"/></ac:image>`;
}

/**
 * Convert all <img> tags in a storage format string that point to Confluence
 * attachment URLs back to <ac:image> macros.
 *
 * Tags that don't reference Confluence attachment URLs are left unchanged.
 *
 * @param storageValue - The storage format HTML string
 * @returns The string with Confluence attachment <img> tags converted to <ac:image> macros
 */
export function restoreAcImageMacros(storageValue: string): string {
	if (!storageValue || typeof storageValue !== 'string') {
		return storageValue;
	}

	// Quick check: if no <img is present, skip the regex work
	if (!storageValue.includes('<img')) {
		return storageValue;
	}

	let converted = 0;
	const result = storageValue.replace(IMG_TAG_RE, (match, attrs: string) => {
		const replacement = convertImgToAcImage(match, attrs);
		if (replacement) {
			converted++;
			return replacement;
		}
		return match; // Not a Confluence attachment img, leave it alone
	});

	if (converted > 0) {
		logger.info(
			`Restored ${converted} <img> tag(s) to <ac:image> macro(s) for storage format compatibility`,
		);
	}

	return result;
}

/**
 * Pre-process a request body for Confluence page/blogpost write operations.
 *
 * When the body contains storage format content with <img> tags pointing to
 * Confluence attachment URLs, automatically converts them back to <ac:image>
 * macros. This fixes round-trip editing where a page was read with rendered
 * HTML (body-format=view) but written back as storage format.
 *
 * @param body - The request body object (mutated in place if conversion occurs)
 * @returns The same body object, with storage format content fixed if needed
 */
export function preprocessStorageBody(
	body: Record<string, unknown>,
): Record<string, unknown> {
	if (!body) return body;

	// Check for the standard Confluence v2 API page/blogpost body structure:
	// { "body": { "representation": "storage", "value": "..." } }
	const bodyField = body.body as Record<string, unknown> | undefined;
	if (
		bodyField &&
		typeof bodyField === 'object' &&
		bodyField.representation === 'storage' &&
		typeof bodyField.value === 'string'
	) {
		const original = bodyField.value as string;
		const fixed = restoreAcImageMacros(original);
		if (fixed !== original) {
			bodyField.value = fixed;
		}
	}

	return body;
}
