// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	registerSandboxFrameCapture,
	unregisterSandboxFrameCapture
} from '../user-components/sandbox/png-capture-registry';
import {
	registerChartInstance,
	unregisterChartInstance
} from '../user-components/tags/echarts/chart-instance-registry';

const { toPngMock } = vi.hoisted(() => ({
	toPngMock: vi.fn()
}));

vi.mock('html-to-image', () => ({
	toPng: toPngMock
}));

vi.mock('svelte-sonner', () => ({
	toast: {
		loading: vi.fn(() => 'loading-toast'),
		dismiss: vi.fn(),
		success: vi.fn(),
		error: vi.fn()
	}
}));

describe('downloadPng', () => {
	let clickSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		document.body.innerHTML = '';
		toPngMock.mockReset();
		toPngMock.mockResolvedValue('data:image/png;base64,capture');
		clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
	});

	afterEach(() => {
		clickSpy.mockRestore();
	});

	it('does not force credentialed fetches when capturing images', async () => {
		const { downloadPng } = await import('./png-download');
		const target = document.createElement('div');
		target.setAttribute('data-markdoc-content', '');
		Object.defineProperty(target, 'getBoundingClientRect', {
			value: () => ({ width: 100, height: 50 })
		});

		const image = document.createElement('img');
		image.setAttribute('src', 'https://example.public.blob.vercel-storage.com/images/foo.png');
		image.setAttribute(
			'srcset',
			'https://example.public.blob.vercel-storage.com/images/foo-2x.png 2x'
		);
		image.setAttribute('sizes', '100vw');
		target.appendChild(image);
		document.body.appendChild(target);

		await downloadPng({ filename: 'report' });

		expect(toPngMock).toHaveBeenCalledWith(
			target,
			expect.not.objectContaining({
				fetchRequestInit: expect.anything()
			})
		);
		expect(image.getAttribute('src')).toBe(
			'https://example.public.blob.vercel-storage.com/images/foo.png'
		);
		expect(image.getAttribute('srcset')).toBe(
			'https://example.public.blob.vercel-storage.com/images/foo-2x.png 2x'
		);
		expect(image.getAttribute('sizes')).toBe('100vw');
		expect(clickSpy).toHaveBeenCalledOnce();
	});

	it('leaves font size untouched for normal aspect-ratio captures', async () => {
		const { downloadPng } = await import('./png-download');
		const target = document.createElement('div');
		target.setAttribute('data-markdoc-content', '');
		Object.defineProperty(target, 'getBoundingClientRect', {
			value: () => ({ width: 800, height: 600 })
		});
		document.body.appendChild(target);

		let scaleDuringCapture: string | null = null;
		toPngMock.mockImplementation((el: HTMLElement) => {
			scaleDuringCapture = el.style.getPropertyValue('--png-export-font-scale');
			return Promise.resolve('data:image/png;base64,capture');
		});

		await downloadPng({ filename: 'report' });

		expect(scaleDuringCapture).toBe('');
		expect(target.style.getPropertyValue('--png-export-font-scale')).toBe('');
		expect(toPngMock).toHaveBeenCalledWith(
			target,
			expect.objectContaining({ width: 820, height: 620 })
		);
	});

	it('scales font size for tall captures, remeasures, and reverts', async () => {
		const { downloadPng } = await import('./png-download');
		const target = document.createElement('div');
		target.setAttribute('data-markdoc-content', '');

		const naturalWidth = 800;
		const naturalHeight = 2400; // aspect ratio 3, above the 1.5 threshold, below the scale cap
		const scaledHeight = 2900; // simulates the reflow once the font grows

		Object.defineProperty(target, 'getBoundingClientRect', {
			value: () => {
				const scaled = target.style.getPropertyValue('--png-export-font-scale') !== '';
				return { width: naturalWidth, height: scaled ? scaledHeight : naturalHeight };
			}
		});
		document.body.appendChild(target);

		let scaleDuringCapture: string | null = null;
		toPngMock.mockImplementation((el: HTMLElement) => {
			scaleDuringCapture = el.style.getPropertyValue('--png-export-font-scale');
			return Promise.resolve('data:image/png;base64,capture');
		});

		await downloadPng({ filename: 'report' });

		// fontScale = aspectRatio / REFERENCE_ASPECT_RATIO = 3 / 1.5 = 2
		const expectedScale = 2;
		expect(Number(scaleDuringCapture)).toBeCloseTo(expectedScale, 5);
		expect(target.style.getPropertyValue('--png-export-font-scale')).toBe('');
		expect(toPngMock).toHaveBeenCalledWith(
			target,
			expect.objectContaining({
				width: Math.ceil(naturalWidth) + 20,
				height: Math.ceil(scaledHeight) + 20
			})
		);
	});

	it('caps font scale for extremely tall reports instead of scaling without bound', async () => {
		const { downloadPng } = await import('./png-download');
		const target = document.createElement('div');
		target.setAttribute('data-markdoc-content', '');
		Object.defineProperty(target, 'getBoundingClientRect', {
			value: () => ({ width: 800, height: 20000 }) // aspect ratio 25
		});
		document.body.appendChild(target);

		let scaleDuringCapture: string | null = null;
		toPngMock.mockImplementation((el: HTMLElement) => {
			scaleDuringCapture = el.style.getPropertyValue('--png-export-font-scale');
			return Promise.resolve('data:image/png;base64,capture');
		});

		await downloadPng({ filename: 'report' });

		expect(Number(scaleDuringCapture)).toBe(3); // MAX_EXPORT_FONT_SCALE, not aspectRatio/1.5 (~16.7)
	});

	it('scales every host chart instance found in the capture root, then restores the original option', async () => {
		const { downloadPng } = await import('./png-download');
		const target = document.createElement('div');
		target.setAttribute('data-markdoc-content', '');
		Object.defineProperty(target, 'getBoundingClientRect', {
			value: () => ({ width: 800, height: 2400 }) // aspect ratio 3 -> scale 3/1.5 = 2
		});

		const chartContainer = document.createElement('div');
		target.appendChild(chartContainer);
		document.body.appendChild(target);

		const originalOption = { title: { textStyle: { fontSize: 14 } } };
		let currentOption = originalOption;
		let optionDuringCapture: unknown;
		const fakeChart = {
			getOption: vi.fn(() => currentOption),
			setOption: vi.fn((opt: unknown) => {
				currentOption = opt as typeof originalOption;
			}),
			isDisposed: () => false
		};
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		registerChartInstance(chartContainer, fakeChart as any);

		toPngMock.mockImplementation(() => {
			optionDuringCapture = currentOption;
			return Promise.resolve('data:image/png;base64,capture');
		});

		try {
			await downloadPng({ filename: 'report' });
		} finally {
			unregisterChartInstance(chartContainer);
		}

		expect(fakeChart.setOption).toHaveBeenCalledTimes(2); // apply, then revert
		expect(optionDuringCapture).toEqual({ title: { textStyle: { fontSize: 14 * 2 } } });
		expect(currentOption).toEqual(originalOption); // reverted after capture
	});

	it('captures sandboxed iframes with the same fontScale used for the rest of the page', async () => {
		const { downloadPng } = await import('./png-download');
		const target = document.createElement('div');
		target.setAttribute('data-markdoc-content', '');
		Object.defineProperty(target, 'getBoundingClientRect', {
			value: () => ({ width: 800, height: 2400 }) // aspect ratio 3 -> scale 3/1.5 = 2
		});

		const wrapper = document.createElement('div');
		wrapper.style.position = 'relative';
		Object.defineProperty(wrapper, 'getBoundingClientRect', {
			value: () => ({ left: 0, top: 0, width: 400, height: 300 })
		});

		const iframe = document.createElement('iframe');
		Object.defineProperty(iframe, 'getBoundingClientRect', {
			value: () => ({ left: 0, top: 0, width: 400, height: 300 })
		});
		wrapper.appendChild(iframe);
		target.appendChild(wrapper);
		document.body.appendChild(target);

		let capturedArgs: [number, number | undefined] | undefined;
		const captureFn = vi.fn(async (pixelRatio: number, fontScale?: number) => {
			capturedArgs = [pixelRatio, fontScale];
			return 'data:image/png;base64,chart';
		});
		registerSandboxFrameCapture(iframe, captureFn);

		try {
			await downloadPng({ filename: 'report' });
		} finally {
			unregisterSandboxFrameCapture(iframe);
		}

		expect(captureFn).toHaveBeenCalledOnce();
		expect(capturedArgs?.[0]).toBe(2); // base pixelRatio, unaffected by font scale
		expect(capturedArgs?.[1]).toBeCloseTo(2, 5);
	});
});
