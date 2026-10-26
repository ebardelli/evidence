import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractRelations, parseRelations, supportsRelationCheck } from './query-relations';
import { runQuery } from './run-query';

vi.mock('./run-query', () => ({ runQuery: vi.fn() }));

// Minimal json_serialize_sql-shaped nodes — only the fields extractRelations reads.
const table = (table_name: string, schema_name = '', catalog_name = '') => ({
	type: 'BASE_TABLE',
	alias: '',
	catalog_name,
	schema_name,
	table_name
});
const tableFunction = (function_name: string) => ({
	type: 'TABLE_FUNCTION',
	alias: '',
	function: { class: 'FUNCTION', type: 'FUNCTION', function_name }
});
const select = (from_table: unknown, extra: Record<string, unknown> = {}) => ({
	type: 'SELECT_NODE',
	cte_map: { map: [] },
	from_table,
	...extra
});
const withCtes = (ctes: Record<string, unknown>, node: Record<string, unknown>) => ({
	...node,
	cte_map: {
		map: Object.entries(ctes).map(([key, query_node]) => ({ key, value: { query_node } }))
	}
});

describe('extractRelations', () => {
	it('collects qualified tables (lowercased), joins, subqueries and table functions', () => {
		const tree = [
			{
				node: select(
					{ type: 'JOIN', left: table('T', 'S', 'WH'), right: tableFunction('read_csv') },
					{
						where_clause: {
							type: 'SUBQUERY',
							subquery: { node: select(table('u', 'S2')) }
						}
					}
				)
			}
		];
		const { tables, functions } = extractRelations(tree);
		expect([...tables].sort()).toEqual(['s2.u', 'wh.s.t']);
		expect([...functions]).toEqual(['read_csv']);
	});

	it('treats an unqualified ref to an in-scope CTE as not a table read', () => {
		const tree = withCtes({ m: select(table('t', 's', 'wh')) }, select(table('m')));
		expect([...extractRelations(tree).tables]).toEqual(['wh.s.t']);
	});

	it('treats a CTE name used outside its scope as a real table', () => {
		const inner = withCtes({ stu: select(table('x')) }, select(table('stu')));
		const tree = select({ type: 'JOIN', left: { type: 'SUBQUERY', subquery: { node: inner } }, right: table('stu') });
		expect([...extractRelations(tree).tables].sort()).toEqual(['stu', 'x']);
	});

	it('never skips a qualified ref, even if it matches a CTE name', () => {
		const tree = withCtes({ stu: select(table('x')) }, select(table('stu', 'dbo', 'aeries')));
		expect(extractRelations(tree).tables.has('aeries.dbo.stu')).toBe(true);
	});
});

describe('supportsRelationCheck', () => {
	it('is limited to DuckDB-flavoured connections', () => {
		expect(supportsRelationCheck('duckdb')).toBe(true);
		expect(supportsRelationCheck('motherduck')).toBe(true);
		expect(supportsRelationCheck('postgres')).toBe(false);
		expect(supportsRelationCheck(null)).toBe(false);
	});
});

describe('parseRelations', () => {
	const respond = (payload: unknown) =>
		vi.mocked(runQuery).mockResolvedValueOnce({
			rows: [{ j: JSON.stringify(payload) }],
			columns: [{ name: 'j', jsType: 'string' } as never]
		});

	beforeEach(() => vi.mocked(runQuery).mockReset());

	it('quotes the SQL into json_serialize_sql', async () => {
		respond({ error: false, statements: [{ node: select(table('a')) }] });
		await parseRelations("select 'it''s' from a -- unique 1");
		expect(vi.mocked(runQuery).mock.calls[0]?.[0]).toBe(
			"SELECT json_serialize_sql('select ''it''''s'' from a -- unique 1') AS j"
		);
	});

	it('returns not-select for statements the parser refuses to serialize', async () => {
		respond({ error: true, error_type: 'not implemented', error_message: 'Only SELECT…' });
		expect(await parseRelations("COPY t TO 'x' -- unique 2")).toMatchObject({
			ok: false,
			reason: 'not-select'
		});
	});

	it('returns not-select for more than one statement', async () => {
		respond({ error: false, statements: [{ node: select(table('a')) }, { node: select(table('b')) }] });
		expect(await parseRelations('select 1; select 2 -- unique 3')).toMatchObject({
			ok: false,
			reason: 'not-select'
		});
	});

	it('returns parse-error for a syntax error', async () => {
		respond({ error: true, error_type: 'parser', error_message: 'syntax error' });
		expect(await parseRelations('selec 1 -- unique 4')).toMatchObject({
			ok: false,
			reason: 'parse-error'
		});
	});

	it('caches verdicts but not failures to reach the parser', async () => {
		vi.mocked(runQuery).mockResolvedValueOnce({ rows: [], columns: [], error: 'down', status: 500 });
		expect((await parseRelations('select 5 -- unique 5')).ok).toBe(false);
		respond({ error: false, statements: [{ node: select(table('a')) }] });
		expect((await parseRelations('select 5 -- unique 5')).ok).toBe(true);
		expect((await parseRelations('select 5 -- unique 5')).ok).toBe(true);
		expect(runQuery).toHaveBeenCalledTimes(2);
	});
});
