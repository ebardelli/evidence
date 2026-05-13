import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveDuckLakeRemoteUrlPrefix } from './ducklake.js';

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('resolveDuckLakeRemoteUrlPrefix', () => {
	it('uses localhost origin in non-build mode when prefix is relative', () => {
		vi.stubEnv('EVIDENCE_IS_BUILDING', undefined);
		vi.stubEnv('EVIDENCE_DEV_PORT', '3000');

		expect(resolveDuckLakeRemoteUrlPrefix('static/data')).toBe('http://localhost:3000/static/data');
	});

	it('uses deploy origin in build mode when prefix is relative', () => {
		vi.stubEnv('EVIDENCE_IS_BUILDING', 'true');
		vi.stubEnv('EVIDENCE_DUCKLAKE_DEPLOY_ORIGIN', 'https://deploy.example.com');

		expect(resolveDuckLakeRemoteUrlPrefix('static/data')).toBe(
			'https://deploy.example.com/static/data'
		);
	});

	it('keeps absolute urlPrefix unchanged', () => {
		vi.stubEnv('EVIDENCE_IS_BUILDING', 'true');

		expect(resolveDuckLakeRemoteUrlPrefix('https://cdn.example.com/static/data')).toBe(
			'https://cdn.example.com/static/data'
		);
	});
});
