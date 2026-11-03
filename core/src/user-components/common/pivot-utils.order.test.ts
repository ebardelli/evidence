import { describe, it, expect } from 'vitest';
import { generatePivotData, type PivotConfig } from './pivot-utils';
import type { UnifiedColumnDefinition } from '../tags/table/unified-column-definition.types';

function makeColumns(order?: string[], sort?: 'asc' | 'desc'): UnifiedColumnDefinition[] {
	return [
		{ type: 'dimension', sqlWithAlias: 'item', alias: 'item', columnIdForRendering: 'item' },
		{ type: 'pivot', sqlWithAlias: 'grp', alias: 'grp', columnIdForRendering: 'grp', order, sort },
		{
			type: 'measure',
			sqlWithAlias: 'sum(value) AS value',
			alias: 'value',
			columnIdForRendering: 'value',
			sqlWithoutAlias: 'sum(value)'
		}
	];
}

const data = ['Delta', 'Alpha', 'Charlie', 'Bravo'].map((grp, i) => ({ item: 'x', grp, value: i }));

function pivotColumnOrder(order?: string[], sort?: 'asc' | 'desc', measuresFirst = false) {
	const config: PivotConfig = {
		dimensions: ['item'],
		pivots: ['grp'],
		measures: ['value'],
		measuresFirst,
		subtotals: false,
		columnTypes: new Map([
			['item', 'string'],
			['grp', 'string'],
			['value', 'number']
		]),
		unifiedColumns: makeColumns(order, sort)
	};
	return generatePivotData(data, config)
		.columnMeta.filter((c) => c.columnType === 'measure')
		.map((c) => c.parts.find((p) => p !== 'value'));
}

describe('generatePivotData: pivot order', () => {
	it('sorts pivot columns alphabetically by default', () => {
		expect(pivotColumnOrder()).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
	});

	it('puts listed values first in the given order, then the rest by sort', () => {
		expect(pivotColumnOrder(['Delta', 'Bravo'])).toEqual(['Delta', 'Bravo', 'Alpha', 'Charlie']);
		expect(pivotColumnOrder(['Delta', 'Bravo'], 'desc')).toEqual([
			'Delta',
			'Bravo',
			'Charlie',
			'Alpha'
		]);
	});

	it('applies the order when measures come first', () => {
		expect(pivotColumnOrder(['Charlie', 'Alpha'], undefined, true)).toEqual([
			'Charlie',
			'Alpha',
			'Bravo',
			'Delta'
		]);
	});
});
