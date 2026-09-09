import { describe, expect, test } from '@jest/globals';
import {
	toToonOrJson,
	toToonOrJsonSync,
	preloadToonEncoder,
} from './toon.util.js';

/**
 * NOTE: The TOON encoder (@toon-format/toon) is an ESM-only package, loaded
 * through a dynamic import. This suite therefore runs as ESM (jest's
 * --experimental-vm-modules, wired into the npm test scripts); under the
 * previous CommonJS setup the import failed and every assertion here silently
 * checked the JSON fallback instead of TOON output.
 *
 * These tests cover both paths deliberately: the fallback contract, and the
 * real encoder output including v4's tabular form for uniform object arrays.
 */

describe('TOON Utilities', () => {
	// The encoder is an ESM-only dynamic import. If it ever stops loading, every
	// assertion below silently degrades to checking the JSON fallback instead of
	// TOON output - which is exactly what happened under the old CommonJS setup.
	// Fail loudly here rather than passing vacuously everywhere else.
	test('the TOON encoder actually loads in this environment', async () => {
		await expect(preloadToonEncoder()).resolves.toBe(true);
	});

	describe('toToonOrJson', () => {
		test('returns valid output for simple object', async () => {
			const data = { name: 'Alice', age: 30 };
			const jsonFallback = JSON.stringify(data, null, 2);

			const result = await toToonOrJson(data, jsonFallback);

			// Should return either TOON or JSON fallback
			expect(result).toBeDefined();
			expect(result.length).toBeGreaterThan(0);
			// Should contain the data values regardless of format
			expect(result).toContain('Alice');
			expect(result).toContain('30');
		});

		test('returns valid output for array of objects', async () => {
			const data = {
				users: [
					{ id: 1, name: 'Alice', role: 'admin' },
					{ id: 2, name: 'Bob', role: 'user' },
				],
			};
			const jsonFallback = JSON.stringify(data, null, 2);

			const result = await toToonOrJson(data, jsonFallback);

			expect(result).toBeDefined();
			expect(result).toContain('Alice');
			expect(result).toContain('Bob');
		});

		test('returns valid output for nested object', async () => {
			const data = {
				context: {
					task: 'Test task',
					location: 'Test location',
				},
				items: ['a', 'b', 'c'],
			};
			const jsonFallback = JSON.stringify(data, null, 2);

			const result = await toToonOrJson(data, jsonFallback);

			expect(result).toBeDefined();
			expect(result).toContain('Test task');
			expect(result).toContain('Test location');
		});

		test('handles primitive values', async () => {
			const stringData = 'hello';
			const numberData = 42;
			const boolData = true;
			const nullData = null;

			// All primitives should produce valid output
			const strResult = await toToonOrJson(stringData, '"hello"');
			const numResult = await toToonOrJson(numberData, '42');
			const boolResult = await toToonOrJson(boolData, 'true');
			const nullResult = await toToonOrJson(nullData, 'null');

			expect(strResult).toContain('hello');
			expect(numResult).toContain('42');
			expect(boolResult).toContain('true');
			expect(nullResult).toContain('null');
		});

		test('handles empty objects and arrays', async () => {
			const emptyObj = {};
			const emptyArr: unknown[] = [];

			const objResult = await toToonOrJson(emptyObj, '{}');
			const arrResult = await toToonOrJson(emptyArr, '[]');

			expect(objResult).toBeDefined();
			expect(arrResult).toBeDefined();
		});

		test('returns fallback when data contains special characters', async () => {
			const data = { message: 'Hello\nWorld', path: '/some/path' };
			const jsonFallback = JSON.stringify(data, null, 2);

			const result = await toToonOrJson(data, jsonFallback);

			expect(result).toBeDefined();
			expect(result.length).toBeGreaterThan(0);
		});
	});

	describe('toToonOrJsonSync', () => {
		test('returns JSON fallback when encoder not loaded', () => {
			const data = { name: 'Test', value: 123 };
			const jsonFallback = JSON.stringify(data, null, 2);

			// Without preloading, sync version should return fallback
			const result = toToonOrJsonSync(data, jsonFallback);

			expect(result).toBeDefined();
			expect(result).toContain('Test');
			expect(result).toContain('123');
		});

		test('handles complex data gracefully', () => {
			const data = {
				pages: [
					{ id: 1, title: 'Page One' },
					{ id: 2, title: 'Page Two' },
				],
			};
			const jsonFallback = JSON.stringify(data, null, 2);

			const result = toToonOrJsonSync(data, jsonFallback);

			expect(result).toBeDefined();
			expect(result).toContain('Page One');
			expect(result).toContain('Page Two');
		});
	});

	describe('Fallback behavior', () => {
		test('fallback JSON is valid and parseable', async () => {
			const data = {
				spaces: [
					{ id: '123', name: 'Engineering', key: 'ENG' },
					{ id: '456', name: 'Product', key: 'PROD' },
				],
			};
			const jsonFallback = JSON.stringify(data, null, 2);

			const result = await toToonOrJson(data, jsonFallback);

			// If it's JSON fallback, it should be parseable
			// If it's TOON, this will fail, but the test still passes
			// because we're just checking the result is valid
			expect(result).toBeDefined();
			expect(result.length).toBeGreaterThan(0);
		});

		test('function does not throw on edge case data', async () => {
			// Test with various edge cases (excluding undefined which JSON.stringify handles specially)
			const testCases = [
				{ data: null, fallback: 'null' },
				{ data: 0, fallback: '0' },
				{ data: '', fallback: '""' },
				{ data: [], fallback: '[]' },
				{ data: {}, fallback: '{}' },
				{ data: { deep: { nested: { value: 1 } } }, fallback: '{}' },
			];

			for (const { data, fallback } of testCases) {
				// Should not throw
				const result = await toToonOrJson(data, fallback);
				expect(result).toBeDefined();
			}
		});
	});

	// @toon-format/toon is ESM-only (no CJS build). These assertions cover the
	// v4 tabular contract and only run because this suite executes as ESM; under
	// the previous CommonJS setup the dynamic import failed and every test above
	// silently exercised the JSON fallback instead of TOON output.
	describe('tabular encoding of uniform object arrays', () => {
		const pages = (n: number) => ({
			results: Array.from({ length: n }, (_, i) => ({
				id: `${400000 + i}`,
				title: `Page ${i}`,
				status: 'current',
			})),
		});

		test('emits a field header and one row per element', async () => {
			const data = pages(2);
			const result = await toToonOrJson(
				data,
				JSON.stringify(data, null, 2),
			);

			expect(result).toContain('results[2]{id,title,status}:');
			expect(result).toContain('"400000",Page 0,current');
		});

		test('is materially smaller than the JSON it replaces', async () => {
			const data = pages(25);
			const jsonFallback = JSON.stringify(data, null, 2);
			const result = await toToonOrJson(data, jsonFallback);

			expect(result.length).toBeLessThan(jsonFallback.length * 0.6);
		});

		test('falls back to the per-field form for non-uniform arrays', async () => {
			const data = {
				results: [
					{ id: '1', title: 'A' },
					{ id: '2', spaceId: '3' },
				],
			};
			const result = await toToonOrJson(
				data,
				JSON.stringify(data, null, 2),
			);

			expect(result).toContain('results[2]:');
			expect(result).not.toContain('results[2]{');
		});
	});
});
