import { describe, expect, test } from '@jest/globals';
import { z } from 'zod';
import {
	RequestWithBodyArgs,
	PostApiToolArgs,
	PutApiToolArgs,
	PatchApiToolArgs,
} from './atlassian.api.types.js';

describe('atlassian.api.types', () => {
	describe('RequestWithBodyArgs body field', () => {
		test('accepts a plain object body unchanged', () => {
			const input = { path: '/x', body: { a: 1 } };
			const result = RequestWithBodyArgs.safeParse(input);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.body).toEqual(input.body);
			}
		});

		test('parses a JSON-encoded string body into an object', () => {
			const result = RequestWithBodyArgs.safeParse({
				path: '/x',
				body: '{"spaceId":"1"}',
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.body).toEqual({ spaceId: '1' });
			}
		});

		test('rejects a malformed JSON string with the record error', () => {
			const result = RequestWithBodyArgs.safeParse({
				path: '/x',
				body: '{not json',
			});
			expect(result.success).toBe(false);
			if (!result.success) {
				const issue = result.error.issues.find(
					(i) => i.path.join('.') === 'body',
				);
				expect(issue).toBeDefined();
				expect(issue?.message).toContain(
					'expected record, received string',
				);
			}
		});

		test('rejects a JSON array string', () => {
			const result = RequestWithBodyArgs.safeParse({
				path: '/x',
				body: '[1,2]',
			});
			expect(result.success).toBe(false);
			if (!result.success) {
				const issue = result.error.issues.find(
					(i) => i.path.join('.') === 'body',
				);
				expect(issue?.message).toContain('received array');
			}
		});

		test('rejects a missing body', () => {
			const result = RequestWithBodyArgs.safeParse({ path: '/x' });
			expect(result.success).toBe(false);
		});

		test('PostApiToolArgs, PutApiToolArgs, PatchApiToolArgs alias RequestWithBodyArgs', () => {
			expect(PostApiToolArgs).toBe(RequestWithBodyArgs);
			expect(PutApiToolArgs).toBe(RequestWithBodyArgs);
			expect(PatchApiToolArgs).toBe(RequestWithBodyArgs);
		});

		test('description survives on the preprocess pipe', () => {
			expect(RequestWithBodyArgs.shape.body.description).toBe(
				'Request body as a JSON object. Structure depends on the endpoint. Example for page: {"spaceId": "123", "title": "Page Title", "body": {"representation": "storage", "value": "<p>Content</p>"}} (a JSON-encoded string is also accepted).',
			);
		});

		test('advertised (input) JSON schema still describes body as an object', () => {
			// zod >=4.5 returns a generic ZodStandardJSONSchemaPayload whose
			// `properties` is Record<string, JSONSchema>, so a direct cast to
			// the narrowed shape no longer overlaps; the runtime assertion
			// below is what this test actually guards.
			const schema = z.toJSONSchema(RequestWithBodyArgs, {
				io: 'input',
			}) as unknown as {
				properties: { body: { type: string } };
			};
			expect(schema.properties.body.type).toBe('object');
		});
	});
});
