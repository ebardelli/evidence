import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runQuery } from './run-query';

vi.mock('./run-query', () => ({ runQuery: vi.fn() }));

import {
	filterTemplate,
	filteredRef,
	inspect,
	keyTableName,
	parseSelect,
	rewriteTables,
	tableMatches,
	type JsonNode
} from './row-filter-sql';

const table = (table_name: string, schema_name = '', alias = ''): JsonNode => ({
	type: 'BASE_TABLE',
	alias,
	table_name,
	schema_name,
	catalog_name: '',
	column_name_alias: []
});
const select = (from_table: JsonNode, extra: JsonNode = {}): JsonNode => ({
	node: { type: 'SELECT_NODE', cte_map: { map: [] }, from_table, ...extra },
	named_param_map: []
});
const serialized = (value: unknown) =>
	vi.mocked(runQuery).mockResolvedValueOnce({
		rows: [{ j: typeof value === 'string' ? value : JSON.stringify(value) }],
		columns: [{ name: 'j' } as never]
	});

beforeEach(() => vi.mocked(runQuery).mockReset());

describe('tableMatches', () => {
	const ref = (table: string, schema = '', catalog = '') => ({ table, schema, catalog });

	it('matches on the table name, case-insensitively', () => {
		expect(tableMatches('students', ref('Students'))).toBe(true);
		expect(tableMatches('students', ref('staff'))).toBe(false);
	});

	it('only compares qualifiers written on both sides', () => {
		expect(tableMatches('students', ref('students', 'main', 'db'))).toBe(true);
		expect(tableMatches('main.students', ref('students'))).toBe(true);
		expect(tableMatches('main.students', ref('students', 'main'))).toBe(true);
		expect(tableMatches('main.students', ref('students', 'archive'))).toBe(false);
		expect(tableMatches('db.main.students', ref('students', 'main', 'other'))).toBe(false);
	});

	it('strips double quotes from the key', () => {
		expect(tableMatches('"main"."Students"', ref('students', 'main'))).toBe(true);
		expect(keyTableName('main."Students"')).toBe('students');
	});
});

describe('inspect', () => {
	it('finds tables, CTE names and table functions at any depth', () => {
		const statement = select(
			{
				type: 'JOIN',
				left: table('students', 'main'),
				right: { type: 'TABLE_FUNCTION', function: { function_name: 'Read_CSV' } }
			},
			{
				cte_map: { map: [{ key: 'Totals', value: select(table('staff')) }] },
				where_clause: { class: 'SUBQUERY', subquery: select(table('schools')) }
			}
		);
		const info = inspect(statement);
		expect(info.tables.map((t) => t.table).sort()).toEqual(['schools', 'staff', 'students']);
		expect([...info.cteNames]).toEqual(['totals']);
		expect([...info.functions]).toEqual(['read_csv']);
	});

	const cte = (key: string, from: JsonNode, type = 'SELECT_NODE'): JsonNode => ({
		key,
		value: { query_node: { type, from_table: from } }
	});

	it('skips references that bind to a CTE, scoped as DuckDB binds them', () => {
		// WITH a AS (FROM b), b AS (FROM a) SELECT … FROM b JOIN main.a JOIN x
		const statement = select(
			{ type: 'JOIN', left: table('B'), right: { type: 'JOIN', left: table('a', 'main'), right: table('x') } },
			{ cte_map: { map: [cte('a', table('b')), cte('b', table('a'))] } }
		);
		const refs = inspect(statement).tables.map((t) => [t.schema, t.table].filter(Boolean).join('.'));
		// `b` inside `a` is the real table (defined later); `main.a` is qualified.
		expect(refs.sort()).toEqual(['b', 'main.a', 'x']);
	});

	it('lets a recursive CTE see itself, and not leak out of a subquery', () => {
		const statement = select(table('r'), {
			where_clause: {
				class: 'SUBQUERY',
				subquery: select(table('inner_cte'), { cte_map: { map: [cte('inner_cte', table('t'))] } })
			},
			cte_map: { map: [cte('r', table('r'), 'RECURSIVE_CTE_NODE'), cte('s', table('s'))] }
		});
		const refs = inspect(statement).tables.map((t) => t.table);
		expect(refs.sort()).toEqual(['s', 't']);
		expect(inspect(select(table('inner_cte'))).tables).toHaveLength(1);
	});
});

describe('rewriteTables / filteredRef', () => {
	const template: JsonNode = {
		type: 'SUBQUERY',
		alias: 'placeholder',
		column_name_alias: [],
		subquery: {
			node: { type: 'SELECT_NODE', from_table: table('placeholder'), where_clause: { class: 'PREDICATE' } }
		}
	};

	it('wraps matching refs, keeping their alias and the original ref inside', () => {
		const ref = { ...table('students', 'main', 's'), column_name_alias: ['a', 'b'] };
		const out = rewriteTables(select(ref), (r, node) =>
			r.table === 'students' ? filteredRef(template, node) : null
		);
		const from = (out.node as JsonNode).from_table as JsonNode;
		expect(from.type).toBe('SUBQUERY');
		expect(from.alias).toBe('s');
		expect(from.column_name_alias).toEqual(['a', 'b']);
		const inner = (from.subquery as JsonNode).node as JsonNode;
		expect(inner.from_table).toMatchObject({ table_name: 'students', schema_name: 'main', alias: '', column_name_alias: [] });
		expect(inner.where_clause).toEqual({ class: 'PREDICATE' });
	});

	it('aliases an unaliased ref by its table name, and leaves the template untouched', () => {
		const out = rewriteTables(select(table('students')), (_r, node) => filteredRef(template, node));
		expect(((out.node as JsonNode).from_table as JsonNode).alias).toBe('students');
		expect(((template.subquery as JsonNode).node as JsonNode).from_table).toMatchObject({ table_name: 'placeholder' });
	});

	it('leaves CTE references alone but rewrites real tables inside CTE definitions', () => {
		const statement = select(table('students'), {
			cte_map: { map: [{ key: 'students', value: { query_node: { type: 'SELECT_NODE', from_table: table('students') } } }] }
		});
		const replace = vi.fn((_r, node: JsonNode) => filteredRef(template, node));
		const out = rewriteTables(statement, replace);
		expect(replace).toHaveBeenCalledTimes(1);
		const node = out.node as JsonNode;
		expect((node.from_table as JsonNode).type).toBe('BASE_TABLE');
		const map = (node.cte_map as { map: { value: { query_node: JsonNode } }[] }).map;
		expect((map[0]!.value.query_node.from_table as JsonNode).type).toBe('SUBQUERY');
	});

	it('does not walk into replacements', () => {
		const replace = vi.fn((_r, node: JsonNode) => filteredRef(template, node));
		rewriteTables(select(table('students')), replace);
		expect(replace).toHaveBeenCalledTimes(1);
	});
});

describe('parseSelect', () => {
	it('accepts one SELECT and zeroes the unrepresentable query_location sentinel', async () => {
		serialized('{"error":false,"statements":[{"node":{"type":"SELECT_NODE","query_location":18446744073709551615}}]}');
		const outcome = await parseSelect('select 1 /* sentinel */');
		expect(outcome).toEqual({ ok: true, statement: { node: { type: 'SELECT_NODE', query_location: 0 } } });
	});

	it('rejects non-SELECT statements and multiple statements', async () => {
		serialized({ error: true, error_type: 'not implemented', error_message: 'x' });
		expect(await parseSelect('drop table x')).toMatchObject({ ok: false, reason: 'not-select' });
		serialized({ error: false, statements: [{}, {}] });
		expect(await parseSelect('select 1; select 2')).toMatchObject({ ok: false, reason: 'not-select' });
	});

	it("doesn't cache a failure to run the parser", async () => {
		vi.mocked(runQuery).mockResolvedValueOnce({ rows: [], columns: [], error: 'down' });
		expect(await parseSelect('select 3')).toMatchObject({ ok: false, reason: 'parse-error' });
		serialized({ error: false, statements: [{ node: { type: 'SELECT_NODE' } }] });
		expect(await parseSelect('select 3')).toMatchObject({ ok: true });
	});
});

describe('filterTemplate', () => {
	it('rejects a predicate that escapes the WHERE clause', async () => {
		serialized({
			error: false,
			statements: [{ node: { type: 'SELECT_NODE', from_table: { type: 'JOIN' } } }]
		});
		await expect(filterTemplate('1=1) AS x, students AS y --')).rejects.toThrow(/single WHERE condition/);
	});
});
