import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import {
	isPageDownloadEnabled,
	pageWidthMaxWidth,
	projectRootPageFrontmatterSchema
} from './page-frontmatter-schema';

const downIsGood = (frontmatter: string) =>
	projectRootPageFrontmatterSchema.parse(yaml.load(frontmatter)).down_is_good;

describe('down_is_good frontmatter', () => {
	it.each([
		['down_is_good: true', true],
		['down_is_good: false', false],
		['down_is_good: "false"', false],
		["down_is_good: 'true'", true],
		['down_is_good: "TRUE"', true],
		['down_is_good: yes', undefined],
		['down_is_good: 1', undefined],
		['title: Costs', undefined]
	])('%s → %s', (frontmatter, expected) => {
		expect(downIsGood(frontmatter)).toBe(expected);
	});
});

const parseDownloads = (downloads: unknown) =>
	projectRootPageFrontmatterSchema.parse({ downloads }).downloads;

describe('isPageDownloadEnabled', () => {
	it('enables every kind when downloads is unset', () => {
		expect(isPageDownloadEnabled(undefined, 'pdf')).toBe(true);
		expect(isPageDownloadEnabled(null, 'data')).toBe(true);
	});

	it('`downloads: false` disables every kind', () => {
		const downloads = parseDownloads(false);
		expect(isPageDownloadEnabled(downloads, 'pdf')).toBe(false);
		expect(isPageDownloadEnabled(downloads, 'data')).toBe(false);
		expect(isPageDownloadEnabled(downloads, 'image')).toBe(false);
	});

	it('the object form disables only the listed kinds', () => {
		const downloads = parseDownloads({ pdf: false });
		expect(isPageDownloadEnabled(downloads, 'pdf')).toBe(false);
		expect(isPageDownloadEnabled(downloads, 'data')).toBe(true);
		expect(isPageDownloadEnabled(downloads, 'image')).toBe(true);
	});

	it('`excel: false` hides only the Excel report', () => {
		const downloads = parseDownloads({ excel: false });
		expect(isPageDownloadEnabled(downloads, 'excel')).toBe(false);
		expect(isPageDownloadEnabled(downloads, 'data')).toBe(true);
		expect(isPageDownloadEnabled(downloads, 'image')).toBe(true);
	});

	it('hides the Excel report when image or data is off, since it contains both', () => {
		expect(isPageDownloadEnabled(parseDownloads({ image: false }), 'excel')).toBe(false);
		expect(isPageDownloadEnabled(parseDownloads({ data: false }), 'excel')).toBe(false);
		expect(isPageDownloadEnabled(parseDownloads({ image: false, excel: true }), 'excel')).toBe(
			false
		);
		expect(isPageDownloadEnabled(parseDownloads({ pdf: false }), 'excel')).toBe(true);
		expect(isPageDownloadEnabled(parseDownloads(false), 'excel')).toBe(false);
		expect(isPageDownloadEnabled(undefined, 'excel')).toBe(true);
	});

	it('ignores a malformed per-kind value instead of the whole object', () => {
		const downloads = parseDownloads({ pdf: false, data: 'no' });
		expect(isPageDownloadEnabled(downloads, 'pdf')).toBe(false);
		expect(isPageDownloadEnabled(downloads, 'data')).toBe(true);
	});

	it('leaves downloads on for an unparseable value', () => {
		expect(isPageDownloadEnabled(parseDownloads('nope'), 'pdf')).toBe(true);
	});
});

const pageWidth = (frontmatter: string) =>
	projectRootPageFrontmatterSchema.parse(yaml.load(frontmatter)).page_width;

describe('page_width frontmatter', () => {
	it.each([
		['page_width: article', 'article'],
		['page_width: full', 'full'],
		['page_width: 1200', 1200],
		['page_width: 80rem', '80rem'],
		['page_width: " 1400PX "', '1400px'],
		['page_width: 90%', '90%'],
		['page_width: "1200"', '1200'],
		['page_width: wide', undefined],
		['page_width: 0', undefined],
		['page_width: -5', undefined],
		['page_width: 80 rem', undefined],
		['title: Costs', undefined]
	])('%s → %s', (frontmatter, expected) => {
		expect(pageWidth(frontmatter)).toBe(expected);
	});
});

describe('pageWidthMaxWidth', () => {
	it.each([
		[undefined, '64rem'],
		['article', '64rem'],
		['full', undefined],
		[1200, '1200px'],
		['1200', '1200px'],
		['80rem', '80rem'],
		['90%', '90%']
	] as const)('%s → %s', (width, expected) => {
		expect(pageWidthMaxWidth(width)).toBe(expected);
	});
});
