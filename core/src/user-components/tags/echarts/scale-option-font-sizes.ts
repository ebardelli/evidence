/**
 * Recursively multiplies every numeric `fontSize` found anywhere in an
 * ECharts option object (title, axis labels on any axis, legend, tooltip,
 * series labels, visualMap, dataZoom, calendar labels, ...) by `scale`.
 *
 * ECharts renders all its text as literal pixel values baked into option
 * objects — none of it is reachable via CSS/font-size. Walking the option
 * generically (rather than hand-enumerating every possible path) means this
 * works regardless of chart type and doesn't require knowing ECharts' many
 * per-component default font sizes: pass in the chart's own currently
 * resolved option (`chart.getOption()`, which already reflects theme +
 * series defaults) and only the sizes actually present get scaled.
 */
export function scaleOptionFontSizes<T>(option: T, scale: number): T {
	if (scale === 1 || option === null || typeof option !== 'object') {
		return option;
	}

	if (Array.isArray(option)) {
		return option.map((item) => scaleOptionFontSizes(item, scale)) as unknown as T;
	}

	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(option as Record<string, unknown>)) {
		result[key] =
			key === 'fontSize' && typeof value === 'number'
				? value * scale
				: scaleOptionFontSizes(value, scale);
	}
	return result as T;
}
