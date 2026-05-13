import fs from 'fs/promises';
import http from 'http';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dataDirectory } from '../../lib/projectPaths.js';
import { getSidecarApp } from './sidecar-app.js';

const duckdbFilename = 'evidence.duckdb';
const duckdbPath = path.join(dataDirectory, duckdbFilename);
const ducklakeFilename = 'evidence.ducklake';
const ducklakePath = path.join(dataDirectory, ducklakeFilename);
const ducklakeDataRelativePath = path.join('evidence.ducklake.data', 'main', 'orders', 'part-0001.parquet');
const ducklakeDataPath = path.join(dataDirectory, ducklakeDataRelativePath);

/** @returns {Promise<{ server: http.Server, baseUrl: string, close: () => Promise<void> }>} */
const createTestServer = async () => {
	const app = getSidecarApp();
	const server = http.createServer(app);

	await new Promise((resolve, reject) => {
		server.listen(0, '127.0.0.1', (error) => {
			if (error) reject(error);
			else resolve(undefined);
		});
	});

	const address = server.address();
	if (!address || typeof address === 'string') {
		throw new Error('Could not resolve test server address');
	}

	return {
		server,
		baseUrl: `http://127.0.0.1:${address.port}`,
		close: async () => {
			await new Promise((resolve, reject) => {
				server.close((error) => {
					if (error) reject(error);
					else resolve(undefined);
				});
			});
		}
	};
};

describe('dev sidecar duckdb file routing', () => {
	beforeEach(async () => {
		await fs.mkdir(dataDirectory, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(duckdbPath, { force: true });
		await fs.rm(ducklakePath, { force: true });
		await fs.rm(path.join(dataDirectory, 'evidence.ducklake.data'), { recursive: true, force: true });
	});

	it('serves duckdb database files from the query endpoint', async () => {
		const expectedContents = 'duckdb-test-bytes';
		await fs.writeFile(duckdbPath, expectedContents, 'utf-8');

		const { baseUrl, close } = await createTestServer();
		try {
			const response = await fetch(`${baseUrl}/_evidence/query/evidence.duckdb`);
			expect(response.status).toBe(200);
			expect(await response.text()).toBe(expectedContents);
		} finally {
			await close();
		}
	});

	it('returns 404 when duckdb database file is missing', async () => {
		const { baseUrl, close } = await createTestServer();
		try {
			const response = await fetch(`${baseUrl}/_evidence/query/evidence.duckdb`);
			expect(response.status).toBe(404);
		} finally {
			await close();
		}
	});

	it('serves ducklake database files from the query endpoint', async () => {
		const expectedContents = 'ducklake-test-bytes';
		await fs.writeFile(ducklakePath, expectedContents, 'utf-8');

		const { baseUrl, close } = await createTestServer();
		try {
			const response = await fetch(`${baseUrl}/_evidence/query/evidence.ducklake`);
			expect(response.status).toBe(200);
			expect(await response.text()).toBe(expectedContents);
		} finally {
			await close();
		}
	});

	it('serves ducklake nested data files from the query endpoint', async () => {
		const expectedContents = 'ducklake-parquet-bytes';
		await fs.mkdir(path.dirname(ducklakeDataPath), { recursive: true });
		await fs.writeFile(ducklakeDataPath, expectedContents, 'utf-8');

		const { baseUrl, close } = await createTestServer();
		try {
			const response = await fetch(
				`${baseUrl}/_evidence/query/${ducklakeDataRelativePath.replaceAll(path.sep, '/')}`
			);
			expect(response.status).toBe(200);
			expect(await response.text()).toBe(expectedContents);
		} finally {
			await close();
		}
	});
});
