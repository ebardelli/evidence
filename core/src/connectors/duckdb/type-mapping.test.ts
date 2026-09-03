import { describe, it, expect } from 'vitest';
import { getDuckDBToJsType } from './type-mapping';

describe('getDuckDBToJsType', () => {
	it('maps the underscored @duckdb/node-api spellings of tz types to date', () => {
		expect(getDuckDBToJsType('TIMESTAMP_TZ')).toBe('date');
		expect(getDuckDBToJsType('TIME_TZ')).toBe('date');
		expect(getDuckDBToJsType('timestamp_tz')).toBe('date');
	});

	it('keeps other underscored types MotherDuck already knows', () => {
		expect(getDuckDBToJsType('TIMESTAMP_NS')).toBe('date');
		expect(getDuckDBToJsType('TIMESTAMP_MS')).toBe('date');
	});

	it('defers to the MotherDuck mapping for everything else', () => {
		expect(getDuckDBToJsType('DECIMAL(18,2)')).toBe('number');
		expect(getDuckDBToJsType('INTEGER[]')).toBe('object');
		expect(getDuckDBToJsType('VARCHAR')).toBe('string');
		expect(getDuckDBToJsType('WHATEVER')).toBe('unknown');
	});
});
