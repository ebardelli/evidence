import { describe, expect, it } from 'vitest';
import { EvidenceConfigSchema } from './config.schema.js';

describe('EvidenceConfigSchema', () => {
	it('accepts motherduck storage mode', () => {
		const config = EvidenceConfigSchema.safeParse({
			plugins: {},
			buildOptions: {
				storageMode: 'motherduck'
			}
		});

		expect(config.success).toBeTruthy();
	});

	it('preserves motherduck connection options in buildOptions', () => {
		const config = EvidenceConfigSchema.safeParse({
			plugins: {},
			buildOptions: {
				storageMode: 'motherduck',
				database: 'warehouse',
				token: 'secret',
				readScalingToken: 'read-secret'
			}
		});

		expect(config.success).toBeTruthy();
		expect(config.data.buildOptions).toEqual({
			storageMode: 'motherduck',
			database: 'warehouse',
			token: 'secret',
			readScalingToken: 'read-secret'
		});
	});

	it('accepts ducklake storage mode', () => {
		const config = EvidenceConfigSchema.safeParse({
			plugins: {},
			buildOptions: {
				storageMode: 'ducklake'
			}
		});

		expect(config.success).toBeTruthy();
	});
});
