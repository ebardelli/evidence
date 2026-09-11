// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

	it('scales up font size for tall, chart/table-dominated captures whose height barely reacts to font size', async () => {
		const { downloadPng } = await import('./png-download');
		const target = document.createElement('div');
		target.setAttribute('data-markdoc-content', '');

		const width = 800;
		const naturalHeight = 4000; // height:width = 5, above the probing threshold
		// Height barely grows with font scale (fixed-pixel charts/tables) — scaling
		// up should keep paying off (better `scale / height`) all the way to the cap.
		Object.defineProperty(target, 'getBoundingClientRect', {
			value: () => {
				const raw = target.style.getPropertyValue('--png-export-font-scale');
				const scale = raw === '' ? 1 : Number(raw);
				return { width, height: naturalHeight + (scale - 1) * 100 };
			}
		});
		document.body.appendChild(target);

		let scaleDuringCapture: string | null = null;
		toPngMock.mockImplementation((el: HTMLElement) => {
			scaleDuringCapture = el.style.getPropertyValue('--png-export-font-scale');
			return Promise.resolve('data:image/png;base64,capture');
		});

		await downloadPng({ filename: 'report' });

		expect(scaleDuringCapture).not.toBe('');
		expect(Number(scaleDuringCapture)).toBe(4); // hits MAX_EXPORT_FONT_SCALE, not an arbitrary small cap
		expect(target.style.getPropertyValue('--png-export-font-scale')).toBe('');
	});

	it('leaves font size at 1x for tall, prose-dominated captures where growing it would not help', async () => {
		const { downloadPng } = await import('./png-download');
		const target = document.createElement('div');
		target.setAttribute('data-markdoc-content', '');

		const width = 800;
		const naturalHeight = 4000; // height:width = 5, above the probing threshold
		// Reflowing paragraph text: height grows roughly with scale^2, so it grows
		// *faster* than the font — scaling never improves `scale / height`.
		Object.defineProperty(target, 'getBoundingClientRect', {
			value: () => {
				const raw = target.style.getPropertyValue('--png-export-font-scale');
				const scale = raw === '' ? 1 : Number(raw);
				return { width, height: naturalHeight * scale ** 2 };
			}
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
			expect.objectContaining({ width: 820, height: naturalHeight + 20 })
		);
	});

	it('does not push a tall capture past the cross-browser canvas pixel budget', async () => {
		const { downloadPng } = await import('./png-download');
		const target = document.createElement('div');
		target.setAttribute('data-markdoc-content', '');

		const width = 800;
		const naturalHeight = 6000; // height:width = 7.5, above the probing threshold
		// Height barely reacts to scale (so `scale / height` would otherwise keep
		// improving all the way to the 4x cap), but growing it that far would push
		// height * pixelRatio(2) past the 14000px budget partway through — at the
		// scale=3.0518 step (naturalHeight + 2.0518*600 = 7231 → *2 = 14462 > 14000),
		// while the prior step (scale=2.4414 → height 6865 → *2 = 13730) still fits.
		Object.defineProperty(target, 'getBoundingClientRect', {
			value: () => {
				const raw = target.style.getPropertyValue('--png-export-font-scale');
				const scale = raw === '' ? 1 : Number(raw);
				return { width, height: naturalHeight + (scale - 1) * 600 };
			}
		});
		document.body.appendChild(target);

		let scaleDuringCapture: string | null = null;
		let heightDuringCapture = 0;
		toPngMock.mockImplementation((el: HTMLElement) => {
			scaleDuringCapture = el.style.getPropertyValue('--png-export-font-scale');
			heightDuringCapture = el.getBoundingClientRect().height;
			return Promise.resolve('data:image/png;base64,capture');
		});

		await downloadPng({ filename: 'report' });

		expect(heightDuringCapture * 2).toBeLessThanOrEqual(14000);
		expect(Number(scaleDuringCapture)).toBeCloseTo(1.25 ** 4, 5); // stopped one step short of the cap
		expect(Number(scaleDuringCapture)).toBeLessThan(4);
		expect(target.style.getPropertyValue('--png-export-font-scale')).toBe('');
	});
});
