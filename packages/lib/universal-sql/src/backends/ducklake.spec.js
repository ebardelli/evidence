import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveDuckLakeRemoteDataPath, resolveDuckLakeRemoteUrlPrefix } from './ducklake.js';

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

describe('resolveDuckLakeRemoteDataPath', () => {
	it('preserves nested relative subpaths inside dataPath', () => {
		expect(
			resolveDuckLakeRemoteDataPath({
				dataPath: '/workspace/.evidence/template/_evidence/query',
				localDataPath: '/workspace/.evidence/template/_evidence/query/ducklake/data/evidence.ducklake.data',
				remoteUrlPrefix: 'http://localhost:3000/_evidence/query'
			})
		).toBe('http://localhost:3000/_evidence/query/ducklake/data/evidence.ducklake.data');
	});

	it('falls back to basename when local data path is outside dataPath', () => {
		expect(
			resolveDuckLakeRemoteDataPath({
				dataPath: '/workspace/.evidence/template/_evidence/query',
				localDataPath: '/tmp/custom/evidence.ducklake.data',
				remoteUrlPrefix: 'http://localhost:3000/_evidence/query'
			})
		).toBe('http://localhost:3000/_evidence/query/evidence.ducklake.data');
	});
});
