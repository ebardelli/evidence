// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	registerSandboxFrameCapture,
	unregisterSandboxFrameCapture
} from '../user-components/sandbox/png-capture-registry';

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

	it('captures at natural size (no zoom) for normal aspect-ratio reports', async () => {
		const { downloadPng } = await import('./png-download');
		const target = document.createElement('div');
		target.setAttribute('data-markdoc-content', '');
		Object.defineProperty(target, 'getBoundingClientRect', {
			value: () => ({ width: 800, height: 600 })
		});
		document.body.appendChild(target);

		await downloadPng({ filename: 'report' });

		expect(toPngMock).toHaveBeenCalledWith(
			target,
			expect.objectContaining({
				width: 820,
				height: 620,
				canvasWidth: 820,
				canvasHeight: 620
			})
		);
	});

	it('zooms the whole capture for tall reports, without changing the node size passed to html-to-image', async () => {
		const { downloadPng } = await import('./png-download');
		const target = document.createElement('div');
		target.setAttribute('data-markdoc-content', '');
		Object.defineProperty(target, 'getBoundingClientRect', {
			value: () => ({ width: 800, height: 4000 }) // aspect ratio 5, above the 1.5 threshold
		});
		document.body.appendChild(target);

		await downloadPng({ filename: 'report' });

		// zoom = 1 + (5 - 1.5) * 0.25 = 1.875
		const expectedZoom = 1.875;
		expect(toPngMock).toHaveBeenCalledWith(
			target,
			expect.objectContaining({
				width: 820, // unchanged: the node itself is never resized/reflowed
				height: 4020,
				canvasWidth: 820 * expectedZoom,
				canvasHeight: 4020 * expectedZoom
			})
		);
	});

	it('caps zoom for extremely tall reports instead of scaling it without bound', async () => {
		const { downloadPng } = await import('./png-download');
		const target = document.createElement('div');
		target.setAttribute('data-markdoc-content', '');
		Object.defineProperty(target, 'getBoundingClientRect', {
			value: () => ({ width: 800, height: 20000 }) // aspect ratio 25
		});
		document.body.appendChild(target);

		await downloadPng({ filename: 'report' });

		const maxZoom = 2.5;
		expect(toPngMock).toHaveBeenCalledWith(
			target,
			expect.objectContaining({
				width: 820,
				height: 20020,
				canvasWidth: 820 * maxZoom,
				canvasHeight: 20020 * maxZoom
			})
		);
	});

	it('captures sandboxed iframes at the final effective resolution (pixelRatio * zoom), not the base pixelRatio', async () => {
		const { downloadPng } = await import('./png-download');
		const target = document.createElement('div');
		target.setAttribute('data-markdoc-content', '');
		Object.defineProperty(target, 'getBoundingClientRect', {
			value: () => ({ width: 800, height: 4000 }) // aspect ratio 5 -> zoom 1.875
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

		let capturedPixelRatio: number | undefined;
		const captureFn = vi.fn(async (pixelRatio: number) => {
			capturedPixelRatio = pixelRatio;
			return 'data:image/png;base64,chart';
		});
		registerSandboxFrameCapture(iframe, captureFn);

		try {
			await downloadPng({ filename: 'report' });
		} finally {
			unregisterSandboxFrameCapture(iframe);
		}

		expect(captureFn).toHaveBeenCalledOnce();
		// base pixelRatio (2) * zoom (1.875) = 3.75, not just the base 2
		expect(capturedPixelRatio).toBeCloseTo(3.75, 5);
	});
});
