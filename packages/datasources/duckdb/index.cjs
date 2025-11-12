const {
	EvidenceType,
	TypeFidelity,
	asyncIterableToBatchedAsyncGenerator,
	cleanQuery,
	exhaustStream
} = require('@evidence-dev/db-commons');
const { DuckDBInstance } = require('@duckdb/node-api');
const path = require('path');
const fs = require('fs/promises');

/**
 * Converts BigInt values to Numbers in an object.
 * @param {Record<string, unknown>} obj - The input object with potential BigInt values.
 * @returns {Record<string, unknown>} - The object with BigInt values converted to Numbers.
 */
function standardizeRow(obj) {
	for (const key in obj) {
		if (typeof obj[key] === 'bigint') {
			obj[key] = Number(obj[key]);
		}
	}
	return obj;
}

/**
 *
 * @param {unknown} data
 * @returns {EvidenceType | undefined}
 */
function nativeTypeToEvidenceType(data) {
	switch (typeof data) {
		case 'number':
			return EvidenceType.NUMBER;
		case 'string':
			return EvidenceType.STRING;
		case 'boolean':
			return EvidenceType.BOOLEAN;
		case 'object':
			if (data instanceof Date) {
				return EvidenceType.DATE;
			}
			throw new Error(`Unsupported object type: ${data}`);
		default:
			return EvidenceType.STRING;
	}
}

/**
 * @param {Record<string, unknown>[]} rows
 * @returns {import('@evidence-dev/db-commons').ColumnDefinition[]}
 */
const mapResultsToEvidenceColumnTypes = function (rows) {
	return Object.entries(rows[0]).map(([name, value]) => {
		/** @type {TypeFidelity} */
		let typeFidelity = TypeFidelity.PRECISE;
		let evidenceType = nativeTypeToEvidenceType(value);
		if (!evidenceType) {
			typeFidelity = TypeFidelity.INFERRED;
			evidenceType = EvidenceType.STRING;
		}
		return { name, evidenceType, typeFidelity };
	});
};

/**
 * @param {{ column_name: string; column_type: string; }[]} describe
 * @returns {import('@evidence-dev/db-commons').ColumnDefinition[]}
 */
function duckdbDescribeToEvidenceType(describe) {
	return describe.map((column) => {
		let type;
		if (/DECIMAL/i.test(column.column_type)) {
			type = EvidenceType.NUMBER;
		} else {
			switch (column.column_type) {
				case 'BOOLEAN':
					type = EvidenceType.BOOLEAN;
					break;
				case 'DATE':
				case 'TIMESTAMP':
				case 'TIMESTAMP WITH TIME ZONE':
				case 'TIMESTAMP_S':
				case 'TIMESTAMP_MS':
				case 'TIMESTAMP_NS':
					type = EvidenceType.DATE;
					break;
				case 'DOUBLE':
				case 'FLOAT':
				case 'TINYINT':
				case 'UTINYINT':
				case 'SMALLINT':
				case 'USMALLINT':
				case 'INTEGER':
				case 'UINTEGER':
				case 'UBIGINT':
				case 'HUGEINT':
					type = EvidenceType.NUMBER;
					break;
				case 'BIGINT':
					type = EvidenceType.NUMBER;
					break;
				case 'DECIMAL':
				case 'TIME':
				case 'TIME WITH TIME ZONE':
					type = EvidenceType.STRING;
					break;
				default:
					type = EvidenceType.STRING;
					break;
			}
		}
		return { name: column.column_name, evidenceType: type, typeFidelity: TypeFidelity.PRECISE };
	});
}

/** @type {import("@evidence-dev/db-commons").RunQuery<DuckDBOptions>} */
const runQuery = async (queryString, database, batchSize = 100000) => {
	let filename = ':memory:';

	if (database?.filename) {
		if (database.filename.startsWith('md:') || database.filename === ':memory:') {
			// MotherDuck or in-memory database
			filename = database.filename;
		} else if (database.directory) {
			// Local database stored in source directory
			filename = path.join(database.directory, database.filename);
		} else {
			// filename provided without a directory; use as given (may be absolute or relative)
			filename = database.filename;
		}
	}

	const mode = filename !== ':memory:' ? 'READ_ONLY' : 'READ_WRITE';
	// Create a DuckDB instance and connection using the new node-api
	const db = await DuckDBInstance.create(filename, {
		access_mode: mode,
		custom_user_agent: 'evidence-dev'
	});
	const conn = await db.connect();

	// Helper: split SQL into statements while ignoring semicolons inside
	// single/double/backtick quotes and inside SQL comments (line: --, block: /* */).
	// This is a lightweight tokenizer good enough for our use-case (initialization
	// statements like SET ...; followed by a main SELECT). It is not a full SQL parser.
	function splitSqlStatements(sql) {
		const statements = [];
		let buf = '';
		let inSingle = false;
		let inDouble = false;
		let inBacktick = false;
		let inLineComment = false;
		let inBlockComment = false;
		for (let i = 0; i < sql.length; i++) {
			const ch = sql[i];
			const next = sql[i + 1];

			// Handle entering/exiting comments first
			if (!inSingle && !inDouble && !inBacktick) {
				if (!inBlockComment && ch === '-' && next === '-') {
					inLineComment = true;
					buf += ch; // keep the chars so statements preserve comments if needed
					continue;
				}
				if (!inLineComment && ch === '/' && next === '*') {
					inBlockComment = true;
					buf += ch;
					continue;
				}
			}

			if (inLineComment) {
				buf += ch;
				if (ch === '\n') {
					inLineComment = false;
				}
				continue;
			}

			if (inBlockComment) {
				buf += ch;
				if (ch === '*' && next === '/') {
					buf += next;
					i++;
					inBlockComment = false;
				}
				continue;
			}

			// handle quotes
			if (ch === "'" && !inDouble && !inBacktick) {
				// SQL escapes single quote by doubling it: ''
				if (inSingle && next === "'") {
					// consume escaped quote and keep both
					buf += "''";
					i++; // skip next
					continue;
				}
				inSingle = !inSingle;
				buf += ch;
				continue;
			}

			if (ch === '"' && !inSingle && !inBacktick) {
				// double-quote toggles
				inDouble = !inDouble;
				buf += ch;
				continue;
			}

			if (ch === '`' && !inSingle && !inDouble) {
				inBacktick = !inBacktick;
				buf += ch;
				continue;
			}

			// At this point, if we see a semicolon and we're not inside a quote/comment,
			// treat it as a statement separator.
			if (ch === ';' && !inSingle && !inDouble && !inBacktick) {
				const stmt = buf.trim();
				if (stmt.length > 0) statements.push(stmt);
				buf = '';
				continue;
			}

			buf += ch;
		}
		const trailing = buf.trim();
		if (trailing.length > 0) statements.push(trailing);
		return statements;
	}

	// If the provided query contains multiple statements (for example SET ...; SET ...; SELECT ...),
	// execute all but the final statement as one-off commands so the streaming reader only sees
	// the final/main statement. This prevents the DuckDB node-api from returning multiple result
	// sets which later break downstream validation.
	let mainStatement = queryString;
	try {
		const stmts = splitSqlStatements(queryString);
		if (stmts.length > 1) {
			// run all prefix statements (everything except the last) synchronously via conn.run
			for (let i = 0; i < stmts.length - 1; i++) {
				try {
					// append semicolon to be explicit, but conn.run accepts statements without it too
					await conn.run(stmts[i] + ';').catch(() => null);
				} catch (err) {
					// ignore initialization errors - downstream query may still succeed
				}
			}
			mainStatement = stmts[stmts.length - 1];
		}
	} catch (e) {
		// If splitting fails for any reason, fall back to using the entire query string.
		mainStatement = queryString;
	}

	if (database?.directory) {
		const contents = await fs.readdir(database.directory);
		if (contents.find((d) => d === 'initialize.sql')) {
			const initScript = await fs.readFile(path.resolve(database.directory, 'initialize.sql'), {
				encoding: 'utf-8'
			});
			// run the initialization script
			await conn.run(initScript).catch(() => null);
		}
	}

	// Prepare a reader that can stream chunks. Use the main statement (after running any prefix SETs)
	// for count/describe/stream operations so we don't accidentally inspect side-effect statements.
	const count_query = `WITH root as (${cleanQuery(mainStatement)}) SELECT COUNT(*) FROM root`;
	let expected_row_count = null;
	try {
		const countReader = await conn.runAndReadAll(count_query);
		await countReader.readAll();
		const countRow = countReader.getRowObjectsJS()?.[0];
		if (countRow) {
			// take the first value from the row (column name may vary)
			expected_row_count = Object.values(countRow)[0];
		}
	} catch (e) {
		expected_row_count = null;
	}

	const column_query = `DESCRIBE ${cleanQuery(mainStatement)}`;
	let column_types = null;
	try {
		const colReader = await conn.runAndReadAll(column_query);
		await colReader.readAll();
		const describeRows = colReader.getRowObjectsJS();
		column_types = duckdbDescribeToEvidenceType(describeRows);
	} catch (e) {
		column_types = null;
	}

	// Create an async generator that yields batches using the DuckDBResultReader
	const reader = await conn.streamAndRead(mainStatement);

	const rowsAsyncIterable = (async function* () {
		try {
			let prev = 0;
			// keep reading until done
			while (!reader.done) {
				const target = prev + batchSize;
				await reader.readUntil(target);
				const allRows = reader.getRowObjectsJS();
				const newRows = allRows.slice(prev).map(standardizeRow);
				// yield rows one-by-one (asyncIterableToBatchedAsyncGenerator expects single-row yields)
				for (const r of newRows) {
					yield r;
				}
				prev = reader.currentRowCount;
			}
		} finally {
			// disconnect the connection and close the instance synchronously
			try {
				conn.disconnectSync();
			} catch (err) {}
			try {
				db.closeSync();
			} catch (err) {}
		}
	})();

	const results = await asyncIterableToBatchedAsyncGenerator(rowsAsyncIterable, batchSize, {
		mapResultsToEvidenceColumnTypes:
			column_types == null ? mapResultsToEvidenceColumnTypes : undefined,
		standardizeRow,
		closeConnection: () => {
			try {
				conn.disconnectSync();
			} catch (err) {}
			try {
				db.closeSync();
			} catch (err) {}
		}
	});
	if (column_types != null) {
		results.columnTypes = column_types;
	}
	results.expectedRowCount = expected_row_count;
	if (typeof results.expectedRowCount === 'bigint') {
		// newer versions of ddb return a bigint
		results.expectedRowCount = Number(results.expectedRowCount);
	}

	return results;
};

module.exports = runQuery;

/**
 * @typedef {Object} DuckDBOptions
 * @property {string} filename
 * @property {string} directory
 */

/**
 * @typedef {Object} QueryResult
 * @property { Record<string, any>[] } rows
 * @property { { name: string, evidenceType: string, typeFidelity: string }[] } columnTypes
 */

/** @type {import("@evidence-dev/db-commons").GetRunner<DuckDBOptions>} */
module.exports.getRunner = async (opts, directory) => {
	if (!opts.filename) {
		console.error(`Missing required duckdb option 'filename' (${directory})`);
	}

	return async (queryContent, queryPath, batchSize) => {
		// Filter out non-sql files
		if (!queryPath.endsWith('.sql')) return null;
		if (queryPath.endsWith('initialize.sql')) return null;
		return runQuery(queryContent, { ...opts, directory: directory }, batchSize);
	};
};

/** @type {import("@evidence-dev/db-commons").ConnectionTester<DuckDBOptions>} */
module.exports.testConnection = async (opts, directory) => {
	const r = await runQuery('SELECT 1;', {
		...opts,
		directory: directory
	})
		.then(exhaustStream)
		.then(() => true)
		.catch((e) => {
			if (typeof e === 'string' && e !== '') {
				const indentedMessage = `\n\t${e.split('\n').join('\n\t')}`;
				return { reason: indentedMessage };
			}
			return { reason: e.message ?? 'File not found' };
		});
	return r;
};

module.exports.options = {
	filename: {
		title: 'Filename',
		type: 'string',
		secret: false,
		description:
			'DuckDB filename. This is relative to your source directory, not your project directory.',
		default: 'needful_things.duckdb',
		required: true
	}
};
