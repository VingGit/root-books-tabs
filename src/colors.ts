import { Notice, TFile, normalizePath } from 'obsidian';
import type ScopeTabsPlugin from './main';
import type { BookScope, ManualTabTextColor } from './types';
import { sanitizeConfigBaseName, sanitizeFrontmatterProperty, sanitizeTabTextFrontmatterProperty } from './settings-model';

const HEX = /^#[0-9a-f]{6}$/i;
const CSS_HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export class BookColorService {
	constructor(private readonly plugin: ScopeTabsPlugin) {}

	async ensureManualColors(books: BookScope[]): Promise<void> {
		let changed = false;
		for (const book of books) {
			if (!isHexColor(this.plugin.settings.manualColors[book.id])) {
				this.plugin.settings.manualColors[book.id] = randomDarkThemeColor(book.id);
				changed = true;
			}
			if (!isManualTabTextColor(this.plugin.settings.manualTabTextColors[book.id])) {
				this.plugin.settings.manualTabTextColors[book.id] = '#ffffff';
				changed = true;
			}
		}
		if (changed) await this.plugin.saveSettings();
	}

	getColor(book: BookScope): string {
		if (this.plugin.settings.colorMode === 'frontmatter') {
			const fromFrontmatter = this.readFrontmatterColor(book);
			if (fromFrontmatter) return fromFrontmatter;
		}
		return this.plugin.settings.manualColors[book.id] ?? randomDarkThemeColor(book.id);
	}

	getTabTextColor(book: BookScope): string {
		if (this.plugin.settings.colorMode === 'frontmatter') {
			return this.readFrontmatterTabTextColor(book) ?? '#ffffff';
		}
		const configured = this.plugin.settings.manualTabTextColors[book.id];
		return isManualTabTextColor(configured)
			? configured
			: '#ffffff';
	}

	getConfigPath(book: BookScope): string {
		const base = sanitizeConfigBaseName(this.plugin.settings.configFileBaseName);
		return normalizePath(`${book.folderPath}/${base}.md`);
	}

	getMissingConfigBooks(books: BookScope[]): BookScope[] {
		return books.filter((book) => !(this.plugin.app.vault.getAbstractFileByPath(this.getConfigPath(book)) instanceof TFile));
	}

	async ensureFrontmatterColors(books: BookScope[]): Promise<void> {
		await this.ensureManualColors(books);
		const colorProperty = sanitizeFrontmatterProperty(this.plugin.settings.colorFrontmatterProperty);
		const textProperty = sanitizeTabTextFrontmatterProperty(this.plugin.settings.tabTextFrontmatterProperty);
		for (const book of books) {
			const file = this.plugin.app.vault.getAbstractFileByPath(this.getConfigPath(book));
			if (!(file instanceof TFile)) continue;
			await this.plugin.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
				const current = frontmatter[colorProperty];
				if (!isHexColor(typeof current === 'string' ? current : '')) {
					frontmatter[colorProperty] = this.plugin.settings.manualColors[book.id] ?? randomDarkThemeColor(book.id);
				}
				if (!normalizeTabTextColor(frontmatter[textProperty])) frontmatter[textProperty] = 'white';
			});
		}
	}

	async createConfigFiles(books: BookScope[]): Promise<void> {
		await this.ensureManualColors(books);
		const colorProperty = sanitizeFrontmatterProperty(this.plugin.settings.colorFrontmatterProperty);
		const textProperty = sanitizeTabTextFrontmatterProperty(this.plugin.settings.tabTextFrontmatterProperty);
		for (const book of books) {
			const path = this.getConfigPath(book);
			const existing = this.plugin.app.vault.getAbstractFileByPath(path);
			if (existing instanceof TFile) {
				await this.plugin.app.fileManager.processFrontMatter(existing, (frontmatter: Record<string, unknown>) => {
					const current = frontmatter[colorProperty];
					if (!isHexColor(typeof current === 'string' ? current : '')) {
						frontmatter[colorProperty] = this.plugin.settings.manualColors[book.id] ?? randomDarkThemeColor(book.id);
					}
					if (!normalizeTabTextColor(frontmatter[textProperty])) frontmatter[textProperty] = 'white';
				});
				continue;
			}
			const color = this.plugin.settings.manualColors[book.id] ?? randomDarkThemeColor(book.id);
			await this.plugin.app.vault.create(path, `---\n${JSON.stringify(colorProperty)}: ${JSON.stringify(color)}\n${JSON.stringify(textProperty)}: white\n---\n`);
		}
		new Notice(`Root Books Tabs: created/updated ${books.length} book config file${books.length === 1 ? '' : 's'}.`);
	}

	private readFrontmatterColor(book: BookScope): string | null {
		const file = this.plugin.app.vault.getAbstractFileByPath(this.getConfigPath(book));
		if (!(file instanceof TFile)) return null;
		const property = sanitizeFrontmatterProperty(this.plugin.settings.colorFrontmatterProperty);
		const frontmatter: unknown = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter;
		const value = getRecordValue(frontmatter, property);
		return typeof value === 'string' && isHexColor(value) ? value : null;
	}

	private readFrontmatterTabTextColor(book: BookScope): string | null {
		const file = this.plugin.app.vault.getAbstractFileByPath(this.getConfigPath(book));
		if (!(file instanceof TFile)) return null;
		const property = sanitizeTabTextFrontmatterProperty(this.plugin.settings.tabTextFrontmatterProperty);
		const frontmatter: unknown = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter;
		return normalizeTabTextColor(getRecordValue(frontmatter, property));
	}
}

export function isHexColor(value: string | undefined): value is string {
	return typeof value === 'string' && HEX.test(value);
}

export function normalizeTabTextColor(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const normalized = value.trim().toLowerCase();
	if (normalized === 'black') return '#000000';
	if (normalized === 'white') return '#ffffff';
	return CSS_HEX.test(normalized) ? normalized : null;
}

export function isManualTabTextColor(value: string | undefined): value is ManualTabTextColor {
	return value === '#000000' || value === '#ffffff';
}

function getRecordValue(value: unknown, key: string): unknown {
	if (typeof value !== 'object' || value === null) return undefined;
	return (value as Record<string, unknown>)[key];
}

function randomDarkThemeColor(seed: string): string {
	let hash = 0;
	for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
	const hue = hash % 360;
	const saturation = 58 + (hash % 18);
	const lightness = 58 + ((hash >>> 8) % 10);
	return hslToHex(hue, saturation, lightness);
}

function hslToHex(h: number, s: number, l: number): string {
	s /= 100;
	l /= 100;
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = l - c / 2;
	let r = 0, g = 0, b = 0;
	if (h < 60) [r, g, b] = [c, x, 0];
	else if (h < 120) [r, g, b] = [x, c, 0];
	else if (h < 180) [r, g, b] = [0, c, x];
	else if (h < 240) [r, g, b] = [0, x, c];
	else if (h < 300) [r, g, b] = [x, 0, c];
	else [r, g, b] = [c, 0, x];
	const toHex = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, '0');
	return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
