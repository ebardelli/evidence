import { describe, expect, it } from 'vitest';
import { buildStorageBackendOptionsSchema } from './options.schema.js';
import { z } from 'zod';

describe('buildStorageBackendOptionsSchema', () => {
	it('accepts duckdb storage mode', () => {
		const result = buildStorageBackendOptionsSchema(z).safeParse({
			storageMode: 'duckdb'
		});

		expect(result.success).toBeTruthy();
	});
});
