import type { ECharts } from 'echarts';

/**
 * Registry connecting a host-rendered chart's DOM node to its live ECharts
 * instance. Used by the parent's PNG export path to find every chart on the
 * page being exported and temporarily bump its text size (see
 * scale-option-font-sizes.ts) before capture, without needing every chart
 * component to individually expose its instance.
 *
 * WeakMap-keyed so a forgotten unregister doesn't leak; node GC takes the
 * entry with it. Mirrors sandbox/png-capture-registry.ts's pattern for the
 * sandboxed-iframe case.
 */

const ATTR = 'data-echarts-instance';

const registry = new WeakMap<HTMLElement, ECharts>();

export function registerChartInstance(node: HTMLElement, chart: ECharts): void {
	registry.set(node, chart);
	node.setAttribute(ATTR, '');
}

export function unregisterChartInstance(node: HTMLElement): void {
	registry.delete(node);
	node.removeAttribute(ATTR);
}

export function findChartInstances(root: HTMLElement): ECharts[] {
	const nodes = Array.from(root.querySelectorAll<HTMLElement>(`[${ATTR}]`));
	const instances: ECharts[] = [];
	for (const node of nodes) {
		const instance = registry.get(node);
		if (instance) instances.push(instance);
	}
	return instances;
}
