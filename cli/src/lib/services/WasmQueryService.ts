/**
 * WasmQueryService — browser-side QueryService for static Evidence deployments.
 *
 * `evidence export` copies every warehouse table to a Parquet file under
 * `_evidence/data/` and lists them in `_evidence/manifest.json`. This service
 * starts DuckDB-WASM, creates one view per table under the table's original
 * schema (e.g. `warehouse.SRCS_budget`) reading its Parquet file over HTTP, and
 * then runs the page's SQL unchanged: the client already inlines `{{ query }}`
 * references and input values, so the SQL only ever references those tables.
 *
 * Rows are normalized the same way the CLI's DuckDB connector normalizes them
 * for `/api/query`, so components see identical shapes in static and dev mode.
 */

import type {
	QueryService,
	QueryOpts,
	QueryResult,
	Column,
	AnyRowType
} from '@evidence/core/user-components/interfaces/query-service';
import { dialectFor } from '@evidence/core/sql-dialect';
import { normalizeDateRows } from '@evidence/core/connectors/postgres/normalize-date-rows';
import { normalizeNumericRows } from '@evidence/core/connectors/postgres/normalize-numeric-rows';
import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';

/** Written by `evidence export` (cli/cli/static-export.ts). */
export interface StaticManifest {
	generatedAt: string;
	tables: Array<{
		/** Attached database the table lives in (e.g. `warehouse`); null for the default one. */
		catalog: string | null;
		schema: string;
		name: string;
		/** Path relative to the site root, e.g. `_evidence/data/warehouse/SRCS_budget.parquet` */
		file: string;
		rowCount: number;
	}>;
}

// Minimal subset of the Arrow Table API used here. We avoid importing from
// 'apache-arrow' directly because its package.json types field points to the
// Node entry, which is unavailable in bundler mode.
interface ArrowField {
	name: string;
	type: { toString(): string };
	nullable: boolean;
}
interface ArrowTable {
	schema: { fields: ArrowField[] };
	numRows: number;
	getChild(name: string): { get(i: number): unknown } | null | undefined;
}

function quoteIdent(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

function sqlString(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

// Arrow type names (after the casts configured in init) → Evidence jsType.
function arrowTypeToJsType(arrowType: string): Column['jsType'] {
	const t = arrowType.toLowerCase();
	if (/^(date|timestamp|time)/.test(t)) return 'date';
	if (/^(int|uint|float|decimal)/.test(t)) return 'number';
	if (/^bool/.test(t)) return 'boolean';
	if (/^(list|struct|map|fixedsizelist)/.test(t)) return 'object';
	return 'string';
}

function arrowTableToRows(table: ArrowTable, columns: Column[]): AnyRowType[] {
	const children = columns.map((c) => table.getChild(c.name));
	const rows: AnyRowType[] = new Array(table.numRows);
	for (let i = 0; i < table.numRows; i++) {
		const row: AnyRowType = {};
		columns.forEach((col, j) => {
			let value = children[j]?.get(i) ?? null;
			// Arrow returns dates/timestamps as epoch milliseconds.
			if (col.jsType === 'date' && typeof value === 'number') value = new Date(value);
			else if (value !== null && typeof value === 'object' && !(value instanceof Date))
				value = JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)));
			row[col.name] = value as AnyRowType[string];
		});
		rows[i] = row;
	}
	return rows;
}

export class WasmQueryService implements QueryService {
	readonly workspaceId = 'static';
	// DuckDB-WASM speaks the same SQL as MotherDuck (both are DuckDB).
	readonly dialect = dialectFor('motherduck');
	readonly connectionType = 'motherduck';

	private initPromise: Promise<AsyncDuckDBConnection> | null = null;

	/** URL prefix of the static site (no trailing slash), e.g. `/transparent-srcs`. */
	private readonly baseUrl: string;

	constructor(baseUrl = '') {
		this.baseUrl = baseUrl.replace(/\/$/, '');
	}

	private connection(): Promise<AsyncDuckDBConnection> {
		this.initPromise ??= this.init();
		return this.initPromise;
	}

	private async init(): Promise<AsyncDuckDBConnection> {
		const manifestUrl = `${this.baseUrl}/_evidence/manifest.json`;
		const res = await fetch(manifestUrl);
		if (!res.ok) throw new Error(`Failed to fetch ${manifestUrl}: ${res.status}`);
		const manifest = (await res.json()) as StaticManifest;

		// DuckDB-WASM bundles come from jsDelivr; the non-threaded bundle needs no
		// COOP/COEP headers, so this works on plain static hosts like GitHub Pages.
		const duckdb = await import('@duckdb/duckdb-wasm');
		const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
		const workerUrl = URL.createObjectURL(
			new Blob([`importScripts(${JSON.stringify(bundle.mainWorker!)});`], {
				type: 'text/javascript'
			})
		);
		const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(workerUrl));
		await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
		URL.revokeObjectURL(workerUrl);
		await db.open({
			query: { castBigIntToDouble: true, castDecimalToDouble: true }
		});

		const conn = await db.connect();
		const origin = new URL(`${this.baseUrl}/`, window.location.href);
		for (const table of manifest.tables) {
			// Registered by URL: DuckDB fetches only the row groups/columns a query needs.
			const fileName = table.file.replace(/\//g, '__');
			await db.registerFileURL(
				fileName,
				new URL(table.file, origin).toString(),
				duckdb.DuckDBDataProtocol.HTTP,
				false
			);
			// Recreate the warehouse's catalog/schema layout, so `warehouse.orders`
			// resolves here exactly as it did against the native connection.
			const catalog = table.catalog ?? 'memory';
			if (table.catalog) {
				await conn.query(`ATTACH IF NOT EXISTS ':memory:' AS ${quoteIdent(catalog)}`);
			}
			await conn.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(catalog)}.${quoteIdent(table.schema)}`);
			const qualified = [catalog, table.schema, table.name].map(quoteIdent).join('.');
			await conn.query(
				`CREATE OR REPLACE VIEW ${qualified} AS SELECT * FROM read_parquet(${sqlString(fileName)})`
			);
		}
		return conn;
	}

	async query<RowType extends AnyRowType = AnyRowType>(
		sql: string,
		_opts?: QueryOpts
	): Promise<QueryResult<RowType>> {
		const start = performance.now();
		let conn: AsyncDuckDBConnection;
		try {
			conn = await this.connection();
		} catch (e) {
			return {
				rows: [],
				columns: [],
				error: `Could not start the in-browser database: ${e instanceof Error ? e.message : e}`
			};
		}

		let table: ArrowTable;
		try {
			table = (await conn.query(sql)) as unknown as ArrowTable;
		} catch (e) {
			return { rows: [], columns: [], error: e instanceof Error ? e.message : String(e) };
		}

		const columns: Column[] = table.schema.fields.map((f) => ({
			name: f.name,
			clickhouseType: f.type.toString(),
			jsType: arrowTypeToJsType(f.type.toString()),
			nullable: f.nullable
		}));
		const rows = arrowTableToRows(table, columns);
		normalizeDateRows(rows, new Set(columns.filter((c) => c.jsType === 'date').map((c) => c.name)));
		normalizeNumericRows(
			rows,
			new Set(columns.filter((c) => c.jsType === 'number').map((c) => c.name))
		);

		return {
			rows: rows as RowType[],
			columns,
			error: null,
			queryDurationMs: performance.now() - start
		};
	}
}
