import { TAbstractFile, TFile, TFolder } from 'obsidian';
import type ScopeTabsPlugin from './main';
import type { BookScope } from './types';
import { addConfigComments, ensurePluginFrontmatter, readPluginFrontmatter, updateConfigFrontmatter, writePluginFrontmatter, type ConfigFrontmatterContext } from './config-frontmatter';

export type OrderingType = 'manual' | 'alphabetical' | 'creation-date';
export type OrderingDirection = 'ascending' | 'descending';
export const ORDERING_TYPES: OrderingType[] = ['manual', 'alphabetical', 'creation-date'];
export const FILE_ORDER_PROPERTY = 'fileOrder';

/** Vault mutations and ordering policy; explorer compatibility belongs in decorations. */
export class BookOrderService {
	private queue: Promise<void> = Promise.resolve();
	private metadata = new Map<string, Record<string, unknown>>();
	private configs = new Map<string, Promise<TFile>>();
	constructor(private readonly plugin: ScopeTabsPlugin) {}

	private configPath(folder: TFolder): string {
		return folder.isRoot() ? 'index.md' : `${folder.path}/${this.plugin.settings.configFileBaseName}.md`;
	}

	private isConfigNote(item: TAbstractFile): boolean {
		return item instanceof TFile && !!item.parent && item.path === this.configPath(item.parent);
	}

	async ensureConfig(folder: TFolder): Promise<TFile> {
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
		const defaultOrder = this.initialOrder(folder);
		if (existing instanceof TFile) {
			await this.update(existing, (fm, context) => {
				for (const key of [this.plugin.settings.colorFrontmatterProperty, this.plugin.settings.tabTextFrontmatterProperty]) {
					if (Object.prototype.hasOwnProperty.call(fm, key) && !context.ownedPlainKeys.has(key)) ensurePluginFrontmatter(fm, key, fm[key], context.ownedPlainKeys);
				}
				writePluginFrontmatter(fm, FILE_ORDER_PROPERTY, reconcileFileOrder(readPluginFrontmatter(fm, FILE_ORDER_PROPERTY), this.childNames(folder), existing.name), context.ownedPlainKeys);
				const forced = readPluginFrontmatter(fm, 'forcedOrderingType');
				if (forced !== false && !isOrderingType(forced)) writePluginFrontmatter(fm, 'forcedOrderingType', false, context.ownedPlainKeys);
				if (!isOrderingType(readPluginFrontmatter(fm, 'orderingType'))) writePluginFrontmatter(fm, 'orderingType', 'alphabetical', context.ownedPlainKeys);
				if (folder.parent?.isRoot() && readPluginFrontmatter(fm, 'tabInsertDirection') === undefined) writePluginFrontmatter(fm, 'tabInsertDirection', false, context.ownedPlainKeys);
				if (folder.parent?.isRoot() && readPluginFrontmatter(fm, 'bookNoteOpenMode') === undefined) writePluginFrontmatter(fm, 'bookNoteOpenMode', false, context.ownedPlainKeys);
			});
			return existing;
		}
		if (existing) throw new Error(`A folder occupies ${path}`);
		const created = await this.plugin.app.vault.create(path, addConfigComments(`---\n${FILE_ORDER_PROPERTY}:\n${defaultOrder.map(name => `  - ${JSON.stringify(name)}`).join('\n')}\nforcedOrderingType: false\norderingType: alphabetical\n${folder.parent?.isRoot() ? 'tabInsertDirection: false\nbookNoteOpenMode: false\n' : ''}---\n`));
		await this.update(created, (fm, context) => {
			writePluginFrontmatter(fm, FILE_ORDER_PROPERTY, defaultOrder, context.ownedPlainKeys);
			writePluginFrontmatter(fm, 'forcedOrderingType', false, context.ownedPlainKeys);
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
		if (!file.parent || file.path !== this.configPath(file.parent)) return Promise.resolve();
		return this.enqueue(() => this.syncFolderOrder(file.parent!, file));
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

	isEnabled(bookId: string): boolean {
		const folder = this.plugin.app.vault.getFolderByPath(bookId);
		return !!folder && this.value(folder, 'orderingEnabled') === true;
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
			const configFirst = this.plugin.settings.configNotePosition !== 'bottom';
			return leftConfig === configFirst ? -1 : 1;
		}
		let result = 0;
		if (type === 'manual') {
			const folder = left.parent === right.parent ? left.parent : null;
			const order = folder ? normalizeStoredOrder(this.value(folder, FILE_ORDER_PROPERTY)) : [];
			const leftIndex = order.indexOf(left.name), rightIndex = order.indexOf(right.name);
			if (leftIndex !== rightIndex) {
				if (leftIndex < 0) result = 1;
				else if (rightIndex < 0) result = -1;
				else result = leftIndex - rightIndex;
			}
		} else if (type === 'creation-date') {
			const diff = this.creationDateValue(left) - this.creationDateValue(right);
			if (diff) result = diff;
		}
		if (!result) result = compareAlphabetical(left, right);
		return this.getDirection() === 'descending' ? -result : result;
	}

	getDirection(): OrderingDirection {
		return this.plugin.settings.orderingDirection === 'ascending' ? 'ascending' : 'descending';
	}

	async setDirection(direction: OrderingDirection): Promise<void> {
		this.plugin.settings.orderingDirection = direction;
		await this.plugin.vaultConfig.set('orderingDirection', direction);
	}

	private creationDateValue(item: TAbstractFile): number {
		const value = this.value(item, 'creation-date');
		if (typeof value === 'string') {
			const parsed = parseDateStamp(value);
			if (parsed !== null) return parsed;
		}
		const stat = item instanceof TFile ? item.stat : this.note(item)?.stat;
		return stat?.ctime ?? 0;
	}

	async prepare(book: BookScope): Promise<void> {
		if (this.isPrepared(book)) return;
		return this.enqueue(async () => {
			if (this.isPrepared(book)) return;
			const root = this.plugin.app.vault.getFolderByPath(book.folderPath);
			if (!root) return;
			await this.prepareFolder(root);
			const config = await this.ensureConfig(root);
			if (this.value(root, 'orderingEnabled') === true && isOrderingType(this.value(root, 'orderingType'))) return;
			await this.update(config, (fm, context) => {
				writePluginFrontmatter(fm, 'orderingEnabled', true, context.ownedPlainKeys);
				if (!isOrderingType(readPluginFrontmatter(fm, 'orderingType'))) writePluginFrontmatter(fm, 'orderingType', 'alphabetical', context.ownedPlainKeys);
			});
		});
	}

	private isPrepared(book: BookScope): boolean {
		const root = this.plugin.app.vault.getFolderByPath(book.folderPath);
		return !!root && this.value(root, 'orderingEnabled') === true && this.isPreparedFolder(root);
	}

	private isPreparedFolder(folder: TFolder): boolean {
		const config = this.plugin.app.vault.getFileByPath(this.configPath(folder));
		if (!config) return false;
		const stored = this.value(folder, FILE_ORDER_PROPERTY);
		if (!sameOrder(normalizeStoredOrder(stored), reconcileFileOrder(stored, this.childNames(folder), config.name))) return false;
		const forced = this.value(folder, 'forcedOrderingType');
		if (forced !== false && !isOrderingType(forced)) return false;
		if (!isOrderingType(this.value(folder, 'orderingType'))) return false;
		if (folder.parent?.isRoot() && this.value(folder, 'tabInsertDirection') === undefined) return false;
		if (folder.parent?.isRoot() && this.value(folder, 'bookNoteOpenMode') === undefined) return false;
		for (const child of folder.children) {
			if (child instanceof TFolder && !this.isPreparedFolder(child)) return false;
			if (child instanceof TFile && child.extension === 'md'
				&& typeof this.value(child, 'creation-date') !== 'string') return false;
		}
		return true;
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

	private async prepareFolder(folder: TFolder): Promise<void> {
		const config = await this.ensureConfig(folder);
		await this.syncFolderOrder(folder, config);
		for (const child of [...folder.children]) if (child instanceof TFolder) await this.prepareFolder(child);
		for (const file of folder.children) {
			if (!(file instanceof TFile) || file.extension !== 'md') continue;
			if (typeof this.value(file, 'creation-date') === 'string') continue;
			const created = dateStamp(file.stat.ctime);
			await this.update(file, (fm, context) => {
				if (typeof readPluginFrontmatter(fm, 'creation-date') !== 'string') writePluginFrontmatter(fm, 'creation-date', created, context.ownedPlainKeys);
			});
		}
	}

	async refreshCreationDates(): Promise<void> {
		for (const book of this.plugin.scopeResolver.listBooks()) {
			if (!this.isEnabled(book.id)) continue;
			for (const file of this.plugin.app.vault.getMarkdownFiles().filter(file => file.path.startsWith(`${book.id}/`))) {
				const created = dateStamp(file.stat.ctime);
				if (typeof this.value(file, 'creation-date') === 'string') continue;
				await this.update(file, (values, context) => {
					if (typeof readPluginFrontmatter(values, 'creation-date') !== 'string') writePluginFrontmatter(values, 'creation-date', created, context.ownedPlainKeys);
				});
			}
		}
	}

	async syncStructure(file: TAbstractFile, oldPath?: string): Promise<void> {
		return this.enqueue(async () => {
			const paths = new Set<string>();
			paths.add(parentPath(file.path));
			if (oldPath) paths.add(parentPath(oldPath));
			for (const path of paths) {
				const folder = this.plugin.app.vault.getFolderByPath(path);
				if (folder && this.isBookFolder(folder)) await this.syncFolderOrder(folder);
			}
			if (file instanceof TFile && file.extension === 'md' && this.plugin.app.vault.getAbstractFileByPath(file.path) === file) {
				const book = this.plugin.scopeResolver.resolveFile(file);
				if (book && this.isEnabled(book.id)) {
					const created = dateStamp(file.stat.ctime);
					await this.update(file, (fm, context) => {
						if (typeof readPluginFrontmatter(fm, 'creation-date') !== 'string') writePluginFrontmatter(fm, 'creation-date', created, context.ownedPlainKeys);
					});
				}
			}
			if (file instanceof TFolder && this.plugin.app.vault.getAbstractFileByPath(file.path) === file && this.isBookFolder(file)) {
				const bookId = file.path.split('/')[0]!;
				if (this.isEnabled(bookId)) await this.prepareFolder(file);
			}
		});
	}

	async syncDeleted(path: string): Promise<void> {
		return this.enqueue(async () => {
			const folder = this.plugin.app.vault.getFolderByPath(parentPath(path));
			if (folder && this.isBookFolder(folder)) await this.syncFolderOrder(folder);
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

	async move(bookId: string, sourcePath: string, targetPath: string, placement: 'before' | 'after' | 'inside'): Promise<void> {
		return this.enqueue(async () => {
			const vault = this.plugin.app.vault;
			const source = vault.getAbstractFileByPath(sourcePath), target = vault.getAbstractFileByPath(targetPath);
			if (!source || !target || source === target || !source.path.startsWith(`${bookId}/`) || !(target.path === bookId || target.path.startsWith(`${bookId}/`))) return;
			if (this.isConfigNote(source)) throw new Error('Folder config notes cannot be moved while Root Books Tabs is enabled.');
			const destination = placement === 'inside' && target instanceof TFolder ? target : target.parent;
			if (!destination || destination.isRoot() || destination === source || destination.path.startsWith(`${source.path}/`)) return;
			const sourceParent = source.parent;
			if (!sourceParent) return;
			const targetName = target.name;
			let targetAfterMove: TAbstractFile | null = target;
			if (sourceParent !== destination) {
				const collision = vault.getAbstractFileByPath(`${destination.path}/${source.name}`);
				if (collision && collision !== source) {
					await this.swapFiles(bookId, source, collision);
					if (target === collision) targetAfterMove = source;
				} else {
					await this.plugin.app.fileManager.renameFile(source, `${destination.path}/${source.name}`);
				}
				await this.syncFolderOrder(sourceParent);
				await this.syncFolderOrder(destination);
			}

			const currentType = this.getType(destination);
			const siblings = [...destination.children].sort((a, b) => this.compare(a, b, currentType));
			const sourceIndex = siblings.indexOf(source);
			if (sourceIndex >= 0) siblings.splice(sourceIndex, 1);
			let index = siblings.length;
			if (placement !== 'inside') {
				const currentTarget = targetAfterMove && targetAfterMove.parent === destination
					? targetAfterMove
					: siblings.find(item => item.name === targetName) ?? null;
				const targetIndex = currentTarget ? siblings.indexOf(currentTarget) : -1;
				if (targetIndex >= 0) index = targetIndex + (placement === 'after' ? 1 : 0);
			}
			siblings.splice(Math.max(0, index), 0, source);
			const visualOrder = siblings.map(item => item.name);
			await this.writeOrder(destination, this.getDirection() === 'descending' ? visualOrder.reverse() : visualOrder);
			await this.update(await this.ensureConfig(destination), (fm, context) => { writePluginFrontmatter(fm, 'forcedOrderingType', 'manual', context.ownedPlainKeys); });
		});
	}

	private async swapFiles(bookId: string, source: TAbstractFile, collision: TAbstractFile): Promise<void> {
		const sourcePath = source.path, collisionPath = collision.path;
		let attempt = 0, temporaryPath = '';
		do temporaryPath = `${bookId}/.scope-tabs-swap-${Date.now()}-${attempt++}-${collision.name}`;
		while (this.plugin.app.vault.getAbstractFileByPath(temporaryPath));
		await this.plugin.app.fileManager.renameFile(collision, temporaryPath);
		try {
			await this.plugin.app.fileManager.renameFile(source, collisionPath);
			try {
				await this.plugin.app.fileManager.renameFile(collision, sourcePath);
			} catch (error) {
				await this.plugin.app.fileManager.renameFile(source, sourcePath);
				await this.plugin.app.fileManager.renameFile(collision, collisionPath);
				throw error;
			}
		} catch (error) {
			if (collision.path === temporaryPath) await this.plugin.app.fileManager.renameFile(collision, collisionPath);
			throw error;
		}
	}

	private async syncFolderOrder(folder: TFolder, config?: TFile): Promise<void> {
		if (!this.isBookFolder(folder)) return;
		const note = config ?? this.plugin.app.vault.getFileByPath(this.configPath(folder));
		if (!note) return;
		const names = this.childNames(folder);
		const stored = this.value(folder, FILE_ORDER_PROPERTY);
		const current = normalizeStoredOrder(stored);
		const next = reconcileFileOrder(stored, names, note.name);
		if (sameOrder(current, next)) return;
		await this.update(note, (fm, context) => {
			writePluginFrontmatter(fm, FILE_ORDER_PROPERTY, next, context.ownedPlainKeys);
		});
	}

	private async writeOrder(folder: TFolder, requested: string[]): Promise<void> {
		const note = await this.ensureConfig(folder);
		const available = this.childNames(folder);
		const valid = new Set(available);
		const order = [...new Set(requested)].filter(name => valid.has(name));
		for (const name of available) if (!order.includes(name)) order.push(name);
		await this.update(note, (fm, context) => { writePluginFrontmatter(fm, FILE_ORDER_PROPERTY, order, context.ownedPlainKeys); });
	}

	private childNames(folder: TFolder): string[] {
		const configName = `${this.plugin.settings.configFileBaseName}.md`;
		return [...new Set(folder.children.map(child => child.name).filter(name => name !== configName))].sort(compareNames);
	}

	private initialOrder(folder: TFolder): string[] {
		return this.childNames(folder);
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

export function reconcileFileOrder(value: unknown, availableNames: string[], configName: string): string[] {
	const available = [...new Set(availableNames)].filter(name => name !== configName).sort(compareNames);
	if (!Array.isArray(value)) return available;
	const valid = new Set(available);
	const order = normalizeStoredOrder(value).filter(name => valid.has(name));
	for (const name of available) {
		if (order.includes(name)) continue;
		const alphabeticalIndex = available.indexOf(name);
		const following = available.slice(alphabeticalIndex + 1).find(candidate => order.includes(candidate));
		if (following) order.splice(order.indexOf(following), 0, name);
		else {
			const preceding = available.slice(0, alphabeticalIndex).reverse().find(candidate => order.includes(candidate));
			if (preceding) order.splice(order.indexOf(preceding) + 1, 0, name);
			else order.push(name);
		}
	}
	return order;
}

function normalizeStoredOrder(value: unknown): string[] {
	return Array.isArray(value) ? [...new Set(value.filter((entry): entry is string => typeof entry === 'string'))] : [];
}

function sameOrder(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((name, index) => name === right[index]);
}

function compareAlphabetical(left: TAbstractFile, right: TAbstractFile): number {
	if ((left instanceof TFolder) !== (right instanceof TFolder)) return left instanceof TFolder ? -1 : 1;
	return compareNames(left.name, right.name);
}

function compareNames(left: string, right: string): number {
	return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

function parentPath(path: string): string {
	return path.split('/').slice(0, -1).join('/');
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
