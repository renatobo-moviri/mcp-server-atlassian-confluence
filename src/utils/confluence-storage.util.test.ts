import { describe, expect, test } from '@jest/globals';
import {
	restoreAcImageMacros,
	preprocessStorageBody,
	findUnresolvableAttachmentRefs,
	findUnresolvableAttachmentRefsInBody,
} from './confluence-storage.util.js';

describe('confluence-storage.util', () => {
	describe('restoreAcImageMacros', () => {
		test('converts img with Confluence attachment URL to ac:image', () => {
			const input =
				'<img alt="diagram.png" src="https://mysite.atlassian.net/wiki/download/attachments/12345/diagram.png" width="800"/>';
			const expected =
				'<ac:image ac:width="800"><ri:attachment ri:filename="diagram.png"/></ac:image>';
			expect(restoreAcImageMacros(input)).toBe(expected);
		});

		test('preserves width and height attributes', () => {
			const input =
				'<img src="https://site.atlassian.net/wiki/download/attachments/99/photo.jpg" width="640" height="480"/>';
			const expected =
				'<ac:image ac:width="640" ac:height="480"><ri:attachment ri:filename="photo.jpg"/></ac:image>';
			expect(restoreAcImageMacros(input)).toBe(expected);
		});

		test('handles img with no width/height', () => {
			const input =
				'<img src="https://site.atlassian.net/wiki/download/attachments/1/file.png"/>';
			const expected =
				'<ac:image><ri:attachment ri:filename="file.png"/></ac:image>';
			expect(restoreAcImageMacros(input)).toBe(expected);
		});

		test('handles thumbnail URLs', () => {
			const input =
				'<img src="https://site.atlassian.net/wiki/download/thumbnails/12345/thumb.png" width="200"/>';
			const expected =
				'<ac:image ac:width="200"><ri:attachment ri:filename="thumb.png"/></ac:image>';
			expect(restoreAcImageMacros(input)).toBe(expected);
		});

		test('handles URL-encoded filenames', () => {
			const input =
				'<img src="https://site.atlassian.net/wiki/download/attachments/1/my%20file%20(1).png"/>';
			const expected =
				'<ac:image><ri:attachment ri:filename="my file (1).png"/></ac:image>';
			expect(restoreAcImageMacros(input)).toBe(expected);
		});

		test('converts multiple img tags in content', () => {
			const input = `<p>Text before</p>
<img src="https://site.atlassian.net/wiki/download/attachments/1/a.png" width="400"/>
<p>Text between</p>
<img src="https://site.atlassian.net/wiki/download/attachments/1/b.png" width="600"/>
<p>Text after</p>`;
			const result = restoreAcImageMacros(input);
			expect(result).toContain(
				'<ac:image ac:width="400"><ri:attachment ri:filename="a.png"/></ac:image>',
			);
			expect(result).toContain(
				'<ac:image ac:width="600"><ri:attachment ri:filename="b.png"/></ac:image>',
			);
			expect(result).toContain('<p>Text before</p>');
			expect(result).toContain('<p>Text between</p>');
			expect(result).toContain('<p>Text after</p>');
		});

		test('leaves non-Confluence img tags unchanged', () => {
			const input =
				'<img src="https://example.com/image.png" width="100"/>';
			expect(restoreAcImageMacros(input)).toBe(input);
		});

		test('leaves already-correct ac:image macros unchanged', () => {
			const input =
				'<ac:image ac:width="800"><ri:attachment ri:filename="diagram.png"/></ac:image>';
			expect(restoreAcImageMacros(input)).toBe(input);
		});

		test('handles mixed ac:image and img tags', () => {
			const input = `<ac:image ac:width="400"><ri:attachment ri:filename="existing.png"/></ac:image>
<img src="https://site.atlassian.net/wiki/download/attachments/1/converted.png" width="600"/>
<img src="https://external.com/logo.png"/>`;
			const result = restoreAcImageMacros(input);
			// ac:image preserved
			expect(result).toContain(
				'<ac:image ac:width="400"><ri:attachment ri:filename="existing.png"/></ac:image>',
			);
			// Confluence img converted
			expect(result).toContain(
				'<ac:image ac:width="600"><ri:attachment ri:filename="converted.png"/></ac:image>',
			);
			// External img left alone
			expect(result).toContain(
				'<img src="https://external.com/logo.png"/>',
			);
		});

		test('returns empty/falsy values as-is', () => {
			expect(restoreAcImageMacros('')).toBe('');
			expect(restoreAcImageMacros(null as unknown as string)).toBe(null);
			expect(restoreAcImageMacros(undefined as unknown as string)).toBe(
				undefined,
			);
		});

		test('returns string without img tags unchanged', () => {
			const input =
				'<p>Hello <strong>world</strong></p><ac:structured-macro ac:name="code"/>';
			expect(restoreAcImageMacros(input)).toBe(input);
		});

		test('handles img tag with closing tag', () => {
			const input =
				'<img src="https://site.atlassian.net/wiki/download/attachments/1/file.png" width="300"></img>';
			const expected =
				'<ac:image ac:width="300"><ri:attachment ri:filename="file.png"/></ac:image>';
			expect(restoreAcImageMacros(input)).toBe(expected);
		});

		test('handles single-quoted attributes', () => {
			const input =
				"<img src='https://site.atlassian.net/wiki/download/attachments/1/file.png' width='300'/>";
			const expected =
				'<ac:image ac:width="300"><ri:attachment ri:filename="file.png"/></ac:image>';
			expect(restoreAcImageMacros(input)).toBe(expected);
		});

		test('escapes an ampersand decoded from the filename', () => {
			const input =
				'<img src="https://site.atlassian.net/wiki/download/attachments/1/Q%26A.png"/>';
			const expected =
				'<ac:image><ri:attachment ri:filename="Q&amp;A.png"/></ac:image>';
			expect(restoreAcImageMacros(input)).toBe(expected);
		});

		test('escapes a double quote decoded from the filename', () => {
			const input =
				'<img src="https://site.atlassian.net/wiki/download/attachments/1/a%22b.png"/>';
			const expected =
				'<ac:image><ri:attachment ri:filename="a&quot;b.png"/></ac:image>';
			expect(restoreAcImageMacros(input)).toBe(expected);
		});

		test('escapes angle brackets decoded from the filename', () => {
			const input =
				'<img src="https://site.atlassian.net/wiki/download/attachments/1/x%3Cy%3E.png"/>';
			const expected =
				'<ac:image><ri:attachment ri:filename="x&lt;y&gt;.png"/></ac:image>';
			expect(restoreAcImageMacros(input)).toBe(expected);
		});

		test('escapes a literal (unencoded) ampersand in the filename exactly once', () => {
			const input =
				'<img src="https://site.atlassian.net/wiki/download/attachments/1/Q&A.png"/>';
			const expected =
				'<ac:image><ri:attachment ri:filename="Q&amp;A.png"/></ac:image>';
			expect(restoreAcImageMacros(input)).toBe(expected);
		});

		test('escapes a quote in a single-quoted width attribute', () => {
			const input =
				'<img src="https://site.atlassian.net/wiki/download/attachments/1/file.png" width=\'10"\'/>';
			const expected =
				'<ac:image ac:width="10&quot;"><ri:attachment ri:filename="file.png"/></ac:image>';
			expect(restoreAcImageMacros(input)).toBe(expected);
		});

		test('leaves the <img> tag untouched when the filename is a malformed percent-encoded sequence', () => {
			const input =
				'<img src="https://site.atlassian.net/wiki/download/attachments/1/%E0%A4%A.png"/>';
			expect(restoreAcImageMacros(input)).toBe(input);
		});

		test('converts the no-space self-closing form (regression: trailing slash previously captured into the filename)', () => {
			const input = '<img src=/wiki/download/attachments/1/a.png/>';
			const expected =
				'<ac:image><ri:attachment ri:filename="a.png"/></ac:image>';
			expect(restoreAcImageMacros(input)).toBe(expected);
		});

		test('converts the space-before-slash self-closing form (guards the already-working case)', () => {
			const input = '<img src=/wiki/download/attachments/1/a.png />';
			const expected =
				'<ac:image><ri:attachment ri:filename="a.png"/></ac:image>';
			expect(restoreAcImageMacros(input)).toBe(expected);
		});

		test('handles an unquoted width value before a no-space self-closing slash', () => {
			const input =
				'<img src=/wiki/download/attachments/1/a.png width=300/>';
			const expected =
				'<ac:image ac:width="300"><ri:attachment ri:filename="a.png"/></ac:image>';
			expect(restoreAcImageMacros(input)).toBe(expected);
		});
	});

	describe('preprocessStorageBody', () => {
		test('converts img tags in storage body', () => {
			const body = {
				id: '123',
				title: 'Test Page',
				body: {
					representation: 'storage',
					value: '<p><img src="https://site.atlassian.net/wiki/download/attachments/123/pic.png" width="500"/></p>',
				},
				version: { number: 2 },
			};
			preprocessStorageBody(body);
			expect((body.body as Record<string, unknown>).value).toBe(
				'<p><ac:image ac:width="500"><ri:attachment ri:filename="pic.png"/></ac:image></p>',
			);
		});

		test('does not modify non-storage representation', () => {
			const value =
				'<p><img src="https://site.atlassian.net/wiki/download/attachments/123/pic.png"/></p>';
			const body = {
				body: {
					representation: 'atlas_doc_format',
					value,
				},
			};
			preprocessStorageBody(body);
			expect((body.body as Record<string, unknown>).value).toBe(value);
		});

		test('does not modify body without representation field', () => {
			const body = {
				body: {
					value: '<img src="https://site.atlassian.net/wiki/download/attachments/1/x.png"/>',
				},
			};
			preprocessStorageBody(body);
			expect((body.body as Record<string, unknown>).value).toBe(
				'<img src="https://site.atlassian.net/wiki/download/attachments/1/x.png"/>',
			);
		});

		test('handles body without body field', () => {
			const body = { title: 'No body field' };
			expect(preprocessStorageBody(body)).toEqual({
				title: 'No body field',
			});
		});

		test('handles null/undefined body', () => {
			expect(
				preprocessStorageBody(
					null as unknown as Record<string, unknown>,
				),
			).toBe(null);
		});

		test('leaves storage body without img tags unchanged', () => {
			const value =
				'<p>Hello</p><ac:image ac:width="800"><ri:attachment ri:filename="pic.png"/></ac:image>';
			const body = {
				body: {
					representation: 'storage',
					value,
				},
			};
			preprocessStorageBody(body);
			expect((body.body as Record<string, unknown>).value).toBe(value);
		});
	});
	describe('findUnresolvableAttachmentRefs', () => {
		const names = (v: string) =>
			findUnresolvableAttachmentRefs(v).map((r) => r.filename);

		test('flags a filename cut short by an unescaped double quote', () => {
			const input =
				'<p><ac:image><ri:attachment ri:filename="a"b.png"/></ac:image></p>';
			expect(findUnresolvableAttachmentRefs(input)).toEqual([
				{ filename: 'a"b.png', kind: 'truncated' },
			]);
		});

		test('flags a quote escaped as &quot;', () => {
			const input =
				'<p><ac:image><ri:attachment ri:filename="a&quot;b.png"/></ac:image></p>';
			expect(findUnresolvableAttachmentRefs(input)).toEqual([
				{ filename: 'a"b.png', kind: 'contains-quote' },
			]);
		});

		test('flags the numeric entity forms &#34; and &#x22;', () => {
			expect(names('<ri:attachment ri:filename="a&#34;b.png"/>')).toEqual(
				['a"b.png'],
			);
			expect(
				names('<ri:attachment ri:filename="c&#x22;d.png"/>'),
			).toEqual(['c"d.png']);
		});

		test('flags a raw quote inside a single-quoted attribute', () => {
			expect(names(`<ri:attachment ri:filename='a"b.png'/>`)).toEqual([
				'a"b.png',
			]);
		});

		test('flags only the bad reference when several are present', () => {
			const input =
				'<ri:attachment ri:filename="good.png"/>' +
				'<ri:attachment ri:filename="a&quot;b.png"/>' +
				'<ri:attachment ri:filename="also good.png"/>';
			expect(names(input)).toEqual(['a"b.png']);
		});

		test('de-duplicates a filename referenced twice', () => {
			const input =
				'<ri:attachment ri:filename="a&quot;b.png"/>' +
				'<ri:attachment ri:filename="a&quot;b.png"/>';
			expect(names(input)).toEqual(['a"b.png']);
		});

		test('accepts names that are merely awkward', () => {
			for (const name of [
				'my file (1).png',
				'café.png',
				'a&amp;b.png',
				'x&lt;y&gt;.png',
				'it&apos;s.png',
			]) {
				expect(names(`<ri:attachment ri:filename="${name}"/>`)).toEqual(
					[],
				);
			}
		});

		test('accepts well-formed closings: /> and > and a following attribute', () => {
			expect(names('<ri:attachment ri:filename="a.png"/>')).toEqual([]);
			expect(
				names('<ri:attachment ri:filename="a.png"></ri:attachment>'),
			).toEqual([]);
			expect(
				names('<ri:attachment ri:filename="a.png" ri:version="1"/>'),
			).toEqual([]);
		});

		test('returns nothing for bodies with no attachment reference', () => {
			expect(findUnresolvableAttachmentRefs('<p>hello</p>')).toEqual([]);
			expect(findUnresolvableAttachmentRefs('')).toEqual([]);
			expect(
				findUnresolvableAttachmentRefs(null as unknown as string),
			).toEqual([]);
		});

		test('catches an img src whose encoded name decodes to a quote', () => {
			// escapeXmlAttr makes this well-formed, but it still cannot resolve
			const converted = restoreAcImageMacros(
				'<p><img src="/wiki/download/attachments/1/a%22b.png"/></p>',
			);
			expect(converted).toContain('ri:filename="a&quot;b.png"');
			expect(names(converted)).toEqual(['a"b.png']);
		});
	});

	describe('findUnresolvableAttachmentRefsInBody', () => {
		test('inspects a storage body', () => {
			const body = {
				body: {
					representation: 'storage',
					value: '<ri:attachment ri:filename="a&quot;b.png"/>',
				},
			};
			expect(
				findUnresolvableAttachmentRefsInBody(body).map(
					(r) => r.filename,
				),
			).toEqual(['a"b.png']);
		});

		test('ignores a non-storage body', () => {
			const body = {
				body: {
					representation: 'atlas_doc_format',
					value: '<ri:attachment ri:filename="a&quot;b.png"/>',
				},
			};
			expect(findUnresolvableAttachmentRefsInBody(body)).toEqual([]);
		});

		test('ignores a body with no body field', () => {
			expect(
				findUnresolvableAttachmentRefsInBody({ title: 'x' }),
			).toEqual([]);
		});
	});
});
