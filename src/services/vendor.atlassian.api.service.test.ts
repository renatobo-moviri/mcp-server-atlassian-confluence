import { jest } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { uploadAttachment } from './vendor.atlassian.api.service.js';
import { McpError } from '../utils/error.util.js';

/**
 * Tests for the attachment upload service logic.
 *
 * These run entirely against a mocked global fetch and a temporary local file;
 * no live Confluence credentials or network access are required. Credentials
 * are injected via process.env so validateCredentials() succeeds.
 */
describe('uploadAttachment', () => {
	let originalFetch: typeof global.fetch;
	let originalEnv: {
		siteName?: string;
		userEmail?: string;
		apiToken?: string;
	};
	let tempFilePath: string;

	const buildOkResponse = (body: unknown) => ({
		ok: true,
		status: 200,
		statusText: 'OK',
		headers: new Headers(),
		text: async () => JSON.stringify(body),
	});

	beforeAll(() => {
		// Write a tiny temp file to upload
		tempFilePath = path.join(
			os.tmpdir(),
			`conf-attach-test-${Date.now()}.png`,
		);
		fs.writeFileSync(tempFilePath, Buffer.from('fake-png-bytes'));
	});

	afterAll(() => {
		try {
			fs.unlinkSync(tempFilePath);
		} catch {
			// ignore cleanup errors
		}
	});

	beforeEach(() => {
		originalFetch = global.fetch;
		originalEnv = {
			siteName: process.env.ATLASSIAN_SITE_NAME,
			userEmail: process.env.ATLASSIAN_USER_EMAIL,
			apiToken: process.env.ATLASSIAN_API_TOKEN,
		};
		process.env.ATLASSIAN_SITE_NAME = 'example';
		process.env.ATLASSIAN_USER_EMAIL = 'user@example.com';
		process.env.ATLASSIAN_API_TOKEN = 'test-token';
	});

	afterEach(() => {
		global.fetch = originalFetch;
		process.env.ATLASSIAN_SITE_NAME = originalEnv.siteName;
		process.env.ATLASSIAN_USER_EMAIL = originalEnv.userEmail;
		process.env.ATLASSIAN_API_TOKEN = originalEnv.apiToken;
	});

	it('should create a new attachment when none exists (routes to the create endpoint)', async () => {
		const fetchMock = jest
			.fn<typeof fetch>()
			// 1) existence check -> no results
			.mockResolvedValueOnce(buildOkResponse({ results: [] }) as Response)
			// 2) upload -> create endpoint returns { results: [...] }
			.mockResolvedValueOnce(
				buildOkResponse({
					results: [
						{
							id: 'att-new',
							title: 'diagram.png',
							extensions: { fileSize: 1234 },
						},
					],
				}) as Response,
			);
		global.fetch = fetchMock as unknown as typeof fetch;

		const result = await uploadAttachment('page-1', tempFilePath);

		expect(result.status).toBe('created');
		expect(result.attachment).toMatchObject({ id: 'att-new' });

		// Second call is the upload; assert it hit the create endpoint (no /data)
		const uploadUrl = fetchMock.mock.calls[1][0] as string;
		expect(uploadUrl).toContain('/child/attachment');
		expect(uploadUrl).not.toContain('/data');
	});

	it('should update an existing attachment (routes to the /data endpoint)', async () => {
		const fetchMock = jest
			.fn<typeof fetch>()
			// 1) existence check -> one result
			.mockResolvedValueOnce(
				buildOkResponse({
					results: [{ id: 'att-existing' }],
				}) as Response,
			)
			// 2) upload -> update endpoint returns the attachment object directly
			.mockResolvedValueOnce(
				buildOkResponse({
					id: 'att-existing',
					title: 'diagram.png',
					extensions: { fileSize: 5678 },
				}) as Response,
			);
		global.fetch = fetchMock as unknown as typeof fetch;

		const result = await uploadAttachment('page-1', tempFilePath, 'v2');

		expect(result.status).toBe('updated');
		expect(result.attachment).toMatchObject({ id: 'att-existing' });

		const uploadUrl = fetchMock.mock.calls[1][0] as string;
		expect(uploadUrl).toContain('/child/attachment/att-existing/data');
	});

	it('should send the X-Atlassian-Token: nocheck header on upload', async () => {
		const fetchMock = jest
			.fn<typeof fetch>()
			.mockResolvedValueOnce(buildOkResponse({ results: [] }) as Response)
			.mockResolvedValueOnce(
				buildOkResponse({ results: [{ id: 'att-new' }] }) as Response,
			);
		global.fetch = fetchMock as unknown as typeof fetch;

		await uploadAttachment('page-1', tempFilePath);

		const uploadInit = fetchMock.mock.calls[1][1] as RequestInit;
		const headers = uploadInit.headers as Record<string, string>;
		expect(headers['X-Atlassian-Token']).toBe('nocheck');
		// FormData body -> no Content-Type set by us
		expect(headers['Content-Type']).toBeUndefined();
		expect(uploadInit.body).toBeInstanceOf(FormData);
	});

	it('should throw an McpError before any network call when the file is missing', async () => {
		const fetchMock = jest.fn<typeof fetch>();
		global.fetch = fetchMock as unknown as typeof fetch;

		const missingPath = path.join(
			os.tmpdir(),
			`conf-attach-missing-${Date.now()}.png`,
		);

		await expect(
			uploadAttachment('page-1', missingPath),
		).rejects.toBeInstanceOf(McpError);

		// No fetch should have been performed
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
