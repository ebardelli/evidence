import { describe, expect, it } from 'vitest';
import { scaleOptionFontSizes } from './scale-option-font-sizes';

describe('scaleOptionFontSizes', () => {
	it('returns the same reference when scale is 1', () => {
		const option = { title: { textStyle: { fontSize: 14 } } };
		expect(scaleOptionFontSizes(option, 1)).toBe(option);
	});

	it('multiplies fontSize wherever it appears, nested at any depth', () => {
		const option = {
			title: { textStyle: { fontSize: 14, color: 'red' }, subtextStyle: { fontSize: 13 } },
			tooltip: { textStyle: { fontSize: 12 } },
			legend: { textStyle: { fontSize: 12 } }
		};

		expect(scaleOptionFontSizes(option, 2)).toEqual({
			title: { textStyle: { fontSize: 28, color: 'red' }, subtextStyle: { fontSize: 26 } },
			tooltip: { textStyle: { fontSize: 24 } },
			legend: { textStyle: { fontSize: 24 } }
		});
	});

	it('scales fontSize inside arrays, e.g. multiple axes or series', () => {
		const option = {
			xAxis: [{ axisLabel: { fontSize: 12 } }, { axisLabel: { fontSize: 10 } }],
			series: [{ label: { fontSize: 12 } }, { type: 'pie', label: { fontSize: 14 } }]
		};

		expect(scaleOptionFontSizes(option, 1.5)).toEqual({
			xAxis: [{ axisLabel: { fontSize: 18 } }, { axisLabel: { fontSize: 15 } }],
			series: [{ label: { fontSize: 18 } }, { type: 'pie', label: { fontSize: 21 } }]
		});
	});

	it('leaves non-fontSize numeric fields untouched', () => {
		const option = { grid: { bottom: 40 }, title: { textStyle: { fontSize: 14 } } };
		expect(scaleOptionFontSizes(option, 2)).toEqual({
			grid: { bottom: 40 },
			title: { textStyle: { fontSize: 28 } }
		});
	});

	it('handles null and primitive values without throwing', () => {
		expect(scaleOptionFontSizes(null, 2)).toBe(null);
		expect(scaleOptionFontSizes(undefined, 2)).toBe(undefined);
		expect(scaleOptionFontSizes(5, 2)).toBe(5);
		expect(scaleOptionFontSizes('fontSize', 2)).toBe('fontSize');
	});

	it('does not mutate the input option', () => {
		const option = { title: { textStyle: { fontSize: 14 } } };
		const scaled = scaleOptionFontSizes(option, 2);
		expect(option.title.textStyle.fontSize).toBe(14);
		expect(scaled).not.toBe(option);
	});
});
