import { hasPluginFrontmatter, prefixedConfigKey, readPluginFrontmatter, removePluginFrontmatter, updateConfigFrontmatter, writePluginFrontmatter } from './config-frontmatter';
import { Notice, TFile, normalizePath } from 'obsidian';
import type ScopeTabsPlugin from './main';
import type { BookScope, ManualTabTextColor } from './types';
import { sanitizeConfigBaseName, sanitizeFrontmatterProperty, sanitizeTabTextFrontmatterProperty } from './settings-model';

const HEX = /^#[0-9a-f]{6}$/i;
const CSS_HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export class BookColorService {
	constructor(private readonly plugin: ScopeTabsPlugin) {}

	private configurationQueue: Promise<void> = Promise.resolve();

	renameConfiguration(baseName: string, colorKey: string, textKey = this.plugin.settings.tabTextFrontmatterProperty): Promise<void> {
		const result = this.configurationQueue.then(() => this.migrateConfiguration(baseName, colorKey, textKey));
		this.configurationQueue = result.catch(() => undefined);
		return result;
	}

	private async migrateConfiguration(baseName: string, colorKey: string, textKey: string): Promise<void> {
		baseName = sanitizeConfigBaseName(baseName);
		colorKey = sanitizeFrontmatterProperty(colorKey);
		textKey = sanitizeTabTextFrontmatterProperty(textKey);
		validateColorKeys(colorKey, textKey);
		const old = {
			configFileBaseName: this.plugin.settings.configFileBaseName,
			colorFrontmatterProperty: this.plugin.settings.colorFrontmatterProperty,
			tabTextFrontmatterProperty: this.plugin.settings.tabTextFrontmatterProperty,
		};
		if (baseName === old.configFileBaseName && colorKey === old.colorFrontmatterProperty && textKey === old.tabTextFrontmatterProperty) return;
		const renames = [[old.colorFrontmatterProperty, colorKey], [old.tabTextFrontmatterProperty, textKey]].filter(([from, to]) => from !== to) as [string, string][];
		const keys = [...new Set(renames.flatMap(([from, to]) => [from, to, prefixedConfigKey(from), prefixedConfigKey(to)]))];
		const files = this.plugin.app.vault.getMarkdownFiles().filter(file => file.parent
			&& !file.parent.isRoot()
			&& file.basename === old.configFileBaseName
			&& this.plugin.scopeResolver.resolveFile(file) !== null);
		for (const file of files) {
			const destination = `${file.parent!.path}/${baseName}.md`;
			if (baseName !== old.configFileBaseName && this.plugin.app.vault.getAbstractFileByPath(destination)) throw new Error(`Config rename would overwrite ${destination}`);
		}
		const moved: { file: TFile; original: string }[] = [];
		const changed: { file: TFile; values: Map<string, unknown> }[] = [];
		let settingsChanged = false;
		let restoreIgnore: (() => Promise<void>) | undefined;
		try {
			for (const file of files) {
				if (renames.length) {
					await updateConfigFrontmatter(this.plugin.app, file, (fm: Record<string, unknown>, context) => {
						const values = new Map(keys.filter(key => key in fm).map(key => [key, fm[key]]));
						changed.push({ file, values });
						const logical = new Map(renames.map(([from]) => [from, readPluginFrontmatter(fm, from)]));
						const present = new Set(renames.map(([from]) => from).filter(from => hasPluginFrontmatter(fm, from)));
						for (const [from] of renames) removePluginFrontmatter(fm, from, context.ownedPlainKeys);
						for (const [from, to] of renames) if (present.has(from)) writePluginFrontmatter(fm, to, logical.get(from), context.ownedPlainKeys);
					}, { aliases: { [colorKey]: 'color', [textKey]: 'tab-text-bg' }, renamedKeys: Object.fromEntries(renames) });
				}
				if (old.configFileBaseName !== baseName) {
					const original = file.path;
					await this.plugin.app.fileManager.renameFile(file, `${file.parent!.path}/${baseName}.md`);
					moved.push({ file, original });
				}
			}
			if (moved.length) restoreIgnore = await this.plugin.bookIgnore.renameExactPaths(moved.map(({ file, original }) => ({ from: original, to: file.path })));
			Object.assign(this.plugin.settings, { configFileBaseName: baseName, colorFrontmatterProperty: colorKey, tabTextFrontmatterProperty: textKey });
			settingsChanged = true;
			await this.plugin.saveSettings();
		} catch (error) {
			const failures: unknown[] = [];
			Object.assign(this.plugin.settings, old);
			if (restoreIgnore) { try { await restoreIgnore(); } catch (failure) { failures.push(failure); } }
			for (const { file, original } of moved.reverse()) {
				try { await this.plugin.app.fileManager.renameFile(file, original); } catch (failure) { failures.push(failure); }
			}
			for (const { file, values } of changed.reverse()) {
				try {
					await updateConfigFrontmatter(this.plugin.app, file, (fm: Record<string, unknown>) => {
						for (const key of keys) { if (values.has(key)) fm[key] = values.get(key); else delete fm[key]; }
					}, { aliases: { [old.colorFrontmatterProperty]: 'color', [old.tabTextFrontmatterProperty]: 'tab-text-bg' }, renamedKeys: Object.fromEntries(renames.map(([from, to]) => [to, from])) });
				} catch (failure) { failures.push(failure); }
			}
			if (settingsChanged) { try { await this.plugin.saveSettings(); } catch (failure) { failures.push(failure); } }
			if (failures.length) throw new AggregateError([error, ...failures], 'Config migration failed and could not fully restore the previous configuration.');
			throw error;
		}
		this.plugin.decorations.refresh();
	}

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
		return this.readFrontmatterColor(book) ?? this.plugin.settings.manualColors[book.id] ?? randomDarkThemeColor(book.id);
	}

	getTabTextColor(book: BookScope): string {
		return this.readFrontmatterTabTextColor(book) ?? '#ffffff';
	}

	async setOverride(book: BookScope, color: string, text: string): Promise<void> {
		validateColorKeys(this.plugin.settings.colorFrontmatterProperty, this.plugin.settings.tabTextFrontmatterProperty);
		if (!isHexColor(color) || !normalizeTabTextColor(text)) throw new Error('Invalid color');
		const folder = this.plugin.app.vault.getFolderByPath(book.id);
		if (!folder) return;
		const file = await this.plugin.bookOrder.ensureConfig(folder);
		await updateConfigFrontmatter(this.plugin.app, file, (fm: Record<string, unknown>, context) => {
			writePluginFrontmatter(fm, this.plugin.settings.colorFrontmatterProperty, color, context.ownedPlainKeys);
			writePluginFrontmatter(fm, this.plugin.settings.tabTextFrontmatterProperty, text, context.ownedPlainKeys);
		}, { aliases: { [this.plugin.settings.colorFrontmatterProperty]: 'color', [this.plugin.settings.tabTextFrontmatterProperty]: 'tab-text-bg' } });
	}

	hasOverride(book: BookScope): boolean { return this.readFrontmatterColor(book) !== null; }

	async removeOverride(book: BookScope): Promise<void> {
		const file = this.plugin.app.vault.getFileByPath(this.getConfigPath(book));
		if (file) await updateConfigFrontmatter(this.plugin.app, file, (fm: Record<string, unknown>, context) => {
			removePluginFrontmatter(fm, this.plugin.settings.colorFrontmatterProperty, context.ownedPlainKeys);
			removePluginFrontmatter(fm, this.plugin.settings.tabTextFrontmatterProperty, context.ownedPlainKeys);
		});
		this.plugin.settings.manualColors[book.id] = randomDarkThemeColor(book.id);
		await this.plugin.saveSettings();
		this.plugin.decorations.refresh();
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
	}

	async createConfigFiles(books: BookScope[]): Promise<void> {
		for (const book of books) {
			const folder = this.plugin.app.vault.getFolderByPath(book.id);
			if (folder) await this.plugin.bookOrder.ensureConfig(folder);
		}
		new Notice(`Root Books Tabs: created/updated ${books.length} book config files.`);
	}

	private readFrontmatterColor(book: BookScope): string | null {
		const file = this.plugin.app.vault.getAbstractFileByPath(this.getConfigPath(book));
		if (!(file instanceof TFile)) return null;
		const property = sanitizeFrontmatterProperty(this.plugin.settings.colorFrontmatterProperty);
		const frontmatter: unknown = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter;
		const value = isRecord(frontmatter) ? readPluginFrontmatter(frontmatter, property) : undefined;
		return typeof value === 'string' && isHexColor(value) ? value : null;
	}

	private readFrontmatterTabTextColor(book: BookScope): string | null {
		const file = this.plugin.app.vault.getAbstractFileByPath(this.getConfigPath(book));
		if (!(file instanceof TFile)) return null;
		const property = sanitizeTabTextFrontmatterProperty(this.plugin.settings.tabTextFrontmatterProperty);
		const frontmatter: unknown = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter;
		return normalizeTabTextColor(isRecord(frontmatter) ? readPluginFrontmatter(frontmatter, property) : undefined);
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
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

/** Color overrides must never replace each other or book-order/navigation metadata. */
export function validateColorKeys(colorKey: string, textKey: string): void {
	colorKey = colorKey.replace(/^book-tabs-/, '');
	textKey = textKey.replace(/^book-tabs-/, '');
	if (colorKey === textKey) throw new Error('Book color and tab text must use different frontmatter properties.');
	const reserved = new Set(['fileOrder', 'creation-date', 'orderingEnabled', 'orderingType', 'forcedOrderingType', 'tabInsertDirection', 'bookNoteOpenMode']);
	if (reserved.has(colorKey) || reserved.has(textKey)) throw new Error('Color properties cannot use ordering or navigation property names.');
}
