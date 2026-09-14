import { getFrontMatterInfo, Modal, normalizePath, Notice, parseYaml, TFile, type FileManager } from 'obsidian';
import { updateConfigFrontmatter } from './config-frontmatter';
import type ScopeTabsPlugin from './main';

export type IndexTransferStrategy = 'merge-frontmatter' | 'append-body' | 'replace-frontmatter' | 'replace-content' | 'swap';
export type IndexMoveDecision = 'ask' | 'block' | IndexTransferStrategy;

interface IndexMovePromptResult {
	decision: Exclude<IndexMoveDecision, 'ask'>;
	remember: boolean;
}

export type IndexMovePrompt = (sourcePath: string, destinationPath: string) => Promise<IndexMovePromptResult | null>;
type RenameFile = FileManager['renameFile'];

const TRANSFER_STRATEGIES: IndexTransferStrategy[] = ['merge-frontmatter', 'append-body', 'replace-frontmatter', 'replace-content', 'swap'];
const LOCATION_OWNED_KEYS = new Set([
	'fileOrder', 'orderingEnabled', 'orderingType', 'forcedOrderingType', 'creation-date',
	'isFreshClone', 'freshCloneOpeningPath', 'tabInsertDirection', 'bookNoteOpenMode', 'openBooksInExternalWindows',
	'createBookIndex', 'hideNewBookIndex', 'configNotePosition', 'orderingDirection',
	'excludedBookFolders', 'forceUpdateLinks', 'template-folder', 'template-md', 'template-canvas', 'template-base',
	'template-paths-under-global-folder', 'template-file-prefix', 'template-file-date', 'template-file-path',
	'template-file-applied-To', 'template-file-applied-to',
]);

/** Guards folder-owned index notes while keeping FileManager as the single public move path. */
export class IndexMoveController {
	private original: RenameFile | null = null;
	private patch: RenameFile | null = null;
	private hadOwnMethod = false;
	private promptQueue: Promise<void> = Promise.resolve();

	constructor(private readonly plugin: ScopeTabsPlugin, private readonly prompt: IndexMovePrompt = (source, destination) => this.showPrompt(source, destination)) {}

	install(): void {
		if (this.patch) return;
		const manager = this.plugin.app.fileManager;
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Exact function identity is required for ownership-safe restoration.
		const original = manager.renameFile;
		if (typeof original !== 'function') return;
		this.original = original;
		this.hadOwnMethod = Object.prototype.hasOwnProperty.call(manager, 'renameFile');
		const intercept = this.intercept.bind(this);
		this.patch = function(this: FileManager, file, newPath): Promise<void> {
			return intercept(this, original, file, newPath);
		};
		manager.renameFile = this.patch;
	}

	uninstall(): void {
		const manager = this.plugin.app.fileManager;
		if (this.patch && manager.renameFile === this.patch && this.original) {
			if (this.hadOwnMethod) manager.renameFile = this.original;
			else delete (manager as Partial<FileManager>).renameFile;
		}
		this.original = null;
		this.patch = null;
	}

	private async intercept(manager: FileManager, original: RenameFile, file: Parameters<RenameFile>[0], newPath: string): Promise<void> {
		const destinationPath = normalizePath(newPath);
		if (!this.isProtectedIndex(file) || parentPath(file.path) === parentPath(destinationPath)) {
			return original.call(manager, file, newPath);
		}
		const protectedDestinationPath = normalizePath(`${parentPath(destinationPath)}/${file.name}`);
		return this.enqueue(async () => {
			const saved = normalizeIndexMoveDecision(this.plugin.settings.indexMoveDecision);
			const prompted = saved === 'ask' ? await this.prompt(file.path, protectedDestinationPath) : { decision: saved, remember: false };
			if (!prompted || prompted.decision === 'block') {
				if (prompted?.remember) await this.remember('block');
				new Notice('Root books tabs kept this index note in its folder because index notes contain location-specific settings.');
				return;
			}
			await this.transfer(file, protectedDestinationPath, prompted.decision);
			if (prompted.remember) await this.remember(prompted.decision);
		});
	}

	private isProtectedIndex(file: Parameters<RenameFile>[0]): file is TFile {
		if (!(file instanceof TFile) || file.extension !== 'md') return false;
		if (file.path === 'index.md') return true;
		return this.plugin.scopeResolver.resolveFile(file) !== null
			&& file.name === `${this.plugin.settings.configFileBaseName}.md`;
	}

	private async transfer(source: TFile, destinationPath: string, strategy: IndexTransferStrategy): Promise<void> {
		const vault = this.plugin.app.vault;
		const destinationFolder = vault.getFolderByPath(parentPath(destinationPath));
		if (!destinationFolder) throw new Error(`Cannot transfer index contents because ${parentPath(destinationPath) || 'the vault root'} does not exist.`);
		const existing = vault.getAbstractFileByPath(destinationPath);
		if (existing && !(existing instanceof TFile)) throw new Error(`Cannot transfer index contents because ${destinationPath} is not a file.`);
		if (!existing && strategy === 'swap') throw new Error('Two index notes are required for a swap.');
		let destination = existing;
		let created = false;
		if (!destination) {
			destination = await vault.create(destinationPath, '');
			created = true;
		}
		const originals = new Map<TFile, string>([
			[source, await vault.read(source)],
			[destination, await vault.read(destination)],
		]);
		try {
			if (strategy === 'merge-frontmatter') await this.copyFrontmatter(source, destination, false);
			else if (strategy === 'replace-frontmatter') await this.copyFrontmatter(source, destination, true);
			else if (strategy === 'append-body') await this.copyBody(source, destination, false);
			else if (strategy === 'replace-content') await this.copyBody(source, destination, true);
			else await this.swap(source, destination);
			await this.refreshLocations(source, destination);
		} catch (error) {
			const failures: unknown[] = [];
			if (created) {
				try { await this.plugin.app.fileManager.trashFile(destination); } catch (failure) { failures.push(failure); }
			} else {
				for (const [file, content] of originals) {
					try { await vault.process(file, () => content); } catch (failure) { failures.push(failure); }
				}
			}
			if (failures.length) throw new AggregateError([error, ...failures], 'Index transfer failed and could not be fully rolled back.');
			throw error;
		}
	}

	private async copyFrontmatter(source: TFile, destination: TFile, replace: boolean): Promise<void> {
		const sourceValues = readFrontmatter(await this.plugin.app.vault.read(source));
		await updateConfigFrontmatter(this.plugin.app, destination, destinationValues => {
			const locationValues = this.locationValues(destinationValues);
			if (replace) for (const key of Object.keys(destinationValues)) delete destinationValues[key];
			for (const [key, value] of Object.entries(sourceValues)) {
				if (!this.isLocationOwned(key) && (replace || !(key in destinationValues))) destinationValues[key] = structuredClone(value);
			}
			Object.assign(destinationValues, locationValues);
		});
	}

	private async copyBody(source: TFile, destination: TFile, replace: boolean): Promise<void> {
		const sourceNote = splitNote(await this.plugin.app.vault.read(source));
		await this.plugin.app.vault.process(destination, content => {
			const destinationNote = splitNote(content);
			const body = replace ? sourceNote.body : appendBody(destinationNote.body, sourceNote.body);
			return `${destinationNote.frontmatter}${body}`;
		});
	}

	private async swap(source: TFile, destination: TFile): Promise<void> {
		const sourceContent = await this.plugin.app.vault.read(source), destinationContent = await this.plugin.app.vault.read(destination);
		const sourceNote = splitNote(sourceContent), destinationNote = splitNote(destinationContent);
		const sourceValues = readFrontmatter(sourceContent), destinationValues = readFrontmatter(destinationContent);
		await this.plugin.app.vault.process(source, () => `${sourceNote.frontmatter}${destinationNote.body}`);
		await this.plugin.app.vault.process(destination, () => `${destinationNote.frontmatter}${sourceNote.body}`);
		await this.replaceNonLocationFrontmatter(source, destinationValues);
		await this.replaceNonLocationFrontmatter(destination, sourceValues);
	}

	private async replaceNonLocationFrontmatter(file: TFile, incoming: Record<string, unknown>): Promise<void> {
		await updateConfigFrontmatter(this.plugin.app, file, values => {
			const locationValues = this.locationValues(values);
			for (const key of Object.keys(values)) if (!this.isLocationOwned(key)) delete values[key];
			for (const [key, value] of Object.entries(incoming)) if (!this.isLocationOwned(key)) values[key] = structuredClone(value);
			Object.assign(values, locationValues);
		});
	}

	private locationValues(values: Record<string, unknown>): Record<string, unknown> {
		return Object.fromEntries(Object.entries(values).filter(([key]) => this.isLocationOwned(key)).map(([key, value]) => [key, structuredClone(value)]));
	}

	private isLocationOwned(key: string): boolean {
		const unprefixed = key.startsWith('book-tabs-') ? key.slice('book-tabs-'.length) : key;
		return LOCATION_OWNED_KEYS.has(unprefixed)
			|| Object.prototype.hasOwnProperty.call(this.plugin.settings, unprefixed)
			|| unprefixed === this.plugin.settings.colorFrontmatterProperty
			|| unprefixed === this.plugin.settings.tabTextFrontmatterProperty;
	}

	private async refreshLocations(...files: TFile[]): Promise<void> {
		for (const file of files) this.plugin.bookOrder.refresh(file);
		for (const file of files) {
			if (!file.parent || file.parent.isRoot() || file.name !== `${this.plugin.settings.configFileBaseName}.md`) continue;
			await this.plugin.bookOrder.ensureConfig(file.parent);
		}
		for (const file of files) await this.plugin.bookOrder.syncStructure(file);
		this.plugin.decorations.refresh();
	}

	private async remember(decision: Exclude<IndexMoveDecision, 'ask'>): Promise<void> {
		this.plugin.settings.indexMoveDecision = decision;
		await this.plugin.saveSettings();
	}

	private enqueue(action: () => Promise<void>): Promise<void> {
		const result = this.promptQueue.then(action);
		this.promptQueue = result.then(() => undefined, () => undefined);
		return result;
	}

	private showPrompt(sourcePath: string, destinationPath: string): Promise<IndexMovePromptResult | null> {
		return new Promise(resolve => new IndexMoveModal(this.plugin, sourcePath, destinationPath, resolve).open());
	}
}

class IndexMoveModal extends Modal {
	private settled = false;

	constructor(
		private readonly plugin: ScopeTabsPlugin,
		private readonly sourcePath: string,
		private readonly destinationPath: string,
		private readonly resolve: (result: IndexMovePromptResult | null) => void,
	) {
		super(plugin.app);
	}

	onOpen(): void {
		this.contentEl.empty();
		this.contentEl.createEl('h2', { text: 'Move an index note?' });
		this.contentEl.createEl('p', { text: `Index notes belong to their folders. ${this.sourcePath} and ${this.destinationPath} will remain in place; an advanced choice transfers selected data between them.` });
		const group = `scope-tabs-index-move-${Date.now()}-${Math.random()}`;
		const safe = this.radio(this.contentEl, group, 'Don’t move the file; keep me safe', true);
		const unsafe = this.radio(this.contentEl, group, 'Move it; I know what I’m doing');
		const strategies = this.contentEl.createEl('fieldset');
		strategies.disabled = true;
		strategies.createEl('legend', { text: 'Transfer strategy' });
		const choices: Array<[IndexTransferStrategy, string]> = [
			['merge-frontmatter', `Copy frontmatter from ${this.sourcePath} to ${this.destinationPath}`],
			['append-body', `Copy note contents from ${this.sourcePath} to ${this.destinationPath}`],
			['replace-frontmatter', `Replace frontmatter in ${this.destinationPath} from ${this.sourcePath}`],
			['replace-content', `Replace note contents in ${this.destinationPath} from ${this.sourcePath}`],
			['swap', 'Swap the two index notes’ user frontmatter and contents'],
		];
		let strategy: IndexTransferStrategy | null = null;
		const strategyInputs = choices.map(([value, label]) => {
			const input = this.radio(strategies, `${group}-strategy`, label);
			input.addEventListener('change', () => { if (input.checked) strategy = value; update(); });
			return input;
		});
		const rememberLabel = this.contentEl.createEl('label');
		const remember = rememberLabel.createEl('input', { type: 'checkbox' });
		rememberLabel.appendText(' Always do this, and don’t warn me again');
		const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' });
		const cancel = buttons.createEl('button', { text: 'Cancel' });
		const confirm = buttons.createEl('button', { text: 'OK', cls: 'mod-cta' });
		const update = () => {
			strategies.disabled = !unsafe.checked;
			confirm.disabled = unsafe.checked && !strategy;
		};
		safe.addEventListener('change', update);
		unsafe.addEventListener('change', update);
		cancel.addEventListener('click', () => this.finish(null));
		confirm.addEventListener('click', () => {
			const decision = unsafe.checked ? strategy : 'block';
			if (decision) this.finish({ decision, remember: remember.checked });
		});
		update();
		strategyInputs[0]?.focus();
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.settled) { this.settled = true; this.resolve(null); }
	}

	private radio(container: HTMLElement, group: string, text: string, checked = false): HTMLInputElement {
		const label = container.createEl('label');
		const input = label.createEl('input', { type: 'radio' });
		input.name = group;
		input.checked = checked;
		label.appendText(` ${text}`);
		return input;
	}

	private finish(result: IndexMovePromptResult | null): void {
		if (this.settled) return;
		this.settled = true;
		this.resolve(result);
		this.close();
	}
}

export function normalizeIndexMoveDecision(value: unknown): IndexMoveDecision {
	if (value === 'block' || TRANSFER_STRATEGIES.includes(value as IndexTransferStrategy)) return value as Exclude<IndexMoveDecision, 'ask'>;
	return 'ask';
}

function parentPath(path: string): string {
	return path.split('/').slice(0, -1).join('/');
}

function readFrontmatter(content: string): Record<string, unknown> {
	const info = getFrontMatterInfo(content);
	if (!info.exists) return {};
	const parsed: unknown = parseYaml(info.frontmatter);
	if (parsed === null) return {};
	if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Index note frontmatter must contain properties.');
	return parsed as Record<string, unknown>;
}

function splitNote(content: string): { frontmatter: string; body: string } {
	const info = getFrontMatterInfo(content);
	const contentStart = info.exists && 'contentStart' in info && typeof info.contentStart === 'number' ? info.contentStart : 0;
	return { frontmatter: content.slice(0, contentStart), body: content.slice(contentStart) };
}

function appendBody(destination: string, source: string): string {
	if (!source) return destination;
	if (!destination) return source;
	const separator = destination.endsWith('\n\n') || source.startsWith('\n') ? '' : destination.endsWith('\n') ? '\n' : '\n\n';
	return `${destination}${separator}${source}`;
}
