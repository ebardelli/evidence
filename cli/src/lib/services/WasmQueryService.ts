/**
 * WasmQueryService — browser-side QueryService for static Evidence deployments.
 *
 * At build time, `evidence export` runs every named SQL query against the
 * warehouse and saves the results as Parquet files under `_evidence/data/`.
 * A JSON manifest at `_evidence/manifest.json` catalogs those files with the
 * normalised (filter-stripped) SQL used to produce them.
 *
 * At runtime this service:
 *  1. Lazy-initialises DuckDB-WASM (singleton per page load).
 *  2. Fetches the manifest once and indexes it by normalised SQL.
 *  3. For each incoming query, matches the runtime SQL to a Parquet file via
 *     normalised-SQL prefix matching (the runtime SQL may have filter values
 *     appended that the build-time SQL didn't have).
 *  4. Registers the Parquet file with DuckDB-WASM and, for simple single-table
 *     queries, creates a view named after the original source table so the
 *     runtime SQL (with filter predicates) runs unchanged.
 *  5. Falls back to `SELECT * FROM <parquet>` if the runtime SQL fails (e.g.
 *     when filter columns aren't present in a pre-aggregated dataset).
 */

import type {
	QueryService,
	QueryOpts,
	QueryResult,
	Column,
	AnyRowType
} from '@evidence/core/user-components/interfaces/query-service';
import { dialectFor } from '@evidence/core/sql-dialect';
import type { StaticManifest, QueryManifestEntry } from '../../../cli/static-export.ts';
import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';

// Minimal subset of the Arrow Table API used by this module.
// We avoid importing from 'apache-arrow' directly because its package.json
// types field points to the Node entry which is unavailable in bundler mode.
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

// ---------------------------------------------------------------------------
// SQL normalisation — must match the build-time normaliseSql() exactly.
// ---------------------------------------------------------------------------

function normaliseSql(sql: string): string {
	return sql.toLowerCase().replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Arrow type string → Evidence Column jsType
// ---------------------------------------------------------------------------

function arrowTypeToJsType(arrowTypeStr: string): Column['jsType'] {
	const t = arrowTypeStr.toLowerCase();
	if (/int|float|double|decimal|numeric|real/.test(t)) return 'number';
	if (/bool/.test(t)) return 'boolean';
	if (/date|time|timestamp|interval/.test(t)) return 'date';
	if (/list|map|struct/.test(t)) return 'object';
	return 'string';
}

// ---------------------------------------------------------------------------
// Row extraction from Arrow table
// ---------------------------------------------------------------------------

function arrowTableToRows(table: ArrowTable): AnyRowType[] {
	const fields = table.schema.fields;
	const rows: AnyRowType[] = [];
	for (let i = 0; i < table.numRows; i++) {
		const row: AnyRowType = {};
		for (const f of fields) {
			const raw = table.getChild(f.name)?.get(i);
			// Convert BigInt (Int64) to number so JSON serialisation works
			const val = typeof raw === 'bigint' ? Number(raw) : (raw ?? null);
			row[f.name] = val as string | number | Date | null;
		}
		rows.push(row);
	}
	return rows;
}

// ---------------------------------------------------------------------------
// WasmQueryService
// ---------------------------------------------------------------------------

export class WasmQueryService implements QueryService {
	readonly workspaceId = 'static';
	readonly dialect = dialectFor('motherduck');
	readonly connectionType = 'duckdb-wasm';

	private _initPromise: Promise<void> | null = null;
	private _db: AsyncDuckDB | null = null;
	private _conn: AsyncDuckDBConnection | null = null;
	private _manifest: StaticManifest | null = null;
	private _registeredFiles = new Set<string>();

	/** Base URL for the static deployment (no trailing slash). Defaults to site root. */
	private readonly baseUrl: string;

	constructor(baseUrl = '') {
		this.baseUrl = baseUrl.replace(/\/$/, '');
	}

	// -------------------------------------------------------------------------
	// Lazy initialisation
	// -------------------------------------------------------------------------

	private init(): Promise<void> {
		if (!this._initPromise) this._initPromise = this._doInit();
		return this._initPromise;
	}

	private async _doInit(): Promise<void> {
		// 1. Fetch manifest
		const manifestUrl = `${this.baseUrl}/_evidence/manifest.json`;
		const res = await fetch(manifestUrl);
		if (!res.ok) throw new Error(`Failed to fetch manifest: ${res.status} ${manifestUrl}`);
		this._manifest = (await res.json()) as StaticManifest;

		// 2. Initialise DuckDB-WASM via jsDelivr CDN bundles.
		//    For offline / air-gapped deployments, replace with self-hosted bundles.
		const duckdb = await import('@duckdb/duckdb-wasm');
		const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());

		const workerUrl = URL.createObjectURL(
			new Blob([`importScripts("${bundle.mainWorker!}");`], { type: 'text/javascript' })
		);
		const worker = new Worker(workerUrl);

		this._db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
		await this._db.instantiate(bundle.mainModule, bundle.pthreadWorker);
		URL.revokeObjectURL(workerUrl);

		this._conn = await this._db.connect();
	}

	// -------------------------------------------------------------------------
	// Manifest lookup
	// -------------------------------------------------------------------------

	/**
	 * Match runtime SQL to a manifest entry.
	 *
	 * Tries exact normalised match first, then prefix match: the runtime SQL may
	 * have filter predicates appended (e.g. "… WHERE status = 'shipped'") after
	 * the base query that was pre-computed at build time. Longest prefix wins.
	 */
	private findEntry(sql: string): [string, QueryManifestEntry] | null {
		if (!this._manifest) return null;
		const normalised = normaliseSql(sql);
		const entries = Object.entries(this._manifest.queries);

		// Exact match
		for (const [name, entry] of entries) {
			if (entry.normalizedSql === normalised) return [name, entry];
		}

		// Prefix match — longest base wins to avoid false positives
		let best: [string, QueryManifestEntry] | null = null;
		let bestLen = 0;
		for (const [name, entry] of entries) {
			const base = entry.normalizedSql;
			if (normalised.startsWith(base) && base.length > bestLen) {
				best = [name, entry];
				bestLen = base.length;
			}
		}
		return best;
	}

	// -------------------------------------------------------------------------
	// Parquet registration
	// -------------------------------------------------------------------------

	private async ensureParquet(name: string, entry: QueryManifestEntry): Promise<void> {
		if (this._registeredFiles.has(name)) return;

		const duckdb = await import('@duckdb/duckdb-wasm');
		const parquetFile = `_ev_${name}.parquet`;
		const url = `${this.baseUrl}/${entry.file}`;

		await this._db!.registerFileURL(parquetFile, url, duckdb.DuckDBDataProtocol.HTTP, false);

		// Internal view — used by the fallback SELECT path
		await this._conn!.query(
			`CREATE OR REPLACE VIEW "_ev_${name}" AS SELECT * FROM parquet_scan('${parquetFile}')`
		);

		// Source-table view — lets the original SQL run against the Parquet
		if (entry.sourceTable) {
			await this._conn!.query(
				`CREATE OR REPLACE VIEW "${entry.sourceTable}" AS SELECT * FROM "_ev_${name}"`
			);
		}

		this._registeredFiles.add(name);
	}

	// -------------------------------------------------------------------------
	// QueryService.query
	// -------------------------------------------------------------------------

	async query<RowType extends AnyRowType = AnyRowType>(
		sql: string,
		_opts?: QueryOpts
	): Promise<QueryResult<RowType>> {
		const start = performance.now();

		try {
			await this.init();
		} catch (e) {
			return {
				rows: [],
				columns: [],
				error: `WasmQueryService init failed: ${e instanceof Error ? e.message : e}`
			};
		}

		const match = this.findEntry(sql);
		if (!match) {
			return {
				rows: [],
				columns: [],
				error: `No pre-built dataset found for this query. Run \`evidence export\` to rebuild.`
			};
		}
		const [name, entry] = match;

		try {
			await this.ensureParquet(name, entry);
		} catch (e) {
			return {
				rows: [],
				columns: [],
				error: `Failed to load Parquet for "${name}": ${e instanceof Error ? e.message : e}`
			};
		}

		// Run the runtime SQL with live filter values. Fall back to a full scan
		// if the SQL fails — e.g. the filter column was aggregated away and the
		// Parquet doesn't include it.
		let arrowTable: ArrowTable;
		try {
			arrowTable = (await this._conn!.query(sql)) as unknown as ArrowTable;
		} catch {
			try {
				arrowTable = (await this._conn!.query(
					`SELECT * FROM "_ev_${name}"`
				)) as unknown as ArrowTable;
			} catch (e2) {
				return {
					rows: [],
					columns: [],
					error: `Query failed: ${e2 instanceof Error ? e2.message : e2}`
				};
			}
		}

		const columns: Column[] = arrowTable.schema.fields.map((f) => ({
			name: f.name,
			clickhouseType: f.type.toString(),
			jsType: arrowTypeToJsType(f.type.toString()),
			nullable: f.nullable
		}));

		return {
			rows: arrowTableToRows(arrowTable) as RowType[],
			columns,
			error: null,
			queryDurationMs: performance.now() - start
		};
	}
}
