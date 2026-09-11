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

	it('scales up font size for tall captures, then measures and reverts', async () => {
		const { downloadPng } = await import('./png-download');
		const target = document.createElement('div');
		target.setAttribute('data-markdoc-content', '');

		const naturalWidth = 800;
		const naturalHeight = 4000; // height:width = 5, above the scale-up threshold
		const scaledHeight = 4800; // simulates the reflow once the font grows

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

		expect(scaleDuringCapture).not.toBe('');
		expect(Number(scaleDuringCapture)).toBeGreaterThan(1);
		expect(target.style.getPropertyValue('--png-export-font-scale')).toBe('');
		expect(toPngMock).toHaveBeenCalledWith(
			target,
			expect.objectContaining({
				width: Math.ceil(naturalWidth) + 20,
				height: Math.ceil(scaledHeight) + 20
			})
		);
	});
});
