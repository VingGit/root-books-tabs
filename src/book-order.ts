import { TAbstractFile, TFile, TFolder } from 'obsidian';
import type ScopeTabsPlugin from './main';
import type { BookScope } from './types';
import { ensurePluginFrontmatter, readPluginFrontmatter, updateConfigFrontmatter, writePluginFrontmatter, type ConfigFrontmatterContext } from './config-frontmatter';
import { matchDatePatternInFilename } from './date-pattern';

export type OrderingType = 'alphabetical' | 'creation-date' | 'properties';
export type OrderingDirection = 'ascending' | 'descending';
export const ORDERING_TYPES: OrderingType[] = ['alphabetical', 'creation-date', 'properties'];

/** Vault mutations and ordering policy; explorer compatibility belongs in decorations. */
export class BookOrderService {
	private queue: Promise<void> = Promise.resolve();
	private metadata = new Map<string, Record<string, unknown>>();
	private configs = new Map<string, Promise<TFile>>();
	constructor(private readonly plugin: ScopeTabsPlugin) {}
	whenIdle(): Promise<void> { return this.queue; }

	private configPath(folder: TFolder): string {
		return folder.isRoot() ? 'index.md' : `${folder.path}/${this.plugin.settings.configFileBaseName}.md`;
	}

	getConfigPath(folder: TFolder): string { return this.configPath(folder); }

	private isConfigNote(item: TAbstractFile): boolean {
		return item instanceof TFile && !!item.parent && item.path === this.configPath(item.parent);
	}

	hasExpectedAlias(file: TFile): boolean {
		if (!file.parent || file.parent.isRoot() || file.path !== this.configPath(file.parent)) return true;
		const frontmatter: unknown = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter;
		const aliases = isRecord(frontmatter) ? frontmatter.aliases : undefined;
		return Array.isArray(aliases) && aliases.length === 1 && aliases[0] === file.parent.name;
	}

	async ensureConfig(folder: TFolder): Promise<TFile> {
		if (folder.isRoot()) return this.plugin.vaultConfig.ensureRoot();
		const path = this.configPath(folder);
		const pending = this.configs.get(path);
		if (pending) return pending;
		const operation = this.createOrUpdateConfig(folder);
		this.configs.set(path, operation);
		try { return await operation; } finally { this.configs.delete(path); }
	}

	private async createOrUpdateConfig(folder: TFolder): Promise<TFile> {
		const path = this.configPath(folder);
		const existing = this.plugin.app.vault.getAbstractFileByPath(path);
		if (this.plugin.frontmatterMaintenance?.paused) {
			if (existing instanceof TFile) return existing;
			if (existing) throw new Error(`A folder occupies ${path}`);
			return this.plugin.app.vault.create(path, '');
		}
		if (existing instanceof TFile) {
			await this.update(existing, (fm, context) => {
				fm.aliases = [folder.name];
				for (const key of [this.plugin.settings.colorFrontmatterProperty, this.plugin.settings.tabTextFrontmatterProperty]) {
					if (Object.prototype.hasOwnProperty.call(fm, key) && !context.ownedPlainKeys.has(key)) ensurePluginFrontmatter(fm, key, fm[key], context.ownedPlainKeys);
				}
				const forced = readPluginFrontmatter(fm, 'forcedOrderingType');
				if (forced !== false && !isOrderingType(forced)) writePluginFrontmatter(fm, 'forcedOrderingType', false, context.ownedPlainKeys);
				const forcedDirection = readPluginFrontmatter(fm, 'forcedOrderingDirection');
				if (forcedDirection !== false && forcedDirection !== 'ascending' && forcedDirection !== 'descending') writePluginFrontmatter(fm, 'forcedOrderingDirection', false, context.ownedPlainKeys);
				if (!isOrderingType(readPluginFrontmatter(fm, 'orderingType'))) writePluginFrontmatter(fm, 'orderingType', 'alphabetical', context.ownedPlainKeys);
				if (folder.parent?.isRoot() && readPluginFrontmatter(fm, 'tabInsertDirection') === undefined) writePluginFrontmatter(fm, 'tabInsertDirection', false, context.ownedPlainKeys);
				if (folder.parent?.isRoot() && readPluginFrontmatter(fm, 'bookNoteOpenMode') === undefined) writePluginFrontmatter(fm, 'bookNoteOpenMode', false, context.ownedPlainKeys);
			});
			return existing;
		}
		if (existing) throw new Error(`A folder occupies ${path}`);
		const created = await this.plugin.app.vault.create(path, '');
		await this.update(created, (fm, context) => {
			fm.aliases = [folder.name];
			writePluginFrontmatter(fm, 'forcedOrderingType', false, context.ownedPlainKeys);
			writePluginFrontmatter(fm, 'forcedOrderingDirection', false, context.ownedPlainKeys);
			writePluginFrontmatter(fm, 'orderingType', 'alphabetical', context.ownedPlainKeys);
			if (folder.parent?.isRoot()) {
				writePluginFrontmatter(fm, 'tabInsertDirection', false, context.ownedPlainKeys);
				writePluginFrontmatter(fm, 'bookNoteOpenMode', false, context.ownedPlainKeys);
			}
		});
		return created;
	}

	private note(item: TAbstractFile): TFile | null {
		return item instanceof TFile && item.extension === 'md' ? item : item instanceof TFolder
			? this.plugin.app.vault.getFileByPath(this.configPath(item)) : null;
	}

	private values(item: TAbstractFile): Record<string, unknown> {
		const note = this.note(item);
		return note ? this.metadata.get(note.path) ?? this.plugin.app.metadataCache.getFileCache(note)?.frontmatter ?? {} : {};
	}

	private value(item: TAbstractFile, key: string): unknown {
		return readPluginFrontmatter(this.values(item), key);
	}

	refresh(file: TFile): void {
		this.metadata.delete(file.path);
	}

	syncConfig(file: TFile): Promise<void> {
		if (this.plugin.frontmatterMaintenance?.paused) return Promise.resolve();
		if (!file.parent || file.parent.isRoot() || file.path !== this.configPath(file.parent)) return Promise.resolve();
		return this.enqueue(async () => {
			if (!this.hasExpectedAlias(file)) await this.createOrUpdateConfig(file.parent!);
		});
	}

	private async update(file: TFile, change: (fm: Record<string, unknown>, context: ConfigFrontmatterContext) => void): Promise<void> {
		await updateConfigFrontmatter(this.plugin.app, file, (fm: Record<string, unknown>, context) => {
			change(fm, context);
			this.metadata.set(file.path, { ...fm });
		}, { aliases: {
			[this.plugin.settings.colorFrontmatterProperty]: 'color',
			[this.plugin.settings.tabTextFrontmatterProperty]: 'tab-text-bg',
		} });
	}

	getType(folder: TFolder): OrderingType {
		let current: TFolder | null = folder;
		while (current?.parent) {
			const forced = this.value(current, 'forcedOrderingType');
			if (isOrderingType(forced)) return forced;
			const type = this.value(current, 'orderingType');
			if (current.parent.isRoot()) return isOrderingType(type) ? type : 'alphabetical';
			current = current.parent;
		}
		return 'alphabetical';
	}

	compare(left: TAbstractFile, right: TAbstractFile, type: OrderingType): number {
		const leftConfig = this.isConfigNote(left), rightConfig = this.isConfigNote(right);
		if (leftConfig !== rightConfig) {
			return leftConfig ? -1 : 1;
		}
		let result = 0;
		if (type === 'creation-date') {
			const leftDate = this.creationDateValue(left), rightDate = this.creationDateValue(right);
			if (leftDate !== null && rightDate !== null) result = leftDate - rightDate;
			else if (leftDate !== null) result = -1;
			else if (rightDate !== null) result = 1;
		} else if (type === 'properties') {
			const folder = left.parent === right.parent ? left.parent : null;
			const order = folder ? this.propertyOrder(folder) : [];
			const leftIndex = order.indexOf(left.path), rightIndex = order.indexOf(right.path);
			if (leftIndex !== rightIndex) {
				if (leftIndex < 0) result = 1;
				else if (rightIndex < 0) result = -1;
				else result = leftIndex - rightIndex;
			}
		}
		if (!result) result = compareAlphabetical(left, right);
		const folder = left.parent === right.parent ? left.parent : null;
		return this.getDirection(folder) === 'descending' ? -result : result;
	}

	getDirection(folder?: TFolder | null): OrderingDirection {
		let current = folder ?? null;
		while (current && !current.isRoot()) {
			const forced = this.value(current, 'forcedOrderingDirection');
			if (forced === 'ascending' || forced === 'descending') return forced;
			current = current.parent;
		}
		return this.plugin.settings.orderingDirection === 'ascending' ? 'ascending' : 'descending';
	}

	getDirectionOverride(folder: TFolder): OrderingDirection | null {
		const value = this.value(folder, 'forcedOrderingDirection');
		return value === 'ascending' || value === 'descending' ? value : null;
	}

	async setDirection(direction: OrderingDirection): Promise<void> {
		this.plugin.settings.orderingDirection = direction;
		await this.plugin.vaultConfig.set('orderingDirection', direction);
	}

	dateOrderingValue(item: TAbstractFile, preferFilename = true): number | null {
		const folder = item.parent && !item.parent.isRoot() ? item.parent : item instanceof TFolder ? item : null;
		if (preferFilename) {
			const filenameDate = matchDatePatternInFilename(item.name, this.plugin.templates.dateFormatForFolder(folder));
			if (filenameDate !== null) return filenameDate;
		}
		const value = this.value(item, 'creation-date');
		if (typeof value === 'string') {
			const parsed = parseDateStamp(value);
			if (parsed !== null) return parsed;
		}
		const timestamp = item instanceof TFile ? item.stat.ctime : null;
		return typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
	}

	private creationDateValue(item: TAbstractFile): number | null { return this.dateOrderingValue(item, true); }

	private propertyOrder(folder: TFolder): string[] {
		const items = folder.children.filter(item => !this.isConfigNote(item));
		const itemPaths = new Set(items.map(item => item.path));
		const storedKeys = { nextKey: this.plugin.settings.articleNavigatorNextProperty,
			previousKey: this.plugin.settings.articleNavigatorPreviousProperty,
			seeAlsoKey: this.plugin.settings.articleNavigatorSeeAlsoProperty };
		const { nextKey, previousKey } = this.plugin.articleNavigator?.resolveKeys(storedKeys,
			this.plugin.settings.articleNavigatorFollowPluginKeys).keys ?? storedKeys;
		const next = new Map<string, string>();
		const incoming = new Set<string>();
		for (const item of items) {
			const directNext = this.resolveArticleTarget(item, this.values(item)[nextKey]);
			if (directNext && directNext !== item.path && itemPaths.has(directNext)) { next.set(item.path, directNext); }
			const previous = this.resolveArticleTarget(item, this.values(item)[previousKey]);
			if (previous && previous !== item.path && itemPaths.has(previous) && !next.has(previous)) next.set(previous, item.path);
		}
		for (const target of next.values()) incoming.add(target);
		const fallback = (left: TAbstractFile, right: TAbstractFile): number => {
			const a = this.dateOrderingValue(left), b = this.dateOrderingValue(right);
			if (a !== null && b !== null && a !== b) return a - b;
			if (a !== null && b === null) return -1;
			if (a === null && b !== null) return 1;
			return compareAlphabetical(left, right);
		};
		const byPath = new Map(items.map(item => [item.path, item]));
		const starts = items.filter(item => !incoming.has(item.path)).sort(fallback);
		const remaining = items.filter(item => incoming.has(item.path)).sort(fallback);
		const ordered: string[] = [], visited = new Set<string>();
		const appendChain = (path: string): void => {
			let current: string | undefined = path;
			while (current && !visited.has(current) && byPath.has(current)) {
				visited.add(current); ordered.push(current); current = next.get(current);
			}
		};
		for (const item of starts) appendChain(item.path);
		for (const item of remaining) appendChain(item.path);
		return ordered;
	}

	private resolveArticleTarget(source: TAbstractFile, raw: unknown): string | null {
		const value = Array.isArray(raw) ? raw.find(entry => typeof entry === 'string') : raw;
		if (typeof value !== 'string' || !value.trim()) return null;
		const wikilink = /^\s*\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]\s*$/.exec(value)?.[1];
		const markdown = /^\s*\[[^\]]*\]\(([^)#]+)(?:#[^)]+)?\)\s*$/.exec(value)?.[1];
		const linkpath = (wikilink ?? markdown ?? value).trim();
		const target = this.plugin.app.metadataCache.getFirstLinkpathDest(linkpath, source.path);
		return target?.path ?? null;
	}

	async reconcileExistingConfigs(book: BookScope): Promise<void> {
		return this.enqueue(async () => {
			const root = this.plugin.app.vault.getFolderByPath(book.folderPath);
			if (root) await this.reconcileExistingFolder(root);
		});
	}

	private async reconcileExistingFolder(folder: TFolder): Promise<void> {
		if (this.plugin.app.vault.getFileByPath(this.configPath(folder))) await this.ensureConfig(folder);
		for (const child of folder.children) if (child instanceof TFolder) await this.reconcileExistingFolder(child);
	}

	async refreshCreationDates(): Promise<void> {
		if (this.plugin.frontmatterMaintenance?.paused) return;
		for (const file of this.plugin.app.vault.getMarkdownFiles()) {
			const created = dateStamp(file.stat.ctime);
			if (this.value(file, 'creation-date') === created) continue;
			await this.update(file, (values, context) => {
				writePluginFrontmatter(values, 'creation-date', created, context.ownedPlainKeys);
			});
		}
	}

	syncCreationDate(file: TFile): Promise<void> {
		if (this.plugin.frontmatterMaintenance?.paused) return Promise.resolve();
		if (file.extension !== 'md') return Promise.resolve();
		const created = dateStamp(file.stat.ctime);
		if (this.value(file, 'creation-date') === created) return Promise.resolve();
		return this.enqueue(() => this.update(file, (frontmatter, context) => {
			writePluginFrontmatter(frontmatter, 'creation-date', created, context.ownedPlainKeys);
		}));
	}

	async syncStructure(file: TAbstractFile): Promise<void> {
		if (this.plugin.frontmatterMaintenance?.paused) return;
		return this.enqueue(async () => {
			if (file instanceof TFile && file.extension === 'md' && this.plugin.app.vault.getAbstractFileByPath(file.path) === file) {
				const created = dateStamp(file.stat.ctime);
				await this.update(file, (fm, context) => {
					writePluginFrontmatter(fm, 'creation-date', created, context.ownedPlainKeys);
				});
			}
			if (file instanceof TFolder && this.plugin.app.vault.getAbstractFileByPath(file.path) === file && this.isBookFolder(file)) {
				if (this.plugin.app.vault.getFileByPath(this.configPath(file))) await this.ensureConfig(file);
			}
		});
	}

	async setType(bookId: string, type: OrderingType): Promise<void> {
		const folder = this.plugin.app.vault.getFolderByPath(bookId);
		if (!folder) return;
		await this.enqueue(async () => this.update(await this.ensureConfig(folder), (fm, context) => {
			writePluginFrontmatter(fm, 'orderingType', type, context.ownedPlainKeys);
			writePluginFrontmatter(fm, 'forcedOrderingType', false, context.ownedPlainKeys);
		}));
	}

	private isBookFolder(folder: TFolder): boolean {
		if (folder.isRoot()) return false;
		const bookId = folder.path.split('/')[0];
		return this.plugin.scopeResolver.listBooks().some(book => book.id === bookId);
	}

	private enqueue(action: () => Promise<void>): Promise<void> {
		const result = this.queue.then(action);
		this.queue = result.catch(() => undefined);
		return result;
	}
}

export function isOrderingType(value: unknown): value is OrderingType {
	return ORDERING_TYPES.includes(value as OrderingType);
}

function compareAlphabetical(left: TAbstractFile, right: TAbstractFile): number {
	if ((left instanceof TFolder) !== (right instanceof TFolder)) return left instanceof TFolder ? -1 : 1;
	return compareNames(left.name, right.name);
}

function compareNames(left: string, right: string): number {
	return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseDateStamp(value: unknown): number | null {
	if (typeof value !== 'string') return null;
	const match = /^(\d{2})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/.exec(value);
	if (!match) return null;
	const year = 2000 + Number(match[1]), month = Number(match[2]) - 1, day = Number(match[3]);
	const milliseconds = Number((match[7] ?? '').padEnd(3, '0'));
	const time = new Date(year, month, day, Number(match[4] ?? 0), Number(match[5] ?? 0), Number(match[6] ?? 0), milliseconds).getTime();
	return Number.isFinite(time) ? time : null;
}

export function dateStamp(time: number): string {
	const date = new Date(time);
	return `${String(date.getFullYear()).slice(-2)}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}
