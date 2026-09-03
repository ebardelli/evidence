import {
	COMMON_AGGREGATION_FUNCTIONS,
	COMMON_FUNCTION_TYPE_RULES,
	COMMON_NON_AGG_FUNCTIONS,
	NUMERIC_RULE,
	isSimpleIdentifier,
	wrapWithLimit,
	escapeAnsiStringLiteral,
	type DialectFunctionTypeRule,
	type SqlDialect,
	NO_CONDITIONAL_AGGREGATES
} from './common';

/**
 * Local/embedded DuckDB dialect.
 *
 * Identical SQL surface to the MotherDuck (cloud DuckDB) dialect — same
 * engine, same syntax — differing only in `name`, so connections can
 * distinguish a local DuckDB file/connection from a MotherDuck warehouse.
 */
export class DuckDBDialect implements SqlDialect {
	readonly name = 'duckdb';

	dateGrain(grain: string, column: string, _firstDayOfWeek: 'sunday' | 'monday'): string {
		switch (grain) {
			case 'day':
				return `DATE_TRUNC('day', ${column})`;
			case 'week':
				return `DATE_TRUNC('week', ${column})`;
			case 'month':
				return `DATE_TRUNC('month', ${column})`;
			case 'quarter':
				return `DATE_TRUNC('quarter', ${column})`;
			case 'year':
				return `DATE_TRUNC('year', ${column})`;
			case 'hour':
				return `DATE_TRUNC('hour', ${column})`;
			case 'day of week':
				return `DAYOFWEEK(${column})`;
			case 'day of month':
				return `DAYOFMONTH(${column})`;
			case 'day of year':
				return `DAYOFYEAR(${column})`;
			case 'week of year':
				return `WEEKOFYEAR(${column})`;
			case 'month of year':
				return `MONTH(${column})`;
			case 'quarter of year':
				return `QUARTER(${column})`;
			default:
				return column;
		}
	}

	dateAdd(unit: string, amount: number | string, column: string): string {
		return `${column} + to_${unit.toLowerCase()}s(${amount})`;
	}

	dateSub(unit: string, amount: number | string, column: string): string {
		return `${column} - to_${unit.toLowerCase()}s(${amount})`;
	}

	shortDateLabel(column: string): string {
		return `strftime(${column}, '%b %-d/%y')`;
	}

	dateLiteral(isoDate: string): string {
		return `DATE '${isoDate}'`;
	}

	castToString(column: string): string {
		return `CAST(${column} AS VARCHAR)`;
	}

	countDistinct(column: string): string {
		return `COUNT(DISTINCT ${column})`;
	}

	limitOffset(limit: number, offset?: number): string {
		if (offset !== undefined && offset !== 0) {
			return `LIMIT ${limit} OFFSET ${offset}`;
		}
		return `LIMIT ${limit}`;
	}

	applyRowLimit(sql: string, limit: number): string {
		return wrapWithLimit(sql, limit);
	}

	rowLimitClause({ limit, offset }: { limit?: number; offset?: number; hasOrderBy: boolean }): string {
		const parts: string[] = [];
		if (limit !== undefined) parts.push(`LIMIT ${limit}`);
		if (offset !== undefined) parts.push(`OFFSET ${offset}`);
		return parts.join(' ');
	}

	groupByAll(_groupingExpressions: string[]): string {
		return 'GROUP BY ALL';
	}

	anyValue(expr: string): string {
		return `ANY_VALUE(${expr})`;
	}

	groupArray(sortKey: string, valueKey: string): string {
		return `to_json(list(json_array(${sortKey}, ${valueKey}) ORDER BY ${sortKey}))`;
	}

	formatAlias(alias: string): string {
		return alias.toLowerCase();
	}

	quoteAlias(alias: string): string {
		return `"${alias.replace(/"/g, '""')}"`;
	}

	readonly escapesBackslashInIdentifiers = false;

	quoteIdentifierIfNeeded(identifier: string): string {
		return isSimpleIdentifier(identifier) ? identifier : this.quoteAlias(identifier);
	}

	escapeStringLiteral(value: string): string {
		return escapeAnsiStringLiteral(value);
	}

	nullSafeEqual(a: string, b: string): string {
		return `${a} IS NOT DISTINCT FROM ${b}`;
	}

	iff(cond: string, a: string, b: string): string {
		return `CASE WHEN ${cond} THEN ${a} ELSE ${b} END`;
	}

	concat(parts: string[]): string {
		return parts.join(' || ');
	}

	caseInsensitiveLike(column: string, pattern: string): string {
		return `${column} ILIKE '${pattern}'`;
	}

	readonly caseInsensitiveIdentifiers = true;
	readonly supportsFilterClause = true;
	readonly conditionalAggregateFunctions = NO_CONDITIONAL_AGGREGATES;
	readonly strictDerivedTables = false;
	readonly supportsGroupingSets = true;
	readonly supportsDateOffsetMath = true;

	readonly aggregationFunctions = new Set<string>([
		...COMMON_AGGREGATION_FUNCTIONS,
		'LIST',
		'ARRAY_AGG',
		'STRING_AGG',
		'ANY_VALUE',
		'APPROX_COUNT_DISTINCT',
		'QUANTILE',
		'QUANTILE_CONT',
		'QUANTILE_DISC',
		'MODE',
		'ARG_MIN',
		'ARG_MAX',
		'BOOL_AND',
		'BOOL_OR',
		'COUNT_IF',
		'FIRST',
		'LAST',
		'PRODUCT',
		'BIT_AND',
		'BIT_OR',
		'BIT_XOR',
		'KURTOSIS',
		'SKEWNESS',
		'ENTROPY',
		'HISTOGRAM'
	]);

	readonly nonAggregationFunctions = new Set<string>([
		...COMMON_NON_AGG_FUNCTIONS,
		'DATE_PART',
		'DATE_DIFF',
		'DATE_ADD',
		'DATE_SUB',
		'STRFTIME',
		'STRPTIME',
		'EPOCH',
		'EPOCH_MS',
		'MAKE_DATE',
		'MAKE_TIMESTAMP',
		'LAST_DAY',
		'MONTHNAME',
		'DAYNAME',
		'DAYOFWEEK',
		'DAYOFMONTH',
		'DAYOFYEAR',
		'WEEKOFYEAR',
		'ISODOW',
		'TO_DAYS',
		'TO_WEEKS',
		'TO_MONTHS',
		'TO_QUARTERS',
		'TO_YEARS',
		'TO_HOURS',
		'TO_MINUTES',
		'TO_SECONDS',
		'TRY_CAST',
		'LEN',
		'LENGTH',
		'CONTAINS',
		'STARTS_WITH',
		'ENDS_WITH',
		'SPLIT_PART',
		'STR_SPLIT',
		'REGEXP_MATCHES',
		'REGEXP_REPLACE',
		'REGEXP_EXTRACT',
		'LPAD',
		'RPAD',
		'REVERSE',
		'LIST_VALUE',
		'STRUCT_PACK',
		'JSON_ARRAY',
		'TO_JSON',
		'JSON_EXTRACT',
		'JSON_VALUE'
	]);

	readonly functionTypeRules: Readonly<Record<string, ReadonlySet<DialectFunctionTypeRule>>> = {
		...COMMON_FUNCTION_TYPE_RULES,
		QUANTILE: new Set(NUMERIC_RULE),
		QUANTILE_CONT: new Set(NUMERIC_RULE),
		QUANTILE_DISC: new Set(NUMERIC_RULE)
	};
}
