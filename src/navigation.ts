import { readPluginFrontmatter, updateConfigFrontmatter, writePluginFrontmatter } from './config-frontmatter';
import {
	Notice,
	TFile,
	TFolder,
	WorkspaceLeaf,
	WorkspaceWindow,
	type OpenViewState,
	type ViewState,
	type Workspace,
} from 'obsidian';
import { getLeafFile } from './leaf-file';
import { getSourcePopoutInit } from './popout-position';
import type ScopeTabsPlugin from './main';
import type { BookNoteOpenMode, BookScope, CardinalDirection, ManagedGroupLocation, PersistedGroupRecord } from './types';

type LeafParent = WorkspaceLeaf['parent'];

interface GroupSnapshot {
	bookId: string;
	states: ViewState[];
	activeIndex: number;
}

interface GroupTransferPlacement {
	referenceLeaf: WorkspaceLeaf;
	direction: CardinalDirection;
}

interface GridCreationStep {
	referenceIndex: number;
	direction: CardinalDirection;
}

interface BookHistoryEntry {
	path: string;
}

interface BookGroupHistory {
	bookId: string;
	entries: BookHistoryEntry[];
	index: number;
	mode: BookNoteOpenMode;
}

interface PendingFileExplorerOpen {
	path: string;
	expiresAt: number;
}

export class BookNavigationController {
	private originalOpenFile: WorkspaceLeaf['openFile'] | null = null;
	private patchedOpenFile: WorkspaceLeaf['openFile'] | null = null;
	private readonly groupRecords = new WeakMap<LeafParent, PersistedGroupRecord>();
	private readonly canonicalGroups = new Map<string, LeafParent>();
	private excludedGroup: LeafParent | null = null;
	private readonly popoutSnapshots = new WeakMap<WorkspaceWindow, GroupSnapshot>();
	private readonly suppressedWindowReturns = new WeakSet<WorkspaceWindow>();
	private bookHistories = new WeakMap<LeafParent, Map<string, BookGroupHistory>>();
	private groupOpenOrder = new WeakMap<LeafParent, number>();
	private groupOpenClock = 0;
	private pendingFileExplorerOpen: PendingFileExplorerOpen | null = null;
	private routing = false;
	private navigatingHistory = false;

	constructor(private readonly plugin: ScopeTabsPlugin) {}

	install(): void {
		if (this.originalOpenFile) return;
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Exact function identity is required for ownership-safe restoration.
		const original = WorkspaceLeaf.prototype.openFile;
		this.originalOpenFile = original;
		const routeOpen = this.routeOpen.bind(this);
		const shouldBypass = () => this.routing || !this.plugin.scopeResolver.hasMultipleBooks();
		const patched: WorkspaceLeaf['openFile'] = async function (
			this: WorkspaceLeaf,
			file: TFile,
			openState?: OpenViewState,
		): Promise<void> {
			if (shouldBypass()) return original.call(this, file, openState);
			return routeOpen(this, file, openState, original);
		};
		this.patchedOpenFile = patched;
		WorkspaceLeaf.prototype.openFile = patched;
		this.restoreGroupRegistry();
		this.observeActiveLeaf();
	}

	uninstall(): void {
		if (this.originalOpenFile && this.patchedOpenFile && WorkspaceLeaf.prototype.openFile === this.patchedOpenFile) {
			WorkspaceLeaf.prototype.openFile = this.originalOpenFile;
		}
		this.originalOpenFile = null;
		this.patchedOpenFile = null;
		this.pendingFileExplorerOpen = null;
		this.excludedGroup = null;
		this.groupOpenOrder = new WeakMap<LeafParent, number>();
		this.groupOpenClock = 0;
	}

	isManagedGroup(leaf: WorkspaceLeaf): boolean {
		return this.groupRecords.get(leaf.parent)?.kind === 'managed';
	}

	getBookForGroup(leaf: WorkspaceLeaf): BookScope | null {
		const record = this.groupRecords.get(leaf.parent);
		if (record?.kind === 'managed' && record.bookId) {
			const persistedBook = this.plugin.scopeResolver.listBooks().find((book) => book.id === record.bookId);
			if (persistedBook) return persistedBook;
		}
		return this.inferGroupBook(this.getGroupLeaves(leaf));
	}

	getBookGroupInstances(book: BookScope): WorkspaceLeaf[] {
		const instances: WorkspaceLeaf[] = [];
		for (const [group, leaves] of this.collectGroups()) {
			const bookLeaves = leaves.filter((leaf) =>
				this.plugin.scopeResolver.resolveFile(getLeafFile(leaf, this.plugin.app.vault))?.id === book.id);
			const recent = this.plugin.app.workspace.getMostRecentLeaf(group);
			const representative = recent && bookLeaves.includes(recent) ? recent : bookLeaves[0];
			if (!representative) continue;
			instances.push(representative);
		}
		instances.sort((left, right) =>
			(this.groupOpenOrder.get(left.parent) ?? 0) - (this.groupOpenOrder.get(right.parent) ?? 0));
		return instances;
	}

	getLatestBookGroupInstance(book: BookScope): WorkspaceLeaf | null {
		const instances = this.getBookGroupInstances(book);
		return instances[instances.length - 1] ?? null;
	}

	getGroupLocation(leaf: WorkspaceLeaf): ManagedGroupLocation {
		return getLocation(leaf);
	}

	getBookNoteOpenMode(book: BookScope): BookNoteOpenMode {
		return this.getBookNoteOpenModeOverride(book) ?? this.plugin.settings.bookNoteOpenMode;
	}

	getBookNoteOpenModeOverride(book: BookScope): BookNoteOpenMode | null {
		const file = this.plugin.app.vault.getFileByPath(this.plugin.colors.getConfigPath(book));
		const frontmatter = file ? this.plugin.app.metadataCache.getFileCache(file)?.frontmatter : null;
		const mode: unknown = frontmatter ? readPluginFrontmatter(frontmatter, 'bookNoteOpenMode') : null;
		return mode === 'same-tab' || mode === 'background-tab' || mode === 'focused-tab' ? mode : null;
	}

	async setBookNoteOpenMode(book: BookScope, mode: BookNoteOpenMode | null): Promise<void> {
		const folder = this.plugin.app.vault.getFolderByPath(book.id);
		if (!folder) return;
		const file = await this.plugin.bookOrder.ensureConfig(folder);
		await updateConfigFrontmatter(this.plugin.app, file, (fm: Record<string, unknown>, context) => { writePluginFrontmatter(fm, 'bookNoteOpenMode', mode ?? false, context.ownedPlainKeys); }, { aliases: {
			[this.plugin.settings.colorFrontmatterProperty]: 'color',
			[this.plugin.settings.tabTextFrontmatterProperty]: 'tab-text-bg',
		} });
	}

	resetBookHistories(): void {
		this.bookHistories = new WeakMap<LeafParent, Map<string, BookGroupHistory>>();
		this.plugin.decorations.refresh();
	}

	expectFileExplorerOpen(path: string): void {
		this.pendingFileExplorerOpen = { path, expiresAt: Date.now() + 1500 };
	}

	observeActiveLeaf(leaf: WorkspaceLeaf | null = this.plugin.app.workspace.getMostRecentLeaf()): void {
		if (!leaf || this.routing || this.navigatingHistory) return;
		const file = getLeafFile(leaf, this.plugin.app.vault);
		const book = this.plugin.scopeResolver.resolveFile(file);
		if (!file || !book) return;
		if (this.getBookNoteOpenMode(book) === 'same-tab') this.recordPageNavigation(leaf, book, file.path);
	}

	getBookHistoryAvailability(leaf: WorkspaceLeaf): { back: boolean; forward: boolean } {
		const file = getLeafFile(leaf, this.plugin.app.vault);
		const book = this.plugin.scopeResolver.resolveFile(file);
		if (!file || !book) return { back: false, forward: false };
		if (this.getBookNoteOpenMode(book) !== 'same-tab') {
			const leaves = this.getOrderedBookLeaves(leaf, book.id);
			const index = leaves.indexOf(leaf);
			return {
				back: index > 0,
				forward: index >= 0 && index < leaves.length - 1,
			};
		}
		const history = this.ensureBookHistory(leaf, book);
		this.pruneBookHistory(book, history);
		return {
			back: history.index > 0,
			forward: history.index >= 0 && history.index < history.entries.length - 1,
		};
	}

	async navigateBookHistory(leaf: WorkspaceLeaf, direction: 'back' | 'forward'): Promise<boolean> {
		const file = getLeafFile(leaf, this.plugin.app.vault);
		const book = this.plugin.scopeResolver.resolveFile(file);
		if (!file || !book) return false;
		if (this.getBookNoteOpenMode(book) !== 'same-tab') {
			const leaves = this.getOrderedBookLeaves(leaf, book.id);
			const currentIndex = leaves.indexOf(leaf);
			const targetIndex = currentIndex + (direction === 'back' ? -1 : 1);
			const targetLeaf = leaves[targetIndex];
			if (currentIndex < 0 || !targetLeaf) return false;

			this.navigatingHistory = true;
			try {
				this.focusLeaf(targetLeaf);
				return true;
			} catch (error) {
				console.error(`Root Books Tabs could not move ${direction} through the ${book.name} tabs.`, error);
				new Notice(`Root Books Tabs could not move ${direction} through this book's tabs.`);
				return false;
			} finally {
				this.navigatingHistory = false;
				this.plugin.decorations.refresh();
			}
		}
		if (!this.originalOpenFile) return false;
		const history = this.ensureBookHistory(leaf, book);
		this.pruneBookHistory(book, history);
		const targetIndex = history.index + (direction === 'back' ? -1 : 1);
		const entry = history.entries[targetIndex];
		if (!entry) return false;

		this.navigatingHistory = true;
		this.routing = true;
		try {
			const targetFile = this.plugin.app.vault.getFileByPath(entry.path);
			if (!targetFile || this.plugin.scopeResolver.resolveFile(targetFile)?.id !== book.id) return false;
			const targetLeaf = this.plugin.app.workspace.getMostRecentLeaf(leaf.parent) ?? leaf;
			await this.originalOpenFile.call(targetLeaf, targetFile);
			this.focusLeaf(targetLeaf);
			history.index = targetIndex;
			return true;
		} catch (error) {
			console.error(`Root Books Tabs could not move ${direction} in the ${book.name} history.`, error);
			new Notice(`Root Books Tabs could not move ${direction} in this book's history.`);
			return false;
		} finally {
			this.routing = false;
			this.navigatingHistory = false;
			this.plugin.decorations.refresh();
		}
	}

	getCanonicalBookLeaf(book: BookScope): WorkspaceLeaf | null {
		const group = this.canonicalGroups.get(book.id);
		if (!group) return null;
		// Detached tab groups can retain internal children after a pop-out closes.
		// Only reuse a canonical group that Obsidian still exposes in the live workspace.
		const leaves = this.collectGroups().get(group) ?? [];
		if (leaves.length === 0 || !this.groupContainsBook(leaves, book.id)) {
			this.forgetGroup(group);
			return null;
		}
		return this.plugin.app.workspace.getMostRecentLeaf(group) ?? leaves[0] ?? null;
	}

	getOpenBookIds(): Set<string> {
		const result = new Set<string>();
		this.plugin.app.workspace.iterateAllLeaves((leaf) => {
			const book = this.plugin.scopeResolver.resolveFile(getLeafFile(leaf, this.plugin.app.vault));
			if (book) result.add(book.id);
		});
		return result;
	}

	getBookOrder(): string[] {
		return this.syncBookOrder();
	}

	reorderSecondaryBook(bookId: string, targetBookId: string, placement: 'before' | 'after'): void {
		if (bookId === targetBookId || bookId === this.plugin.settings.selectedBookId || targetBookId === this.plugin.settings.selectedBookId) return;
		const current = this.syncBookOrder();
		if (!current.includes(bookId) || !current.includes(targetBookId)) return;
		const next = current.filter((id) => id !== bookId);
		const targetIndex = next.indexOf(targetBookId);
		if (targetIndex < 0) return;
		next.splice(targetIndex + (placement === 'after' ? 1 : 0), 0, bookId);
		this.persistBookOrder(next);
	}

	setPrimaryBook(bookId: string): void {
		const books = new Set(this.plugin.scopeResolver.listBooks().map((book) => book.id));
		if (!books.has(bookId)) return;
		const current = this.syncBookOrder();
		this.persistBookOrder([bookId, ...current.filter((id) => id !== bookId)]);
	}

	hasRestoredWorkspaceHistory(): boolean {
		let found = false;
		this.plugin.app.workspace.iterateRootLeaves((leaf) => {
			if (!found && leaf.getViewState().type !== 'empty') found = true;
		});
		if (found) return true;
		this.plugin.app.workspace.iterateAllLeaves((leaf) => {
			if (!found && getLocation(leaf) === 'popout' && leaf.getViewState().type !== 'empty') found = true;
		});
		return found;
	}

	getLatestOpenBookId(excludeBookId: string): string | null {
		const openBookIds = this.getOpenBookIds();
		const ordered = this.syncBookOrder();
		for (const id of [...ordered].reverse()) {
			if (id !== excludeBookId && openBookIds.has(id)) return id;
		}
		return null;
	}

	async activateBook(book: BookScope, preferredEntryFile?: TFile | null): Promise<boolean> {
		const entryFile = preferredEntryFile && this.plugin.scopeResolver.resolveFile(preferredEntryFile)?.id === book.id
			? preferredEntryFile
			: this.resolveBookEntryFile(book);
		const existing = this.getCanonicalBookLeaf(book);
		if (existing) {
			const existingBookLeaf = this.getGroupLeaves(existing).find((leaf) =>
				this.plugin.scopeResolver.resolveFile(getLeafFile(leaf, this.plugin.app.vault))?.id === book.id);
			if (preferredEntryFile && entryFile) {
				const matching = this.getGroupLeaves(existing).find(leaf => getLeafFile(leaf, this.plugin.app.vault)?.path === entryFile.path);
				if (matching) this.focusLeaf(matching);
				else await this.openBookInLeaf(existing, book, entryFile);
			} else if (existingBookLeaf) this.focusLeaf(existingBookLeaf);
			else if (entryFile) await this.openBookInLeaf(existing, book, entryFile);
			else this.focusLeaf(existing);
			return true;
		}
		if (!entryFile || !this.originalOpenFile) return false;
		const soleFileLeaf = this.findSoleFileLeaf();
		if (soleFileLeaf) {
			await this.openBookInLeaf(soleFileLeaf, book, entryFile);
			return true;
		}
		const emptyLeaf = this.findReusableEmptyMainLeaf();
		if (emptyLeaf) {
			await this.openBookInLeaf(emptyLeaf, book, entryFile);
			return true;
		}
		const source = this.plugin.app.workspace.getMostRecentLeaf() ?? this.findMainWorkspaceLeaf();
		if (!source) return false;
		return this.openNewBookGroup(source, book, entryFile, undefined, this.originalOpenFile);
	}

	async openAdditionalBook(book: BookScope, forcePopout = false): Promise<boolean> {
		const existing = this.getCanonicalBookLeaf(book);
		if (existing) {
			this.focusLeaf(existing);
			return true;
		}
		const entryFile = this.resolveBookEntryFile(book);
		if (!entryFile || !this.originalOpenFile) return false;
		const source = this.plugin.app.workspace.getMostRecentLeaf() ?? this.findMainWorkspaceLeaf();
		if (!source) return false;
		return this.openNewBookGroup(source, book, entryFile, undefined, this.originalOpenFile, forcePopout ? 'popout' : undefined);
	}

	async openBookCopy(book: BookScope): Promise<boolean> {
		const entryFile = this.resolveBookEntryFile(book);
		if (!entryFile || !this.originalOpenFile) return false;
		const source = this.plugin.app.workspace.getMostRecentLeaf() ?? this.findMainWorkspaceLeaf();
		if (!source) return false;
		this.routing = true;
		let createdLeaf: WorkspaceLeaf | null = null;
		try {
			createdLeaf = this.createMainBookLeaf(source);
			this.registerFreeGroup(createdLeaf);
			await this.originalOpenFile.call(createdLeaf, entryFile);
			this.syncBookOrder();
			this.focusLeaf(createdLeaf);
			return true;
		} catch (error) {
			console.error('Root Books Tabs could not create a book copy.', error);
			if (createdLeaf) {
				this.forgetGroup(createdLeaf.parent);
				createdLeaf.detach();
			}
			new Notice('Root books tabs could not open another instance of this book.');
			return false;
		} finally {
			this.routing = false;
		}
	}

	closeBook(book: BookScope): void {
		const canonical = this.getCanonicalBookLeaf(book);
		if (canonical) {
			this.closeBookGroup(canonical);
			return;
		}
		const matchingLeaves: WorkspaceLeaf[] = [];
		this.plugin.app.workspace.iterateAllLeaves((leaf) => {
			if (this.plugin.scopeResolver.resolveFile(getLeafFile(leaf, this.plugin.app.vault))?.id === book.id) matchingLeaves.push(leaf);
		});
		for (const leaf of matchingLeaves) leaf.detach();
	}

	closeAllBookGroups(book: BookScope): void {
		const instances = this.getBookGroupInstances(book);
		if (instances.length === 0) {
			this.closeBook(book);
			return;
		}
		for (const leaf of instances) this.closeBookGroupInstance(book, leaf);
	}

	closeAllSecondaryBooks(primaryBookId: string): void {
		const openBookIds = this.getOpenBookIds();
		for (const book of this.plugin.scopeResolver.listBooks()) {
			if (book.id !== primaryBookId && openBookIds.has(book.id)) this.closeAllBookGroups(book);
		}
		this.syncBookOrder();
	}

	closeLatestBookGroup(book: BookScope): void {
		const latest = this.getLatestBookGroupInstance(book);
		if (latest) this.closeBookGroupInstance(book, latest);
		else this.closeBook(book);
	}

	closeBookGroupInstance(book: BookScope, leaf: WorkspaceLeaf): void {
		const leaves = this.getGroupLeaves(leaf);
		const bookLeaves = leaves.filter((candidate) =>
			this.plugin.scopeResolver.resolveFile(getLeafFile(candidate, this.plugin.app.vault))?.id === book.id);
		if (bookLeaves.length === 0) return;
		if (bookLeaves.length === leaves.length) {
			this.closeBookGroup(leaf);
			return;
		}
		for (const child of bookLeaves) this.closeBookTab(child);
	}

	closeBookGroup(leaf: WorkspaceLeaf): void {
		const popout = getPopoutRoot(leaf);
		if (popout) this.suppressedWindowReturns.add(popout);
		const group = leaf.parent;
		const leaves = this.getGroupLeaves(leaf);
		this.forgetGroup(group);
		for (const child of leaves) child.detach();
	}

	closeBookTab(leaf: WorkspaceLeaf): void {
		const group = leaf.parent;
		const leaves = this.getLeavesForGroup(group);
		if (!leaves.includes(leaf)) return;
		const closesGroup = leaves.length === 1;
		const popout = getPopoutRoot(leaf);
		if (closesGroup && popout && this.groupRecords.get(group)?.kind === 'managed') {
			this.suppressedWindowReturns.add(popout);
		}
		if (closesGroup) this.forgetGroup(group);
		leaf.detach();
		if (!closesGroup) this.capturePopoutSnapshots();
		this.syncBookOrder();
	}

	handleWindowClose(workspaceWindow: WorkspaceWindow): void {
		if (this.suppressedWindowReturns.delete(workspaceWindow)) return;
		const snapshot = this.popoutSnapshots.get(workspaceWindow);
		if (!snapshot) return;
		window.setTimeout(() => void this.restoreClosedPopout(workspaceWindow, snapshot), 50);
	}

	prepareForQuit(): void {
		this.plugin.app.workspace.iterateAllLeaves((leaf) => {
			const popout = getPopoutRoot(leaf);
			if (popout) this.suppressedWindowReturns.add(popout);
		});
	}

	reconcileGroupRegistry(): void {
		if (this.routing) return;
		const groups = this.collectGroups();
		for (const group of this.canonicalGroups.values()) {
			if (this.getLeavesForGroup(group).length === 0) this.forgetGroup(group);
		}
		if (this.excludedGroup && this.getLeavesForGroup(this.excludedGroup).length === 0) this.forgetGroup(this.excludedGroup);
		for (const [group, leaves] of groups) {
			const existingRecord = this.groupRecords.get(group);
			if (existingRecord?.kind === 'managed' && existingRecord.bookId && !this.groupContainsBook(leaves, existingRecord.bookId)) {
				this.forgetGroup(group);
			} else if (existingRecord?.kind === 'excluded' && !this.groupContainsOnlyExcludedFiles(leaves)) {
				this.forgetGroup(group);
			} else if (existingRecord) {
				if (existingRecord.kind === 'excluded' && !this.excludedGroup) this.excludedGroup = group;
				const leaf = leaves[0];
				if (leaf && existingRecord.location !== getLocation(leaf)) {
					const movedRecord = { ...existingRecord, location: getLocation(leaf) };
					this.groupRecords.set(group, movedRecord);
					this.persistGroup(group, movedRecord);
				}
				continue;
			}
			const leaf = leaves[0];
			if (!leaf) continue;
			const groupId = getGroupId(group);
			const persisted = groupId ? this.plugin.runtimeState.groups[groupId] : undefined;
			if (groupId && persisted?.kind === 'managed' && persisted.bookId && !this.groupContainsBook(leaves, persisted.bookId)) {
				delete this.plugin.runtimeState.groups[groupId];
				void this.plugin.saveRuntimeState();
			}
			if (groupId && persisted?.kind === 'excluded' && !this.groupContainsOnlyExcludedFiles(leaves)) {
				delete this.plugin.runtimeState.groups[groupId];
				void this.plugin.saveRuntimeState();
			}
			if (persisted?.kind === 'free') {
				this.groupRecords.set(group, persisted);
				continue;
			}
			if (persisted?.kind === 'excluded' && this.groupContainsOnlyExcludedFiles(leaves) && !this.excludedGroup) {
				this.groupRecords.set(group, persisted);
				this.excludedGroup = group;
				continue;
			}
			if (persisted?.kind === 'managed' && persisted.bookId && this.groupContainsBook(leaves, persisted.bookId) && !this.canonicalGroups.has(persisted.bookId)) {
				this.groupRecords.set(group, persisted);
				this.canonicalGroups.set(persisted.bookId, group);
				continue;
			}
			if (this.groupContainsOnlyExcludedFiles(leaves)) {
				if (!this.excludedGroup) this.registerExcludedGroup(leaf);
				else this.registerFreeGroup(leaf);
				continue;
			}
			const book = this.inferGroupBook(leaves);
			if (!book && this.countGroupBooks(leaves) > 1) {
				this.registerFreeGroup(leaf);
				continue;
			}
			if (!book || getLocation(leaf) === 'popout' || this.getCanonicalBookLeaf(book)) {
				if (getLocation(leaf) === 'popout' || book) this.registerFreeGroup(leaf);
				continue;
			}
			this.registerManagedGroup(leaf, book);
		}
		this.capturePopoutSnapshots();
		this.syncBookOrder();
	}

	async moveBookGroupToPopout(leaf: WorkspaceLeaf): Promise<void> {
		if (getLocation(leaf) === 'popout') return;
		await this.transferGroup(leaf, 'popout');
	}

	async moveBookGroupToMain(leaf: WorkspaceLeaf): Promise<void> {
		if (getLocation(leaf) === 'main') return;
		await this.transferGroup(leaf, 'main');
	}

	async moveBookGroupByDrag(
		sourceLeaf: WorkspaceLeaf,
		referenceLeaf: WorkspaceLeaf,
		direction: CardinalDirection,
	): Promise<void> {
		if (sourceLeaf.parent === referenceLeaf.parent) return;
		await this.transferGroup(sourceLeaf, getLocation(referenceLeaf), { referenceLeaf, direction });
	}

	async sortAllTabsIntoBooks(animate?: (leaves: WorkspaceLeaf[]) => Promise<void>): Promise<number> {
		if (this.routing || !this.plugin.scopeResolver.hasMultipleBooks()) return 0;
		const booksById = new Map(this.plugin.scopeResolver.listBooks().map((book) => [book.id, book]));
		const entries: Array<{ leaf: WorkspaceLeaf; book: BookScope; filePath: string; state: ViewState }> = [];
		this.plugin.app.workspace.iterateAllLeaves((leaf) => {
			const file = getLeafFile(leaf, this.plugin.app.vault);
			const book = this.plugin.scopeResolver.resolveFile(file);
			if (book && file) entries.push({ leaf, book, filePath: file.path, state: cloneViewState(leaf.getViewState()) });
		});
		if (entries.length === 0) return 0;

		const activeBefore = this.plugin.app.workspace.getMostRecentLeaf();
		const groups = this.collectGroups();
		const groupBookIds = new Map<LeafParent, Set<string>>();
		const pureBookGroups = new Set<LeafParent>();
		for (const [group, leaves] of groups) {
			const ids = leaves.map((leaf) => this.plugin.scopeResolver.resolveFile(getLeafFile(leaf, this.plugin.app.vault))?.id);
			const scopedIds = new Set(ids.filter((id): id is string => id !== undefined));
			groupBookIds.set(group, scopedIds);
			if (ids.length > 0 && ids.every((id) => id !== undefined) && scopedIds.size === 1) pureBookGroups.add(group);
		}
		const openBookIds = new Set(entries.map((entry) => entry.book.id));
		const orderedBookIds = [
			...this.syncBookOrder().filter((id) => openBookIds.has(id)),
			...openBookIds,
		].filter((id, index, all) => all.indexOf(id) === index);
		const destinations = new Map<string, WorkspaceLeaf>();
		const usedGroups = new Set<LeafParent>();
		const createdEmptyLeaves: WorkspaceLeaf[] = [];

		this.routing = true;
		try {
			for (const bookId of orderedBookIds) {
				const book = booksById.get(bookId);
				const source = entries.find((entry) => entry.book.id === bookId)?.leaf;
				if (!book || !source) continue;
				const canonical = this.getCanonicalBookLeaf(book);
				let destination = canonical && !usedGroups.has(canonical.parent) && pureBookGroups.has(canonical.parent) ? canonical : null;
				if (!destination) {
					destination = findGroupRepresentative(groups, usedGroups, (group) => {
						const ids = groupBookIds.get(group);
						return pureBookGroups.has(group) && ids?.size === 1 && ids.has(bookId);
					});
				}
				if (!destination) {
					destination = getLocation(source) === 'popout'
						? this.createPopoutLeaf(source)
						: this.createMainBookLeaf(source);
					createdEmptyLeaves.push(destination);
					groups.set(destination.parent, [destination]);
				}
				usedGroups.add(destination.parent);
				this.registerManagedGroup(destination, book);
				destinations.set(bookId, destination);
			}

			const uniqueEntries: typeof entries = [];
			const duplicateEntries: typeof entries = [];
			const byFile = new Map<string, typeof entries>();
			for (const entry of entries) {
				const key = `${entry.book.id}\u0000${entry.filePath}`;
				const list = byFile.get(key) ?? [];
				list.push(entry);
				byFile.set(key, list);
			}
			for (const list of byFile.values()) {
				const destination = destinations.get(list[0]!.book.id);
				const survivor = list.find(entry => entry.leaf === activeBefore)
					?? list.find(entry => destination?.parent === entry.leaf.parent)
					?? list[0]!;
				uniqueEntries.push(survivor);
				for (const entry of list) if (entry !== survivor) duplicateEntries.push(entry);
			}
			const movingEntries = uniqueEntries.filter((entry) => destinations.get(entry.book.id)?.parent !== entry.leaf.parent);
			if (animate && (movingEntries.length > 0 || duplicateEntries.length > 0)) await animate([...movingEntries, ...duplicateEntries].map((entry) => entry.leaf));
			const affectedEntries = [...movingEntries, ...duplicateEntries];
			const suppressedPopouts = this.suppressPopoutReturnsForMoves(new Set(affectedEntries.map((entry) => entry.leaf)));

			let moved = 0;
			let activeAfter = activeBefore;
			const sourceGroups = new Set(affectedEntries.map((entry) => entry.leaf.parent));
			for (const entry of movingEntries) {
				const destination = destinations.get(entry.book.id);
				if (!destination) continue;
				try {
					let target: WorkspaceLeaf;
					let tabReference: WorkspaceLeaf | null = null;
					if (isEmptyLeaf(destination)) {
						target = destination;
					} else {
						tabReference = destination;
						this.plugin.app.workspace.setActiveLeaf(destination, { focus: false });
						target = this.plugin.app.workspace.getLeaf('tab');
					}
					this.registerManagedGroup(target, entry.book);
					await target.setViewState(entry.state);
					if (tabReference) this.applyTabInsertDirection(tabReference, target);
					if (entry.leaf === activeBefore) activeAfter = target;
					entry.leaf.detach();
					destinations.set(entry.book.id, target);
					moved++;
				} catch (error) {
					console.error(`Root Books Tabs could not sort a tab for ${entry.book.name}.`, error);
				}
			}
			for (const entry of duplicateEntries) {
				try {
					entry.leaf.detach();
					moved++;
				} catch (error) {
					console.error(`Root Books Tabs could not close a duplicate tab for ${entry.book.name}.`, error);
				}
			}

			for (const group of sourceGroups) {
				const remaining = this.getLeavesForGroup(group);
				if (remaining.length === 0) this.forgetGroup(group);
				else {
					const record = this.groupRecords.get(group);
					if (record?.kind === 'managed' && (!record.bookId || !this.groupContainsBook(remaining, record.bookId))) this.registerFreeGroup(remaining[0]!);
				}
			}
			for (const leaf of createdEmptyLeaves) {
				if (isEmptyLeaf(leaf)) {
					this.forgetGroup(leaf.parent);
					leaf.detach();
				}
			}
			for (const root of suppressedPopouts) {
				let stillHasLeaves = false;
				this.plugin.app.workspace.iterateAllLeaves((leaf) => {
					if (getPopoutRoot(leaf) === root) stillHasLeaves = true;
				});
				if (stillHasLeaves) this.suppressedWindowReturns.delete(root);
			}
			if (this.plugin.settings.bookSplitDirection === 'grid') {
				const reflow = await this.repopulateManagedBooksInGrid(orderedBookIds, activeAfter);
				moved += reflow.moved;
				activeAfter = reflow.active ?? activeAfter;
			}
			this.capturePopoutSnapshots();
			this.syncBookOrder();
			if (activeAfter) this.focusLeaf(activeAfter);
			return moved;
		} finally {
			this.routing = false;
		}
	}

	private getCanonicalExcludedLeaf(): WorkspaceLeaf | null {
		const group = this.excludedGroup;
		if (!group) return null;
		const leaves = this.collectGroups().get(group) ?? [];
		if (leaves.length === 0 || !this.groupContainsOnlyExcludedFiles(leaves)) {
			this.forgetGroup(group);
			return null;
		}
		return this.plugin.app.workspace.getMostRecentLeaf(group) ?? leaves[0] ?? null;
	}

	private async repopulateManagedBooksInGrid(
		orderedBookIds: readonly string[],
		activeBefore: WorkspaceLeaf | null,
	): Promise<{ moved: number; active: WorkspaceLeaf | null }> {
		const booksById = new Map(this.plugin.scopeResolver.listBooks().map(book => [book.id, book]));
		const snapshots: Array<{
			book: BookScope;
			group: LeafParent;
			leaves: WorkspaceLeaf[];
			states: ViewState[];
			activeIndex: number;
			histories: Map<string, BookGroupHistory> | null;
		}> = [];
		const seenGroups = new Set<LeafParent>();
		for (const bookId of orderedBookIds) {
			const book = booksById.get(bookId);
			const representative = book ? this.getCanonicalBookLeaf(book) : null;
			if (!book || !representative || seenGroups.has(representative.parent)) continue;
			const leaves = this.getGroupLeaves(representative);
			if (!leaves.length || !leaves.every(leaf => this.plugin.scopeResolver.resolveFile(getLeafFile(leaf, this.plugin.app.vault))?.id === book.id)) continue;
			seenGroups.add(representative.parent);
			const recent = this.plugin.app.workspace.getMostRecentLeaf(representative.parent);
			snapshots.push({
				book,
				group: representative.parent,
				leaves,
				states: leaves.map(leaf => cloneViewState(leaf.getViewState())),
				activeIndex: Math.max(0, recent ? leaves.indexOf(recent) : 0),
				histories: this.bookHistories.get(representative.parent)
					? cloneBookHistories(this.bookHistories.get(representative.parent)!)
					: null,
			});
		}
		if (!snapshots.length) return { moved: 0, active: activeBefore };

		const activeSnapshot = snapshots.find(snapshot => activeBefore && snapshot.leaves.includes(activeBefore));
		const activeIndex = activeSnapshot && activeBefore ? activeSnapshot.leaves.indexOf(activeBefore) : -1;
		const firstSnapshot = snapshots[0]!;
		let anchor = getLocation(firstSnapshot.leaves[0]!) === 'main' ? firstSnapshot.leaves[0]! : null;
		let anchorCreated = false;
		if (!anchor) {
			const reference = this.findMainWorkspaceLeaf();
			if (!reference) return { moved: 0, active: activeBefore };
			anchor = isEmptyLeaf(reference) && !seenGroups.has(reference.parent)
				? reference
				: this.createBookLeafAt(reference, 'right');
			anchorCreated = true;
		}

		const detachedLeaves = new Set(snapshots.flatMap(snapshot => snapshot.group === anchor?.parent ? [] : snapshot.leaves));
		this.suppressPopoutReturnsForMoves(detachedLeaves);
		for (const snapshot of snapshots) {
			if (snapshot.group === anchor.parent) continue;
			this.forgetGroup(snapshot.group);
			for (const leaf of snapshot.leaves) leaf.detach();
		}
		this.plugin.decorations.clearGridBaseCellMarkers();
		this.plugin.runtimeState.gridBaseBookIds = [];
		void this.plugin.saveRuntimeState();

		const rebuilt = new Map<string, WorkspaceLeaf[]>();
		const restoredBookIds = new Set<string>();
		const partial = new Map<string, WorkspaceLeaf[]>();
		let moved = 0;
		try {
			if (anchorCreated) {
				const created = [anchor];
				partial.set(firstSnapshot.book.id, created);
				this.registerManagedGroup(anchor, firstSnapshot.book);
				await this.restoreViewStates(anchor, firstSnapshot.states, created, firstSnapshot.book);
				rebuilt.set(firstSnapshot.book.id, created);
				moved += firstSnapshot.states.length;
			} else {
				this.registerManagedGroup(anchor, firstSnapshot.book);
				rebuilt.set(firstSnapshot.book.id, this.getGroupLeaves(anchor));
			}
			if (firstSnapshot.histories) this.bookHistories.set(anchor.parent, firstSnapshot.histories);
			restoredBookIds.add(firstSnapshot.book.id);

			for (const snapshot of snapshots.slice(1)) {
				const first = this.createGridBookLeaf(anchor);
				const created = [first];
				partial.set(snapshot.book.id, created);
				this.registerManagedGroup(first, snapshot.book);
				await this.restoreViewStates(first, snapshot.states, created, snapshot.book);
				if (snapshot.histories) this.bookHistories.set(first.parent, snapshot.histories);
				rebuilt.set(snapshot.book.id, created);
				restoredBookIds.add(snapshot.book.id);
				moved += snapshot.states.length;
			}
		} catch (error) {
			console.error('Root Books Tabs could not fully rebuild the configured Grid.', error);
			for (const [bookId, leaves] of partial) {
				if (restoredBookIds.has(bookId)) continue;
				this.forgetCreatedGroup(leaves[0]);
				for (const leaf of leaves) if (leaf.view.containerEl.isConnected) leaf.detach();
			}
			for (const snapshot of snapshots) {
				if (restoredBookIds.has(snapshot.book.id)) continue;
				try {
					const reference = this.findReusableEmptyMainLeaf() ?? this.findMainWorkspaceLeaf();
					if (!reference) continue;
					const first = isEmptyLeaf(reference) ? reference : this.createBookLeafAt(reference, 'right');
					const created = [first];
					this.registerManagedGroup(first, snapshot.book);
					await this.restoreViewStates(first, snapshot.states, created, snapshot.book);
					if (snapshot.histories) this.bookHistories.set(first.parent, snapshot.histories);
					rebuilt.set(snapshot.book.id, created);
					restoredBookIds.add(snapshot.book.id);
					moved += snapshot.states.length;
				} catch (recoveryError) {
					console.error(`Root Books Tabs could not recover ${snapshot.book.name} after Grid placement failed.`, recoveryError);
				}
			}
			new Notice('Tabs were preserved where possible, but some books could not be placed in the configured grid.');
		}

		const activeLeaves = activeSnapshot ? rebuilt.get(activeSnapshot.book.id) : null;
		const connectedActive = activeBefore?.view.containerEl.isConnected === true ? activeBefore : null;
		const firstRebuilt = rebuilt.values().next().value?.[0] ?? null;
		return { moved, active: activeLeaves?.[Math.max(0, activeIndex)] ?? connectedActive ?? firstRebuilt };
	}

	getGroupLeaves(leaf: WorkspaceLeaf): WorkspaceLeaf[] {
		return this.getLeavesForGroup(leaf.parent);
	}

	private consumeExpectedFileExplorerOpen(path: string): boolean {
		const pending = this.pendingFileExplorerOpen;
		this.pendingFileExplorerOpen = null;
		return pending !== null && pending.expiresAt >= Date.now() && pending.path === path;
	}

	private async routeOpen(
		destinationLeaf: WorkspaceLeaf,
		file: TFile,
		openState: OpenViewState | undefined,
		original: WorkspaceLeaf['openFile'],
	): Promise<void> {
		const fromFileExplorer = this.consumeExpectedFileExplorerOpen(file.path);
		const sourceLeaf = this.plugin.app.workspace.getMostRecentLeaf();
		if (!sourceLeaf || destinationLeaf !== sourceLeaf) {
			if (sourceLeaf && destinationLeaf.parent !== sourceLeaf.parent && !this.groupRecords.has(destinationLeaf.parent)) {
				this.registerFreeGroup(destinationLeaf);
			}
			return original.call(destinationLeaf, file, openState);
		}

		const targetExcluded = this.plugin.scopeResolver.resolveExcludedFile(file);
		if (targetExcluded) return this.routeExcludedOpen(sourceLeaf, file, openState, original, fromFileExplorer ? 'focused-tab' : undefined);
		const targetBook = this.plugin.scopeResolver.resolveFile(file);
		if (!targetBook) return original.call(destinationLeaf, file, openState);
		if (fromFileExplorer && this.plugin.settings.fileExplorerOpenBehavior === 'book-instance') {
			return this.routeFileExplorerOpen(sourceLeaf, targetBook, file, openState, original);
		}
		const sourceFile = getLeafFile(sourceLeaf, this.plugin.app.vault);
		const sourceBook = this.plugin.scopeResolver.resolveFile(sourceFile);
		if (!sourceBook) {
			const sourceRecord = this.groupRecords.get(sourceLeaf.parent);
			if (sourceRecord?.kind === 'excluded') {
				const canonical = this.getCanonicalBookLeaf(targetBook);
				if (canonical) return this.openOrReuseInGroup(canonical, targetBook, file, openState, original, 'focused-tab');
				await this.openNewBookGroup(sourceLeaf, targetBook, file, openState, original);
				return;
			}
			if (sourceRecord?.kind === 'free' || (getLocation(sourceLeaf) === 'popout' && !sourceRecord)) {
				if (!sourceRecord) this.registerFreeGroup(sourceLeaf);
				return original.call(destinationLeaf, file, openState);
			}
			const canonical = this.getCanonicalBookLeaf(targetBook);
			if (canonical && canonical.parent !== sourceLeaf.parent) {
				return this.openOrReuseInGroup(canonical, targetBook, file, openState, original, 'focused-tab');
			}
			this.registerManagedGroup(destinationLeaf, targetBook);
			this.routing = true;
			try {
				await original.call(destinationLeaf, file, openState);
				this.recordInitialBookFile(destinationLeaf, targetBook, file.path);
				this.focusLeaf(destinationLeaf);
			} finally {
				this.routing = false;
			}
			return;
		}

		const sourceRecord = this.ensureSourceGroup(sourceLeaf, sourceBook);
		if (sourceRecord.kind === 'free') {
			return this.openOrReuseInGroup(sourceLeaf, targetBook, file, openState, original, this.getBookNoteOpenMode(targetBook));
		}
		if (sourceBook.id === targetBook.id) {
			return this.openOrReuseInGroup(sourceLeaf, targetBook, file, openState, original, this.getBookNoteOpenMode(targetBook));
		}

		const existing = this.getCanonicalBookLeaf(targetBook);
		if (existing) {
			return this.openOrReuseInGroup(existing, targetBook, file, openState, original, 'focused-tab');
		}
		await this.openNewBookGroup(sourceLeaf, targetBook, file, openState, original);
	}

	private async routeExcludedOpen(
		sourceLeaf: WorkspaceLeaf,
		file: TFile,
		openState: OpenViewState | undefined,
		original: WorkspaceLeaf['openFile'],
		mode?: BookNoteOpenMode,
	): Promise<void> {
		const existing = this.getCanonicalExcludedLeaf();
		if (existing) {
			await this.openOrReuseInExcludedGroup(existing, file, openState, original, mode);
			this.focusPopoutWindow(existing);
			return;
		}
		await this.openNewExcludedGroup(sourceLeaf, file, openState, original);
	}

	private async openOrReuseInExcludedGroup(
		referenceLeaf: WorkspaceLeaf,
		file: TFile,
		openState: OpenViewState | undefined,
		original: WorkspaceLeaf['openFile'],
		mode: BookNoteOpenMode = this.plugin.settings.bookNoteOpenMode,
	): Promise<void> {
		if (mode === 'same-tab') {
			this.routing = true;
			try {
				await original.call(referenceLeaf, file, openState);
				this.focusLeaf(referenceLeaf);
			} finally {
				this.routing = false;
			}
			return;
		}

		const existing = this.getGroupLeaves(referenceLeaf).find(leaf => getLeafFile(leaf, this.plugin.app.vault)?.path === file.path);
		if (existing) {
			this.routing = true;
			try {
				await original.call(existing, file, openState);
				this.focusLeaf(existing);
			} finally {
				this.routing = false;
			}
			return;
		}

		const previous = this.plugin.app.workspace.getMostRecentLeaf();
		const previousInGroup = this.plugin.app.workspace.getMostRecentLeaf(referenceLeaf.parent) ?? referenceLeaf;
		this.routing = true;
		try {
			this.plugin.app.workspace.setActiveLeaf(referenceLeaf, { focus: false });
			const next = this.plugin.app.workspace.getLeaf('tab');
			this.registerExcludedGroup(next);
			await original.call(next, file, openState);
			this.applyTabInsertDirection(referenceLeaf, next);
			if (mode === 'focused-tab') this.focusLeaf(next);
			else {
				this.plugin.app.workspace.setActiveLeaf(previousInGroup, { focus: false });
				if (previous) this.plugin.app.workspace.setActiveLeaf(previous, { focus: true });
			}
		} finally {
			this.routing = false;
		}
	}

	private async openNewExcludedGroup(
		sourceLeaf: WorkspaceLeaf,
		file: TFile,
		openState: OpenViewState | undefined,
		original: WorkspaceLeaf['openFile'],
	): Promise<boolean> {
		this.routing = true;
		let createdLeaf: WorkspaceLeaf | null = null;
		try {
			createdLeaf = this.plugin.settings.excludedFileGroupLocation === 'popout'
				? this.createPopoutLeaf(sourceLeaf)
				: this.createBookLeafAt(sourceLeaf, 'right');
			this.registerExcludedGroup(createdLeaf);
			await original.call(createdLeaf, file, openState);
			this.focusLeaf(createdLeaf);
			return true;
		} catch (error) {
			console.error('Root Books Tabs could not create the excluded-files group.', error);
			if (createdLeaf) {
				this.forgetGroup(createdLeaf.parent);
				createdLeaf.detach();
			}
			new Notice('Root books tabs could not create the excluded-files group. The current tab group was left unchanged.');
			return false;
		} finally {
			this.routing = false;
		}
	}

	private async routeFileExplorerOpen(
		sourceLeaf: WorkspaceLeaf,
		book: BookScope,
		file: TFile,
		openState: OpenViewState | undefined,
		original: WorkspaceLeaf['openFile'],
	): Promise<void> {
		const destination = this.getLatestBookGroupInstance(book);
		if (!destination) {
			await this.openNewBookGroup(sourceLeaf, book, file, openState, original);
			return;
		}
		await this.openOrReuseInGroup(destination, book, file, openState, original, this.getBookNoteOpenMode(book));
		this.focusPopoutWindow(destination);
	}

	private async openOrReuseInGroup(
		referenceLeaf: WorkspaceLeaf,
		book: BookScope,
		file: TFile,
		openState: OpenViewState | undefined,
		original: WorkspaceLeaf['openFile'],
		mode: BookNoteOpenMode,
	): Promise<void> {
		if (mode === 'same-tab') {
			this.ensureBookHistory(referenceLeaf, book);
			this.routing = true;
			try {
				await original.call(referenceLeaf, file, openState);
				this.recordPageNavigation(referenceLeaf, book, file.path);
				this.focusLeaf(referenceLeaf);
			} finally {
				this.routing = false;
			}
			return;
		}

		const existing = this.getGroupLeaves(referenceLeaf).find((leaf) => getLeafFile(leaf, this.plugin.app.vault)?.path === file.path);
		if (existing) {
			this.routing = true;
			try {
				await original.call(existing, file, openState);
				this.focusLeaf(existing);
			} finally {
				this.routing = false;
			}
			return;
		}

		const previous = this.plugin.app.workspace.getMostRecentLeaf();
		const previousInGroup = this.plugin.app.workspace.getMostRecentLeaf(referenceLeaf.parent) ?? referenceLeaf;
		this.routing = true;
		try {
			this.plugin.app.workspace.setActiveLeaf(referenceLeaf, { focus: false });
			const newLeaf = this.plugin.app.workspace.getLeaf('tab');
			this.copyGroupRegistration(referenceLeaf, newLeaf);
			await original.call(newLeaf, file, openState);
			this.applyTabInsertDirection(referenceLeaf, newLeaf);
			if (mode === 'focused-tab') this.focusLeaf(newLeaf);
			else {
				this.plugin.app.workspace.setActiveLeaf(previousInGroup, { focus: false });
				if (previous) this.plugin.app.workspace.setActiveLeaf(previous, { focus: true });
			}
		} finally {
			this.routing = false;
		}
	}

	private async openNewBookGroup(
		sourceLeaf: WorkspaceLeaf,
		targetBook: BookScope,
		file: TFile,
		openState: OpenViewState | undefined,
		original: WorkspaceLeaf['openFile'],
		forcedLocation?: ManagedGroupLocation,
	): Promise<boolean> {
		this.routing = true;
		let createdLeaf: WorkspaceLeaf | null = null;
		try {
			const usePopout = forcedLocation === 'popout'
				|| (forcedLocation === undefined && (this.plugin.vaultConfig.values.openBooksInExternalWindows === true));
			const leaf = usePopout
				? this.createPopoutLeaf(sourceLeaf)
				: this.createMainBookLeaf(sourceLeaf);
			createdLeaf = leaf;
			this.registerManagedGroup(leaf, targetBook);
			await original.call(leaf, file, openState);
			this.recordInitialBookFile(leaf, targetBook, file.path);
			this.syncBookOrder();
			this.focusLeaf(leaf);
			return true;
		} catch (error) {
			console.error('Root Books Tabs could not create a book group.', error);
			if (createdLeaf) {
				this.forgetGroup(createdLeaf.parent);
				createdLeaf.detach();
			}
			new Notice('Root books tabs could not create the requested book window. The current book was left unchanged.');
			return false;
		} finally {
			this.routing = false;
		}
	}

	private async transferGroup(
		sourceLeaf: WorkspaceLeaf,
		target: ManagedGroupLocation,
		placement?: GroupTransferPlacement,
	): Promise<void> {
		const book = this.getBookForGroup(sourceLeaf);
		if (!book) return;
		const sourceManaged = this.isManagedGroup(sourceLeaf);
		const sourceGroup = sourceLeaf.parent;
		const sourceHistories = this.bookHistories.get(sourceGroup);
		const groupLeaves = this.getGroupLeaves(sourceLeaf);
		const states = groupLeaves.map((leaf) => leaf.getViewState());
		const active = this.plugin.app.workspace.getMostRecentLeaf(sourceGroup);
		const activeIndex = Math.max(0, active ? groupLeaves.indexOf(active) : 0);
		const created: WorkspaceLeaf[] = [];
		this.routing = true;
		try {
			const first = placement
				? this.createBookLeafAt(placement.referenceLeaf, placement.direction)
				: target === 'popout'
					? this.createPopoutLeaf(sourceLeaf)
					: this.createMainBookLeaf(this.findMainWorkspaceLeaf() ?? sourceLeaf);
			created.push(first);
			if (sourceManaged) this.registerManagedGroup(first, book);
			else this.registerFreeGroup(first);
			await this.restoreViewStates(first, states, created, book, sourceManaged);
			if (sourceHistories) this.bookHistories.set(first.parent, cloneBookHistories(sourceHistories));
			this.capturePopoutSnapshots();
			this.focusLeaf(created[activeIndex] ?? first);
		} catch (error) {
			console.error(`Root Books Tabs could not move a book group to ${target}.`, error);
			for (const leaf of created) leaf.detach();
			this.forgetCreatedGroup(created[0]);
			if (sourceManaged) this.registerManagedGroup(sourceLeaf, book);
			else this.registerFreeGroup(sourceLeaf);
			new Notice(`Root Books Tabs could not move this book to the ${target === 'main' ? 'main workspace' : 'pop-out'}. The original group was left in place.`);
			return;
		} finally {
			this.routing = false;
		}
		const sourcePopout = getPopoutRoot(sourceLeaf);
		const destinationPopout = getPopoutRoot(created[0] ?? sourceLeaf);
		if (sourcePopout && sourcePopout !== destinationPopout) this.suppressedWindowReturns.add(sourcePopout);
		this.forgetGroup(sourceGroup);
		for (const leaf of groupLeaves) leaf.detach();
		if (target === 'main' && !placement) this.moveBookToEnd(book.id);
	}

	private async restoreViewStates(
		first: WorkspaceLeaf,
		states: ViewState[],
		created: WorkspaceLeaf[],
		book: BookScope,
		managed = true,
	): Promise<void> {
		const firstState = states[0];
		if (!firstState) return;
		await first.setViewState(firstState);
		let reference = first;
		for (const state of states.slice(1)) {
			this.plugin.app.workspace.setActiveLeaf(reference, { focus: false });
			const next = this.plugin.app.workspace.getLeaf('tab');
			created.push(next);
			if (managed) this.registerManagedGroup(next, book);
			else this.registerFreeGroup(next);
			await next.setViewState(state);
			this.applyTabInsertDirection(reference, next);
			reference = next;
		}
	}

	private createMainBookLeaf(reference: WorkspaceLeaf): WorkspaceLeaf {
		const mainReference = this.findMainPlacementReference(reference);
		if (!mainReference) throw new Error('No main-workspace leaf is available.');
		if (this.plugin.settings.bookSplitDirection === 'grid') {
			return this.createGridBookLeaf(mainReference);
		}
		const configuredDirection = this.plugin.settings.bookSplitDirection;
		const cardinalDirection: CardinalDirection = configuredDirection === 'left'
			|| configuredDirection === 'right'
			|| configuredDirection === 'up'
			|| configuredDirection === 'down'
			? configuredDirection
			: 'right';
		const direction = this.resolveSplitDirection(cardinalDirection);
		return this.plugin.app.workspace.createLeafBySplit(mainReference, direction.axis, direction.before);
	}

	private createPopoutLeaf(source: WorkspaceLeaf): WorkspaceLeaf {
		const init = getSourcePopoutInit(source);
		return init ? this.plugin.app.workspace.openPopoutLeaf(init) : this.plugin.app.workspace.openPopoutLeaf();
	}

	private createBookLeafAt(reference: WorkspaceLeaf, direction: CardinalDirection, forceNested = false): WorkspaceLeaf {
		const split = this.resolveSplitDirection(direction);
		const rollbackNestedWrapper = forceNested
			? wrapTabGroupForNestedSplit(this.plugin.app.workspace, reference, split.axis)
			: null;
		try {
			return this.plugin.app.workspace.createLeafBySplit(reference, split.axis, split.before);
		} catch (error) {
			rollbackNestedWrapper?.();
			throw error;
		}
	}

	private createGridBookLeaf(fallback: WorkspaceLeaf): WorkspaceLeaf {
		const orderedMainLeaves = this.getOrderedMainBookLeaves();
		const capacity = this.plugin.settings.gridRows * this.plugin.settings.gridColumns;
		if (orderedMainLeaves.length < capacity) {
			return this.createRowMajorGridBaseLeaf(
				orderedMainLeaves,
				fallback,
				getRowMajorGridCreationSteps(this.plugin.settings.gridRows, this.plugin.settings.gridColumns),
				capacity,
			);
		}
		const baseLeaves = this.syncGridBaseLeaves(orderedMainLeaves, capacity);
		const overflowStep = orderedMainLeaves.length - capacity;
		const reference = baseLeaves[overflowStep % baseLeaves.length] ?? orderedMainLeaves[0] ?? fallback;
		this.getGridBaseCellElement(reference);
		return this.createBookLeafAt(reference, this.plugin.settings.gridOverflowDirection, true);
	}

	/** Recover the stable outer base-cell wrapper after CSS classes are lost on reload. */
	getGridBaseCellElement(leaf: WorkspaceLeaf): HTMLElement | null {
		const group: unknown = leaf.parent;
		if (!isUnknownRecord(group) || !isHtmlElement(group.containerEl, leaf.view.containerEl.ownerDocument)) return null;
		const marked = group.containerEl.closest<HTMLElement>('.scope-tabs-grid-base-cell');
		if (marked) return marked;
		const baseIds = new Set(this.plugin.runtimeState.gridBaseBookIds.slice(0, this.plugin.settings.gridRows * this.plugin.settings.gridColumns));
		const otherBaseGroups: HTMLElement[] = [];
		this.plugin.app.workspace.iterateAllLeaves(candidate => {
			if (candidate.parent === leaf.parent || this.getGroupLocation(candidate) !== 'main' || !this.isManagedGroup(candidate)) return;
			const book = this.getBookForGroup(candidate);
			const candidateGroup: unknown = candidate.parent;
			if (!book || !baseIds.has(book.id) || !isUnknownRecord(candidateGroup) || !isHtmlElement(candidateGroup.containerEl, leaf.view.containerEl.ownerDocument)) return;
			if (!otherBaseGroups.includes(candidateGroup.containerEl)) otherBaseGroups.push(candidateGroup.containerEl);
		});
		let cell = group.containerEl;
		let ancestor: unknown = group.parent;
		while (isUnknownRecord(ancestor) && isHtmlElement(ancestor.containerEl, leaf.view.containerEl.ownerDocument)) {
			const ancestorEl = ancestor.containerEl;
			if (otherBaseGroups.some(other => ancestorEl.contains(other))) break;
			cell = ancestorEl;
			ancestor = ancestor.parent;
		}
		if (cell !== group.containerEl) cell.addClass('scope-tabs-grid-base-cell');
		return cell;
	}

	private createRowMajorGridBaseLeaf(
		orderedMainLeaves: WorkspaceLeaf[],
		fallback: WorkspaceLeaf,
		steps: GridCreationStep[],
		capacity: number,
	): WorkspaceLeaf {
		const baseLeaves = this.syncGridBaseLeaves(orderedMainLeaves, capacity);
		const step = steps[orderedMainLeaves.length - 1];
		const latestLeaf = orderedMainLeaves[orderedMainLeaves.length - 1] ?? fallback;
		if (!step) return this.createBookLeafAt(latestLeaf, 'right');
		const reference = baseLeaves[step.referenceIndex] ?? latestLeaf;
		return this.createBookLeafAt(reference, step.direction);
	}

	private getOrderedMainBookLeaves(): WorkspaceLeaf[] {
		const booksById = new Map(this.plugin.scopeResolver.listBooks().map((book) => [book.id, book]));
		const result: WorkspaceLeaf[] = [];
		const seenGroups = new Set<LeafParent>();
		for (const id of this.syncBookOrder()) {
			const book = booksById.get(id);
			if (!book) continue;
			const leaf = this.getCanonicalBookLeaf(book);
			if (!leaf || getLocation(leaf) !== 'main' || seenGroups.has(leaf.parent)) continue;
			seenGroups.add(leaf.parent);
			result.push(leaf);
		}
		return result;
	}

	private syncGridBaseLeaves(orderedMainLeaves: WorkspaceLeaf[], capacity: number): WorkspaceLeaf[] {
		const leavesByBookId = new Map<string, WorkspaceLeaf>();
		for (const leaf of orderedMainLeaves) {
			const book = this.getBookForGroup(leaf);
			if (book) leavesByBookId.set(book.id, leaf);
		}
		const nextIds = this.plugin.runtimeState.gridBaseBookIds.filter((id) => leavesByBookId.has(id)).slice(0, capacity);
		for (const leaf of orderedMainLeaves) {
			if (nextIds.length >= capacity) break;
			const book = this.getBookForGroup(leaf);
			if (book && !nextIds.includes(book.id)) nextIds.push(book.id);
		}
		const currentIds = this.plugin.runtimeState.gridBaseBookIds;
		if (currentIds.length !== nextIds.length || currentIds.some((id, index) => id !== nextIds[index])) {
			this.plugin.runtimeState.gridBaseBookIds = nextIds;
			void this.plugin.saveRuntimeState();
		}
		return nextIds.map((id) => leavesByBookId.get(id)).filter((leaf): leaf is WorkspaceLeaf => leaf !== undefined);
	}

	private findMainWorkspaceLeaf(): WorkspaceLeaf | null {
		let result: WorkspaceLeaf | null = null;
		this.plugin.app.workspace.iterateAllLeaves((leaf) => {
			if (!result && getLocation(leaf) === 'main') result = leaf;
		});
		return result;
	}

	private suppressPopoutReturnsForMoves(movingLeaves: Set<WorkspaceLeaf>): WorkspaceWindow[] {
		const roots = new Map<WorkspaceWindow, WorkspaceLeaf[]>();
		this.plugin.app.workspace.iterateAllLeaves((leaf) => {
			const root = getPopoutRoot(leaf);
			if (!root) return;
			const leaves = roots.get(root) ?? [];
			leaves.push(leaf);
			roots.set(root, leaves);
		});
		const suppressed: WorkspaceWindow[] = [];
		for (const [root, leaves] of roots) {
			if (leaves.length === 0 || !leaves.every((leaf) => movingLeaves.has(leaf))) continue;
			this.suppressedWindowReturns.add(root);
			suppressed.push(root);
		}
		return suppressed;
	}

	private findReusableEmptyMainLeaf(): WorkspaceLeaf | null {
		const recent = this.plugin.app.workspace.getMostRecentLeaf();
		if (recent && getLocation(recent) === 'main' && isEmptyLeaf(recent)) return recent;
		let result: WorkspaceLeaf | null = null;
		this.plugin.app.workspace.iterateAllLeaves((leaf) => {
			if (!result && getLocation(leaf) === 'main' && isEmptyLeaf(leaf)) result = leaf;
		});
		return result;
	}

	private findMainPlacementReference(fallback: WorkspaceLeaf): WorkspaceLeaf | null {
		const booksById = new Map(this.plugin.scopeResolver.listBooks().map((book) => [book.id, book]));
		for (const id of [...this.syncBookOrder()].reverse()) {
			const book = booksById.get(id);
			if (!book) continue;
			const leaf = this.getCanonicalBookLeaf(book);
			if (leaf && getLocation(leaf) === 'main') return leaf;
		}
		return getLocation(fallback) === 'main' ? fallback : this.findMainWorkspaceLeaf();
	}

	private findSoleFileLeaf(): WorkspaceLeaf | null {
		const fileLeaves: WorkspaceLeaf[] = [];
		this.plugin.app.workspace.iterateAllLeaves((leaf) => {
			if (getLeafFile(leaf, this.plugin.app.vault)) fileLeaves.push(leaf);
		});
		return fileLeaves.length === 1 ? fileLeaves[0] ?? null : null;
	}

	private async openBookInLeaf(leaf: WorkspaceLeaf, book: BookScope, file: TFile): Promise<void> {
		if (!this.originalOpenFile) return;
		this.routing = true;
		try {
			this.registerManagedGroup(leaf, book);
			await this.originalOpenFile.call(leaf, file);
			this.recordInitialBookFile(leaf, book, file.path);
			this.syncBookOrder();
			this.focusLeaf(leaf);
		} finally {
			this.routing = false;
		}
	}

	private resolveBookEntryFile(book: BookScope): TFile | null {
		const configured = this.plugin.app.vault.getFileByPath(`${book.folderPath}/${this.plugin.settings.configFileBaseName}.md`);
		if (configured) return configured;
		const root = this.plugin.app.vault.getFolderByPath(book.folderPath);
		if (!root) return null;
		return collectBookFiles(root).sort(compareBookEntryFiles)[0] ?? null;
	}

	private ensureBookHistory(leaf: WorkspaceLeaf, book: BookScope): BookGroupHistory {
		let groupHistories = this.bookHistories.get(leaf.parent);
		if (!groupHistories) {
			groupHistories = new Map<string, BookGroupHistory>();
			this.bookHistories.set(leaf.parent, groupHistories);
		}
		const mode = this.getBookNoteOpenMode(book);
		const existing = groupHistories.get(book.id);
		if (existing?.mode === mode) return existing;

		const recent = this.plugin.app.workspace.getMostRecentLeaf(leaf.parent);
		const currentFile = getLeafFile(recent ?? leaf, this.plugin.app.vault);
		const entries: BookHistoryEntry[] = currentFile && this.plugin.scopeResolver.resolveFile(currentFile)?.id === book.id
			? [{ path: currentFile.path }]
			: [];
		const history: BookGroupHistory = {
			bookId: book.id,
			entries,
			index: entries.length - 1,
			mode,
		};
		groupHistories.set(book.id, history);
		return history;
	}

	private pruneBookHistory(book: BookScope, history: BookGroupHistory): void {
		const oldIndex = history.index;
		let keptThroughIndex = -1;
		const entries: BookHistoryEntry[] = [];
		for (const [index, entry] of history.entries.entries()) {
			const keep = this.plugin.scopeResolver.resolveFile(this.plugin.app.vault.getFileByPath(entry.path))?.id === book.id;
			if (!keep) continue;
			entries.push(entry);
			if (index <= oldIndex) keptThroughIndex = entries.length - 1;
		}
		history.entries = entries;
		history.index = entries.length === 0
			? -1
			: Math.min(entries.length - 1, Math.max(0, keptThroughIndex));
	}

	private recordInitialBookFile(leaf: WorkspaceLeaf, book: BookScope, path: string): void {
		if (this.getBookNoteOpenMode(book) === 'same-tab') this.recordPageNavigation(leaf, book, path);
	}

	private recordPageNavigation(leaf: WorkspaceLeaf, book: BookScope, path: string): void {
		const history = this.ensureBookHistory(leaf, book);
		this.recordHistoryEntry(history, { path });
	}

	private recordHistoryEntry(history: BookGroupHistory, entry: BookHistoryEntry): void {
		const current = history.entries[history.index];
		if (current?.path === entry.path) return;
		const insertionIndex = history.index + 1;
		history.entries.splice(insertionIndex, history.entries.length - insertionIndex, entry);
		history.index = insertionIndex;
	}

	private ensureSourceGroup(leaf: WorkspaceLeaf, book: BookScope): PersistedGroupRecord {
		const current = this.groupRecords.get(leaf.parent);
		if (current) return current;
		if (getLocation(leaf) === 'popout') return this.registerFreeGroup(leaf);
		const canonical = this.getCanonicalBookLeaf(book);
		if (canonical && canonical.parent !== leaf.parent) return this.registerFreeGroup(leaf);
		return this.registerManagedGroup(leaf, book);
	}

	private restoreGroupRegistry(): void {
		this.reconcileGroupRegistry();
		const groups = this.collectGroups();
		const currentIds = new Set<string>();
		for (const group of groups.keys()) {
			const id = getGroupId(group);
			if (id) currentIds.add(id);
		}

		for (const id of Object.keys(this.plugin.runtimeState.groups)) {
			if (!currentIds.has(id)) delete this.plugin.runtimeState.groups[id];
		}
		void this.plugin.saveRuntimeState();
	}

	private registerManagedGroup(leaf: WorkspaceLeaf, book: BookScope): PersistedGroupRecord {
		const existing = this.groupRecords.get(leaf.parent);
		const newlyAssociated = existing?.kind !== 'managed' || existing.bookId !== book.id;
		if (existing?.kind === 'managed' && existing.bookId && existing.bookId !== book.id && this.canonicalGroups.get(existing.bookId) === leaf.parent) {
			this.canonicalGroups.delete(existing.bookId);
		}
		if (this.excludedGroup === leaf.parent) this.excludedGroup = null;
		const record: PersistedGroupRecord = { kind: 'managed', bookId: book.id, location: getLocation(leaf) };
		this.groupRecords.set(leaf.parent, record);
		this.canonicalGroups.set(book.id, leaf.parent);
		if (newlyAssociated) this.markGroupOpened(leaf.parent);
		this.persistGroup(leaf.parent, record);
		return record;
	}

	private registerFreeGroup(leaf: WorkspaceLeaf): PersistedGroupRecord {
		const existing = this.groupRecords.get(leaf.parent);
		const newlyAssociated = !existing || existing.kind !== 'free';
		if (existing?.kind === 'managed' && existing.bookId && this.canonicalGroups.get(existing.bookId) === leaf.parent) {
			this.canonicalGroups.delete(existing.bookId);
		}
		if (this.excludedGroup === leaf.parent) this.excludedGroup = null;
		const record: PersistedGroupRecord = { kind: 'free', location: getLocation(leaf) };
		this.groupRecords.set(leaf.parent, record);
		if (newlyAssociated) this.markGroupOpened(leaf.parent);
		this.persistGroup(leaf.parent, record);
		return record;
	}

	private registerExcludedGroup(leaf: WorkspaceLeaf): PersistedGroupRecord {
		const existing = this.groupRecords.get(leaf.parent);
		if (existing?.kind === 'managed' && existing.bookId && this.canonicalGroups.get(existing.bookId) === leaf.parent) {
			this.canonicalGroups.delete(existing.bookId);
		}
		if (this.excludedGroup && this.excludedGroup !== leaf.parent) {
			const previous = this.getLeavesForGroup(this.excludedGroup)[0];
			if (previous) this.registerFreeGroup(previous);
		}
		const record: PersistedGroupRecord = { kind: 'excluded', location: getLocation(leaf) };
		this.groupRecords.set(leaf.parent, record);
		this.excludedGroup = leaf.parent;
		if (existing?.kind !== 'excluded') this.markGroupOpened(leaf.parent);
		this.persistGroup(leaf.parent, record);
		return record;
	}

	private copyGroupRegistration(reference: WorkspaceLeaf, created: WorkspaceLeaf): void {
		const record = this.groupRecords.get(reference.parent);
		if (!record) return;
		this.groupRecords.set(created.parent, record);
		this.persistGroup(created.parent, record);
	}

	private persistGroup(group: LeafParent, record: PersistedGroupRecord): void {
		const id = getGroupId(group);
		if (!id) return;
		this.plugin.runtimeState.groups[id] = record;
		void this.plugin.saveRuntimeState();
	}

	private syncBookOrder(): string[] {
		const validBookIds = new Set(this.plugin.scopeResolver.listBooks().map((book) => book.id));
		const openBookIds = this.getOpenBookIds();
		const selectedBookId = this.plugin.settings.selectedBookId;
		const next = this.plugin.runtimeState.bookOrder.filter((id) =>
			validBookIds.has(id) && (openBookIds.has(id) || id === selectedBookId));
		for (const id of openBookIds) {
			if (validBookIds.has(id) && !next.includes(id)) next.push(id);
		}
		if (selectedBookId && validBookIds.has(selectedBookId)) {
			const index = next.indexOf(selectedBookId);
			if (index >= 0) next.splice(index, 1);
			next.unshift(selectedBookId);
		}
		this.persistBookOrder(next);
		return [...next];
	}

	private moveBookToEnd(bookId: string): void {
		if (this.plugin.settings.selectedBookId === bookId) {
			this.setPrimaryBook(bookId);
			return;
		}
		const current = this.syncBookOrder().filter((id) => id !== bookId);
		this.persistBookOrder([...current, bookId]);
	}

	private persistBookOrder(next: string[]): void {
		const current = this.plugin.runtimeState.bookOrder;
		if (current.length === next.length && current.every((id, index) => id === next[index])) return;
		this.plugin.runtimeState.bookOrder = [...next];
		void this.plugin.saveRuntimeState();
	}

	private forgetGroup(group: LeafParent): void {
		const record = this.groupRecords.get(group);
		if (record?.kind === 'managed' && record.bookId && this.canonicalGroups.get(record.bookId) === group) {
			this.canonicalGroups.delete(record.bookId);
		}
		if (this.excludedGroup === group) this.excludedGroup = null;
		this.groupRecords.delete(group);
		this.bookHistories.delete(group);
		this.groupOpenOrder.delete(group);
		const id = getGroupId(group);
		if (id) delete this.plugin.runtimeState.groups[id];
		void this.plugin.saveRuntimeState();
	}

	private forgetCreatedGroup(leaf: WorkspaceLeaf | undefined): void {
		if (leaf) this.forgetGroup(leaf.parent);
	}

	private inferGroupBook(leaves: WorkspaceLeaf[]): BookScope | null {
		const scopes = leaves
			.map((leaf) => this.plugin.scopeResolver.resolveFile(getLeafFile(leaf, this.plugin.app.vault)))
			.filter((scope): scope is BookScope => scope !== null);
		const first = scopes[0];
		return first && scopes.every((scope) => scope.id === first.id) ? first : null;
	}

	private groupContainsBook(leaves: WorkspaceLeaf[], bookId: string): boolean {
		return leaves.some((leaf) => this.plugin.scopeResolver.resolveFile(getLeafFile(leaf, this.plugin.app.vault))?.id === bookId);
	}

	private groupContainsOnlyExcludedFiles(leaves: WorkspaceLeaf[]): boolean {
		const files = leaves.map(leaf => getLeafFile(leaf, this.plugin.app.vault)).filter((file): file is TFile => file !== null);
		return files.length > 0 && files.every(file => this.plugin.scopeResolver.resolveExcludedFile(file) !== null);
	}

	private countGroupBooks(leaves: WorkspaceLeaf[]): number {
		return new Set(leaves.map((leaf) => this.plugin.scopeResolver.resolveFile(getLeafFile(leaf, this.plugin.app.vault))?.id).filter(Boolean)).size;
	}

	private capturePopoutSnapshots(): void {
		for (const [group, leaves] of this.collectGroups()) {
			const leaf = leaves[0];
			if (!leaf || !this.isManagedGroup(leaf)) continue;
			const root = getPopoutRoot(leaf);
			const book = this.getBookForGroup(leaf);
			if (!root || !book) continue;
			const active = this.plugin.app.workspace.getMostRecentLeaf(group);
			this.popoutSnapshots.set(root, {
				bookId: book.id,
				states: leaves.map((item) => cloneViewState(item.getViewState())),
				activeIndex: Math.max(0, active ? leaves.indexOf(active) : 0),
			});
		}
	}

	private async restoreClosedPopout(workspaceWindow: WorkspaceWindow, snapshot: GroupSnapshot): Promise<void> {
		this.reconcileGroupRegistry();
		const book = this.plugin.scopeResolver.listBooks().find((candidate) => candidate.id === snapshot.bookId);
		if (!book) return;
		const existing = this.getCanonicalBookLeaf(book);
		if (existing && existing.getRoot() !== workspaceWindow) {
			this.focusLeaf(existing);
			return;
		}
		if (existing) this.forgetGroup(existing.parent);
		const reference = this.findReusableEmptyMainLeaf() ?? this.findMainWorkspaceLeaf();
		if (!reference) return;
		const first = isEmptyLeaf(reference) ? reference : this.createMainBookLeaf(reference);
		const created = [first];
		this.routing = true;
		try {
			this.registerManagedGroup(first, book);
			await this.restoreViewStates(first, snapshot.states, created, book);
			this.moveBookToEnd(book.id);
			this.focusLeaf(created[snapshot.activeIndex] ?? first);
		} catch (error) {
			console.error('Root Books Tabs could not restore a closed pop-out book.', error);
			for (const leaf of created) leaf.detach();
			this.forgetCreatedGroup(created[0]);
			new Notice('Root books tabs could not return the closed pop-out book to the main workspace.');
		} finally {
			this.routing = false;
		}
	}

	private focusLeaf(leaf: WorkspaceLeaf): void {
		this.plugin.app.workspace.setActiveLeaf(leaf, { focus: true });
		this.focusPopoutWindow(leaf);
	}

	private focusPopoutWindow(leaf: WorkspaceLeaf): void {
		const root = getPopoutRoot(leaf);
		if (root) {
			try {
				root.win.focus();
			} catch {
				// A pop-out can finish closing between route resolution and focus.
			}
		}
	}

	private markGroupOpened(group: LeafParent): void {
		this.groupOpenOrder.set(group, ++this.groupOpenClock);
	}

	private collectGroups(): Map<LeafParent, WorkspaceLeaf[]> {
		const groups = new Map<LeafParent, WorkspaceLeaf[]>();
		this.plugin.app.workspace.iterateAllLeaves((leaf) => {
			const list = groups.get(leaf.parent) ?? [];
			list.push(leaf);
			groups.set(leaf.parent, list);
		});
		return groups;
	}

	private getLeavesForGroup(group: LeafParent): WorkspaceLeaf[] {
		const mutable = getMutableTabGroupFromParent(group);
		if (mutable) return [...mutable.children];
		const leaves: WorkspaceLeaf[] = [];
		this.plugin.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.parent === group) leaves.push(leaf);
		});
		return leaves;
	}

	private getOrderedBookLeaves(reference: WorkspaceLeaf, bookId: string): WorkspaceLeaf[] {
		return this.getGroupLeaves(reference).filter((candidate) =>
			this.plugin.scopeResolver.resolveFile(getLeafFile(candidate, this.plugin.app.vault))?.id === bookId);
	}

	private applyTabInsertDirection(reference: WorkspaceLeaf, created: WorkspaceLeaf): void {
		const parent = getMutableTabGroup(created);
		if (!parent || reference.parent !== created.parent) return;
		const referenceIndex = parent.children.indexOf(reference);
		const createdIndex = parent.children.indexOf(created);
		const book = this.plugin.scopeResolver.resolveFile(getLeafFile(reference, this.plugin.app.vault));
		const config = book ? this.plugin.app.vault.getFileByPath(this.plugin.colors.getConfigPath(book)) : null;
		const frontmatter = config ? this.plugin.app.metadataCache.getFileCache(config)?.frontmatter : null;
		const override: unknown = frontmatter ? readPluginFrontmatter(frontmatter, 'tabInsertDirection') : null;
		const insertRight = (override === 'right' || override === 'end' ? override : this.plugin.vaultConfig.values.tabInsertDirection ?? this.plugin.settings.tabInsertDirection) === 'right';
		if (referenceIndex < 0 || createdIndex < 0) return;
		if (insertRight && createdIndex === referenceIndex + 1) return;
		if (!insertRight && createdIndex === parent.children.length - 1) return;
		let removed = false;
		try {
			parent.removeChild(created);
			removed = true;
			if (insertRight) {
				const updatedReferenceIndex = parent.children.indexOf(reference);
				if (updatedReferenceIndex < 0) throw new Error('Reference tab disappeared during tab reordering.');
				parent.insertChild(updatedReferenceIndex + 1, created);
			} else {
				parent.insertChild(parent.children.length, created);
			}
			removed = false;
		} catch {
			// Tab ordering is a compatibility enhancement; routing is already complete.
			if (removed) {
				try {
					parent.insertChild(Math.min(createdIndex, parent.children.length), created);
				} catch {
					// Obsidian rejected both the requested move and its best-effort rollback.
				}
			}
		}
	}

	private resolveSplitDirection(direction: CardinalDirection): { axis: 'vertical' | 'horizontal'; before: boolean } {
		switch (direction) {
			case 'left': return { axis: 'vertical', before: true };
			case 'down': return { axis: 'horizontal', before: false };
			case 'up': return { axis: 'horizontal', before: true };
			case 'right':
			default: return { axis: 'vertical', before: false };
		}
	}
}

function cloneBookHistories(source: Map<string, BookGroupHistory>): Map<string, BookGroupHistory> {
	return new Map([...source].map(([bookId, history]) => [bookId, {
		...history,
		entries: history.entries.map((entry) => ({ ...entry })),
	}]));
}

function getRowMajorGridCreationSteps(rows: number, columns: number): GridCreationStep[] {
	return Array.from({ length: rows * columns - 1 }, (_, offset) => {
		const index = offset + 1;
		return index < columns
			? { referenceIndex: index - 1, direction: 'right' }
			: { referenceIndex: index - columns, direction: 'down' };
	});
}

function findGroupRepresentative(
	groups: Map<LeafParent, WorkspaceLeaf[]>,
	usedGroups: Set<LeafParent>,
	predicate: (group: LeafParent) => boolean,
): WorkspaceLeaf | null {
	for (const [group, leaves] of groups) {
		if (usedGroups.has(group) || !predicate(group)) continue;
		const representative = leaves[0];
		if (representative) return representative;
	}
	return null;
}

interface MutableTabGroupCompatibility {
	children: WorkspaceLeaf[];
	removeChild: (leaf: WorkspaceLeaf) => void;
	insertChild: (index: number, leaf: WorkspaceLeaf) => void;
}

/**
 * Obsidian flattens a same-axis `createLeafBySplit` into the surrounding split.
 * Grid overflow must halve only a base cell, so this optional adapter wraps that tab group
 * in a fresh nested split before the public split operation creates the new tab group.
 */
function wrapTabGroupForNestedSplit(
	workspace: Workspace,
	reference: WorkspaceLeaf,
	direction: 'vertical' | 'horizontal',
): (() => void) | null {
	// The first overflow creates the isolated base-cell split. Once it exists,
	// let Obsidian flatten later same-axis splits into that cell so its books
	// remain equal siblings instead of an increasingly lopsided binary chain.
	if (reference.view.containerEl.closest('.scope-tabs-grid-base-cell')) return null;
	const group: unknown = reference.parent;
	if (!isUnknownRecord(group)) return null;
	const parent = group.parent;
	if (!isUnknownRecord(parent) || !Array.isArray(parent.children)) return null;
	const parentChildren: unknown[] = parent.children;
	const index = parentChildren.indexOf(group);
	const replaceChild = parent.replaceChild;
	const SplitConstructor = parent.constructor;
	if (index < 0 || typeof replaceChild !== 'function' || typeof SplitConstructor !== 'function') return null;

	let nested: unknown;
	try {
		nested = Reflect.construct(SplitConstructor, [workspace, direction]);
	} catch {
		return null;
	}
	if (!isUnknownRecord(nested) || typeof nested.insertChild !== 'function') return null;

	const groupDimension = group.dimension;
	const setGroupDimension = group.setDimension;
	const setNestedDimension = nested.setDimension;
	try {
		if (typeof setGroupDimension === 'function') Reflect.apply(setGroupDimension, group, [null]);
		Reflect.apply(replaceChild, parent, [index, nested]);
		if (typeof setNestedDimension === 'function') Reflect.apply(setNestedDimension, nested, [groupDimension ?? null]);
		Reflect.apply(nested.insertChild, nested, [0, group]);
		const nestedContainer = nested.containerEl;
		if (isHtmlElement(nestedContainer, reference.view.containerEl.ownerDocument)
			&& !reference.view.containerEl.closest('.scope-tabs-grid-base-cell')) {
			nestedContainer.addClass('scope-tabs-grid-base-cell');
		}
		return () => {
			const nestedIndex = parentChildren.indexOf(nested);
			if (nestedIndex >= 0) Reflect.apply(replaceChild, parent, [nestedIndex, group]);
			if (typeof setGroupDimension === 'function') Reflect.apply(setGroupDimension, group, [groupDimension ?? null]);
		};
	} catch {
		try {
			const nestedIndex = parentChildren.indexOf(nested);
			if (nestedIndex >= 0) Reflect.apply(replaceChild, parent, [nestedIndex, group]);
			if (typeof setGroupDimension === 'function') Reflect.apply(setGroupDimension, group, [groupDimension ?? null]);
		} catch {
			// The public split fallback remains available when compatibility rollback is incomplete.
		}
		return null;
	}
}

function getMutableTabGroup(leaf: WorkspaceLeaf): MutableTabGroupCompatibility | null {
	return getMutableTabGroupFromParent(leaf.parent);
}

function isHtmlElement(value: unknown, doc: Document): value is HTMLElement {
	const HtmlElement = doc.defaultView?.HTMLElement;
	return !!HtmlElement && value instanceof HtmlElement;
}

/** Obsidian has no public tab-order API, so this adapter is optional and feature-detected. */
function getMutableTabGroupFromParent(candidate: unknown): MutableTabGroupCompatibility | null {
	if (!isUnknownRecord(candidate)) return null;
	const children = candidate.children;
	const removeChild = candidate.removeChild;
	const insertChild = candidate.insertChild;
	if (!isWorkspaceLeafArray(children) || typeof removeChild !== 'function' || typeof insertChild !== 'function') return null;
	return {
		children,
		removeChild: (child) => {
			Reflect.apply(removeChild, candidate, [child]);
		},
		insertChild: (index, child) => {
			Reflect.apply(insertChild, candidate, [index, child]);
		},
	};
}

/** Internal group IDs are persisted only when exposed; routing does not depend on them. */
function getGroupId(group: unknown): string | null {
	if (!isUnknownRecord(group)) return null;
	return typeof group.id === 'string' && group.id.length > 0 ? group.id : null;
}

function getLocation(leaf: WorkspaceLeaf): ManagedGroupLocation {
	const root = leaf.getRoot();
	return root instanceof WorkspaceWindow || leaf.view.containerEl.ownerDocument !== document ? 'popout' : 'main';
}

function getPopoutRoot(leaf: WorkspaceLeaf): WorkspaceWindow | null {
	return getLocation(leaf) === 'popout' ? leaf.getRoot() as WorkspaceWindow : null;
}

function isEmptyLeaf(leaf: WorkspaceLeaf): boolean {
	return leaf.getViewState().type === 'empty';
}

function cloneViewState(state: ViewState): ViewState {
	try {
		return structuredClone(state);
	} catch {
		return {
			...state,
			state: state.state ? { ...state.state } : undefined,
		};
	}
}

function compareBookEntryFiles(left: TFile, right: TFile): number {
	const extensionOrder = Number(left.extension !== 'md') - Number(right.extension !== 'md');
	if (extensionOrder !== 0) return extensionOrder;
	const depthOrder = left.path.split('/').length - right.path.split('/').length;
	return depthOrder !== 0 ? depthOrder : left.path.localeCompare(right.path);
}

function collectBookFiles(root: TFolder): TFile[] {
	const files: TFile[] = [];
	const pending = [...root.children];
	while (pending.length > 0) {
		const entry = pending.pop();
		if (entry instanceof TFile) files.push(entry);
		else if (entry instanceof TFolder) pending.push(...entry.children);
	}
	return files;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isWorkspaceLeafArray(value: unknown): value is WorkspaceLeaf[] {
	return Array.isArray(value) && value.every((item: unknown) => item instanceof WorkspaceLeaf);
}
