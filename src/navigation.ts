import {
	Notice,
	TFile,
	WorkspaceLeaf,
	WorkspaceRoot,
	WorkspaceWindow,
	MarkdownView,
	type OpenViewState,
} from 'obsidian';
import type ScopeTabsPlugin from './main';
import type { BookScope, BookSplitDirection } from './types';

interface InternalTabGroup {
	children?: WorkspaceLeaf[];
	containerEl?: HTMLElement;
	removeChild?: (leaf: WorkspaceLeaf) => void;
	insertChild?: (index: number, leaf: WorkspaceLeaf) => void;
}

export class BookNavigationController {
	private originalOpenFile: WorkspaceLeaf['openFile'] | null = null;
	private readonly managedGroups = new WeakSet<object>();
	private spiralStep = 0;
	private routing = false;

	constructor(private readonly plugin: ScopeTabsPlugin) {}

	install(): void {
		if (this.originalOpenFile) return;
		const original = WorkspaceLeaf.prototype.openFile;
		this.originalOpenFile = original;
		const controller = this;

		WorkspaceLeaf.prototype.openFile = async function (
			file: TFile,
			openState?: OpenViewState,
		): Promise<void> {
			if (controller.routing || !controller.plugin.scopeResolver.hasMultipleBooks()) {
				return original.call(this, file, openState);
			}
			return controller.routeOpen(this, file, openState, original);
		};

		this.adoptExistingMainGroups();
	}

	uninstall(): void {
		if (this.originalOpenFile && WorkspaceLeaf.prototype.openFile !== this.originalOpenFile) {
			WorkspaceLeaf.prototype.openFile = this.originalOpenFile;
		}
		this.originalOpenFile = null;
	}

	markGroupManaged(leaf: WorkspaceLeaf): void {
		if (leaf.parent) this.managedGroups.add(leaf.parent as object);
	}

	isManagedGroup(leaf: WorkspaceLeaf): boolean {
		return !!leaf.parent && this.managedGroups.has(leaf.parent as object);
	}

	async closeBookGroup(leaf: WorkspaceLeaf): Promise<void> {
		for (const child of this.getGroupLeaves(leaf)) child.detach();
	}

	async popOutBookGroup(leaf: WorkspaceLeaf): Promise<void> {
		const groupLeaves = this.getGroupLeaves(leaf);
		const files = groupLeaves.map((item) => item.view instanceof MarkdownView ? item.view.file : null).filter((file): file is TFile => file instanceof TFile);
		const firstFile = files[0];
		if (!firstFile || !this.originalOpenFile) return;
		if (leaf.getRoot() instanceof WorkspaceWindow) return;

		this.routing = true;
		try {
			const first = this.plugin.app.workspace.openPopoutLeaf();
			this.markGroupManaged(first);
			await this.originalOpenFile.call(first, firstFile);
			let reference = first;
			for (const file of files.slice(1)) {
				this.plugin.app.workspace.setActiveLeaf(reference, { focus: false });
				const next = this.plugin.app.workspace.getLeaf('tab');
				this.markGroupManaged(next);
				await this.originalOpenFile.call(next, file);
				reference = next;
			}
			for (const oldLeaf of groupLeaves) oldLeaf.detach();
			this.plugin.app.workspace.revealLeaf(first);
		} finally {
			this.routing = false;
		}
	}

	getBookForGroup(leaf: WorkspaceLeaf): BookScope | null {
		const scopes = this.getGroupLeaves(leaf)
			.map((child) => this.plugin.scopeResolver.resolveFile(child.view instanceof MarkdownView ? child.view.file : null))
			.filter((scope): scope is BookScope => scope !== null);
		const first = scopes[0];
		if (!first) return null;
		return scopes.every((scope) => scope.id === first.id) ? first : null;
	}

	private async routeOpen(
		destinationLeaf: WorkspaceLeaf,
		file: TFile,
		openState: OpenViewState | undefined,
		original: WorkspaceLeaf['openFile'],
	): Promise<void> {
		const sourceLeaf = this.plugin.app.workspace.getMostRecentLeaf();
		if (!sourceLeaf || destinationLeaf !== sourceLeaf) {
			return original.call(destinationLeaf, file, openState);
		}

		const sourceFile = sourceLeaf.view instanceof MarkdownView ? sourceLeaf.view.file : this.plugin.app.workspace.getActiveFile();
		const sourceBook = this.plugin.scopeResolver.resolveFile(sourceFile);
		const targetBook = this.plugin.scopeResolver.resolveFile(file);
		if (!sourceBook || !targetBook) return original.call(destinationLeaf, file, openState);

		if (sourceLeaf.getRoot() instanceof WorkspaceWindow && !this.isManagedGroup(sourceLeaf)) {
			return this.openTabInGroup(sourceLeaf, file, openState, original, this.plugin.settings.focusNewTabs);
		}

		this.markGroupManaged(sourceLeaf);
		if (sourceBook.id === targetBook.id) {
			return this.openTabInGroup(sourceLeaf, file, openState, original, this.plugin.settings.focusNewTabs);
		}

		const existing = this.findManagedBookLeaf(targetBook);
		if (existing) {
			this.plugin.decorations.restoreGroup(existing);
			return this.openTabInGroup(existing, file, openState, original, true);
		}

		return this.openNewBookGroup(sourceLeaf, targetBook, file, openState, original);
	}

	private async openTabInGroup(
		referenceLeaf: WorkspaceLeaf,
		file: TFile,
		openState: OpenViewState | undefined,
		original: WorkspaceLeaf['openFile'],
		focus: boolean,
	): Promise<void> {
		const previous = this.plugin.app.workspace.getMostRecentLeaf();
		this.routing = true;
		try {
			this.plugin.app.workspace.setActiveLeaf(referenceLeaf, { focus: false });
			const newLeaf = this.plugin.app.workspace.getLeaf('tab');
			this.markGroupManaged(newLeaf);
			await original.call(newLeaf, file, openState);
			this.applyTabInsertDirection(referenceLeaf, newLeaf);
			if (focus) this.plugin.app.workspace.revealLeaf(newLeaf);
			else if (previous) this.plugin.app.workspace.setActiveLeaf(previous, { focus: true });
		} finally {
			this.routing = false;
		}
	}

	private async openNewBookGroup(
		sourceLeaf: WorkspaceLeaf,
		_targetBook: BookScope,
		file: TFile,
		openState: OpenViewState | undefined,
		original: WorkspaceLeaf['openFile'],
	): Promise<void> {
		this.routing = true;
		try {
			let leaf: WorkspaceLeaf;
			if (this.plugin.settings.openBooksInExternalWindows) {
				leaf = this.plugin.app.workspace.openPopoutLeaf();
			} else {
				const direction = this.resolveSplitDirection(this.plugin.settings.bookSplitDirection);
				leaf = this.plugin.app.workspace.createLeafBySplit(sourceLeaf, direction.axis, direction.before);
			}
			this.markGroupManaged(leaf);
			await original.call(leaf, file, openState);
			this.plugin.app.workspace.revealLeaf(leaf);
		} catch (error) {
			console.error('Scope Tabs: failed to open book group', error);
			new Notice('Scope Tabs could not create the requested book window. Falling back to the current tab.');
			await original.call(sourceLeaf, file, openState);
		} finally {
			this.routing = false;
		}
	}

	private findManagedBookLeaf(book: BookScope): WorkspaceLeaf | null {
		for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) {
			if (!this.isManagedGroup(leaf)) continue;
			const groupBook = this.getBookForGroup(leaf);
			if (groupBook?.id === book.id) return leaf;
		}
		return null;
	}

	private getGroupLeaves(leaf: WorkspaceLeaf): WorkspaceLeaf[] {
		const parent = leaf.parent as unknown as InternalTabGroup;
		if (Array.isArray(parent?.children)) {
			return parent.children.filter((child): child is WorkspaceLeaf => child instanceof WorkspaceLeaf);
		}
		return [leaf];
	}

	private applyTabInsertDirection(reference: WorkspaceLeaf, created: WorkspaceLeaf): void {
		if (this.plugin.settings.tabInsertDirection !== 'left') return;
		const parent = created.parent as unknown as InternalTabGroup;
		if (!Array.isArray(parent.children) || typeof parent.removeChild !== 'function' || typeof parent.insertChild !== 'function') return;
		const referenceIndex = parent.children.indexOf(reference);
		const createdIndex = parent.children.indexOf(created);
		if (referenceIndex < 0 || createdIndex < 0 || createdIndex === referenceIndex - 1) return;
		try {
			parent.removeChild(created);
			parent.insertChild(referenceIndex, created);
		} catch (error) {
			console.debug('Scope Tabs: this Obsidian version does not expose tab reordering internals.', error);
		}
	}

	private resolveSplitDirection(direction: BookSplitDirection): { axis: 'vertical' | 'horizontal'; before: boolean } {
		if (direction === 'spiral') {
			const order: Exclude<BookSplitDirection, 'spiral'>[] = ['right', 'down', 'left', 'up'];
			direction = order[this.spiralStep++ % order.length] ?? 'right';
		}
		switch (direction) {
			case 'left': return { axis: 'vertical', before: true };
			case 'down': return { axis: 'horizontal', before: false };
			case 'up': return { axis: 'horizontal', before: true };
			case 'right':
			default: return { axis: 'vertical', before: false };
		}
	}

	private adoptExistingMainGroups(): void {
		for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) {
			if (leaf.getRoot() instanceof WorkspaceRoot) this.markGroupManaged(leaf);
		}
	}
}
