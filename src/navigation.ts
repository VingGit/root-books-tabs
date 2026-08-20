import {
	Notice,
	TFile,
	WorkspaceLeaf,
	WorkspaceWindow,
	type OpenViewState,
	type ViewState,
	type Workspace,
	type WorkspaceSplit,
} from 'obsidian';
import { getLeafFile } from './leaf-file';
import type ScopeTabsPlugin from './main';
import type { BookScope, CardinalDirection, ManagedGroupLocation, PersistedGroupRecord } from './types';

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

const SPIRAL_OVERFLOW_DIRECTIONS: CardinalDirection[] = ['right', 'down', 'left', 'up'];

interface GridCoordinate {
	row: number;
	column: number;
}

interface GridCreationStep {
	referenceIndex: number;
	direction: CardinalDirection;
}

export class BookNavigationController {
	private originalOpenFile: WorkspaceLeaf['openFile'] | null = null;
	private patchedOpenFile: WorkspaceLeaf['openFile'] | null = null;
	private readonly groupRecords = new WeakMap<LeafParent, PersistedGroupRecord>();
	private readonly canonicalGroups = new Map<string, LeafParent>();
	private readonly popoutSnapshots = new WeakMap<WorkspaceWindow, GroupSnapshot>();
	private readonly suppressedWindowReturns = new WeakSet<WorkspaceWindow>();
	private routing = false;

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
	}

	uninstall(): void {
		if (this.originalOpenFile && this.patchedOpenFile && WorkspaceLeaf.prototype.openFile === this.patchedOpenFile) {
			WorkspaceLeaf.prototype.openFile = this.originalOpenFile;
		}
		this.originalOpenFile = null;
		this.patchedOpenFile = null;
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
			const representative = this.plugin.app.workspace.getMostRecentLeaf(group) ?? leaves[0];
			if (!representative || this.getBookForGroup(representative)?.id !== book.id) continue;
			instances.push(representative);
		}
		return instances;
	}

	getGroupLocation(leaf: WorkspaceLeaf): ManagedGroupLocation {
		return getLocation(leaf);
	}

	getCanonicalBookLeaf(book: BookScope): WorkspaceLeaf | null {
		const group = this.canonicalGroups.get(book.id);
		if (!group) return null;
		const leaves = this.getLeavesForGroup(group);
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

	setPrimaryBook(bookId: string): void {
		const books = new Set(this.plugin.scopeResolver.listBooks().map((book) => book.id));
		if (!books.has(bookId)) return;
		const current = this.syncBookOrder();
		this.persistBookOrder([bookId, ...current.filter((id) => id !== bookId)]);
	}

	getLatestOpenBookId(excludeBookId: string): string | null {
		const openBookIds = this.getOpenBookIds();
		const ordered = this.syncBookOrder();
		for (const id of [...ordered].reverse()) {
			if (id !== excludeBookId && openBookIds.has(id)) return id;
		}
		return null;
	}

	async activateBook(book: BookScope): Promise<boolean> {
		const existing = this.getCanonicalBookLeaf(book);
		if (existing) {
			this.focusLeaf(existing);
			return true;
		}
		const entryFile = this.resolveBookEntryFile(book);
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

	async openAdditionalBook(book: BookScope, popout: boolean): Promise<boolean> {
		const existing = this.getCanonicalBookLeaf(book);
		if (existing) {
			this.focusLeaf(existing);
			return true;
		}
		const entryFile = this.resolveBookEntryFile(book);
		if (!entryFile || !this.originalOpenFile) return false;
		const source = this.plugin.app.workspace.getMostRecentLeaf() ?? this.findMainWorkspaceLeaf();
		if (!source) return false;
		return this.openNewBookGroup(source, book, entryFile, undefined, this.originalOpenFile, popout ? 'popout' : 'main');
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
		for (const leaf of instances) this.closeBookGroup(leaf);
	}

	closeBookGroup(leaf: WorkspaceLeaf): void {
		const popout = getPopoutRoot(leaf);
		if (popout) this.suppressedWindowReturns.add(popout);
		const group = leaf.parent;
		const leaves = this.getGroupLeaves(leaf);
		this.forgetGroup(group);
		for (const child of leaves) child.detach();
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
		for (const [group, leaves] of groups) {
			const existingRecord = this.groupRecords.get(group);
			if (existingRecord?.kind === 'managed' && existingRecord.bookId && !this.groupContainsBook(leaves, existingRecord.bookId)) {
				this.forgetGroup(group);
			} else if (existingRecord) {
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
			if (persisted?.kind === 'free') {
				this.groupRecords.set(group, persisted);
				continue;
			}
			if (persisted?.kind === 'managed' && persisted.bookId && this.groupContainsBook(leaves, persisted.bookId) && !this.canonicalGroups.has(persisted.bookId)) {
				this.groupRecords.set(group, persisted);
				this.canonicalGroups.set(persisted.bookId, group);
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
		const entries: Array<{ leaf: WorkspaceLeaf; book: BookScope; state: ViewState }> = [];
		this.plugin.app.workspace.iterateAllLeaves((leaf) => {
			const book = this.plugin.scopeResolver.resolveFile(getLeafFile(leaf, this.plugin.app.vault));
			if (book) entries.push({ leaf, book, state: cloneViewState(leaf.getViewState()) });
		});
		if (entries.length === 0) return 0;

		const activeBefore = this.plugin.app.workspace.getMostRecentLeaf();
		const groups = this.collectGroups();
		const groupBookIds = new Map<LeafParent, Set<string>>();
		for (const [group, leaves] of groups) {
			groupBookIds.set(group, new Set(leaves
				.map((leaf) => this.plugin.scopeResolver.resolveFile(getLeafFile(leaf, this.plugin.app.vault))?.id)
				.filter((id): id is string => id !== undefined)));
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
				let destination = canonical && !usedGroups.has(canonical.parent) ? canonical : null;
				if (!destination) {
					destination = findGroupRepresentative(groups, usedGroups, (group) => {
						const ids = groupBookIds.get(group);
						return ids?.size === 1 && ids.has(bookId);
					});
				}
				if (!destination) {
					destination = findGroupRepresentative(groups, usedGroups, (group) => groupBookIds.get(group)?.has(bookId) === true);
				}
				if (!destination) {
					destination = getLocation(source) === 'popout'
						? this.plugin.app.workspace.openPopoutLeaf()
						: this.createMainBookLeaf(source);
					createdEmptyLeaves.push(destination);
					groups.set(destination.parent, [destination]);
				}
				usedGroups.add(destination.parent);
				this.registerManagedGroup(destination, book);
				destinations.set(bookId, destination);
			}

			const movingEntries = entries.filter((entry) => destinations.get(entry.book.id)?.parent !== entry.leaf.parent);
			if (movingEntries.length === 0) return 0;
			if (animate) await animate(movingEntries.map((entry) => entry.leaf));
			const suppressedPopouts = this.suppressPopoutReturnsForMoves(new Set(movingEntries.map((entry) => entry.leaf)));

			let moved = 0;
			let activeAfter = activeBefore;
			const sourceGroups = new Set(movingEntries.map((entry) => entry.leaf.parent));
			for (const entry of movingEntries) {
				const destination = destinations.get(entry.book.id);
				if (!destination) continue;
				try {
					let target: WorkspaceLeaf;
					if (isEmptyLeaf(destination)) {
						target = destination;
					} else {
						this.plugin.app.workspace.setActiveLeaf(destination, { focus: false });
						target = this.plugin.app.workspace.getLeaf('tab');
					}
					this.registerManagedGroup(target, entry.book);
					await target.setViewState(entry.state);
					if (entry.leaf === activeBefore) activeAfter = target;
					entry.leaf.detach();
					destinations.set(entry.book.id, target);
					moved++;
				} catch (error) {
					console.error(`Root Books Tabs could not sort a tab for ${entry.book.name}.`, error);
				}
			}

			for (const group of sourceGroups) {
				if (this.getLeavesForGroup(group).length === 0) this.forgetGroup(group);
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
			this.capturePopoutSnapshots();
			this.syncBookOrder();
			if (activeAfter) this.focusLeaf(activeAfter);
			return moved;
		} finally {
			this.routing = false;
		}
	}

	getGroupLeaves(leaf: WorkspaceLeaf): WorkspaceLeaf[] {
		return this.getLeavesForGroup(leaf.parent);
	}

	private async routeOpen(
		destinationLeaf: WorkspaceLeaf,
		file: TFile,
		openState: OpenViewState | undefined,
		original: WorkspaceLeaf['openFile'],
	): Promise<void> {
		const sourceLeaf = this.plugin.app.workspace.getMostRecentLeaf();
		if (!sourceLeaf || destinationLeaf !== sourceLeaf) {
			if (sourceLeaf && destinationLeaf.parent !== sourceLeaf.parent && !this.groupRecords.has(destinationLeaf.parent)) {
				this.registerFreeGroup(destinationLeaf);
			}
			return original.call(destinationLeaf, file, openState);
		}

		const targetBook = this.plugin.scopeResolver.resolveFile(file);
		if (!targetBook) return original.call(destinationLeaf, file, openState);
		const sourceFile = getLeafFile(sourceLeaf, this.plugin.app.vault);
		const sourceBook = this.plugin.scopeResolver.resolveFile(sourceFile);
		if (!sourceBook) {
			const sourceRecord = this.groupRecords.get(sourceLeaf.parent);
			if (sourceRecord?.kind === 'free' || (getLocation(sourceLeaf) === 'popout' && !sourceRecord)) {
				if (!sourceRecord) this.registerFreeGroup(sourceLeaf);
				return original.call(destinationLeaf, file, openState);
			}
			const canonical = this.getCanonicalBookLeaf(targetBook);
			if (canonical && canonical.parent !== sourceLeaf.parent) {
				return this.openOrReuseInGroup(canonical, file, openState, original, true);
			}
			this.registerManagedGroup(destinationLeaf, targetBook);
			this.routing = true;
			try {
				await original.call(destinationLeaf, file, openState);
				this.focusLeaf(destinationLeaf);
			} finally {
				this.routing = false;
			}
			return;
		}

		const sourceRecord = this.ensureSourceGroup(sourceLeaf, sourceBook);
		if (sourceRecord.kind === 'free') {
			return this.openOrReuseInGroup(sourceLeaf, file, openState, original, this.plugin.settings.focusNewTabs);
		}
		if (sourceBook.id === targetBook.id) {
			return this.openOrReuseInGroup(sourceLeaf, file, openState, original, this.plugin.settings.focusNewTabs);
		}

		const existing = this.getCanonicalBookLeaf(targetBook);
		if (existing) {
			return this.openOrReuseInGroup(existing, file, openState, original, true);
		}
		await this.openNewBookGroup(sourceLeaf, targetBook, file, openState, original);
	}

	private async openOrReuseInGroup(
		referenceLeaf: WorkspaceLeaf,
		file: TFile,
		openState: OpenViewState | undefined,
		original: WorkspaceLeaf['openFile'],
		focusNewLeaf: boolean,
	): Promise<void> {
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
		this.routing = true;
		try {
			this.plugin.app.workspace.setActiveLeaf(referenceLeaf, { focus: false });
			const newLeaf = this.plugin.app.workspace.getLeaf('tab');
			this.copyGroupRegistration(referenceLeaf, newLeaf);
			await original.call(newLeaf, file, openState);
			this.applyTabInsertDirection(referenceLeaf, newLeaf);
			if (focusNewLeaf) this.focusLeaf(newLeaf);
			else if (previous) this.plugin.app.workspace.setActiveLeaf(previous, { focus: true });
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
				|| (forcedLocation === undefined && this.plugin.settings.openBooksInExternalWindows);
			const leaf = usePopout
				? this.plugin.app.workspace.openPopoutLeaf()
				: this.createMainBookLeaf(sourceLeaf);
			createdLeaf = leaf;
			this.registerManagedGroup(leaf, targetBook);
			await original.call(leaf, file, openState);
			this.syncBookOrder();
			this.focusLeaf(leaf);
			return true;
		} catch (error) {
			console.error('Root Books Tabs could not create a book group.', error);
			if (createdLeaf) {
				this.forgetGroup(createdLeaf.parent);
				createdLeaf.detach();
			}
			new Notice('Root Books Tabs could not create the requested book window. The current book was left unchanged.');
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
					? this.plugin.app.workspace.openPopoutLeaf()
					: this.createMainBookLeaf(this.findMainWorkspaceLeaf() ?? sourceLeaf);
			created.push(first);
			if (sourceManaged) this.registerManagedGroup(first, book);
			else this.registerFreeGroup(first);
			await this.restoreViewStates(first, states, created, book, sourceManaged);
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
			reference = next;
		}
	}

	private createMainBookLeaf(reference: WorkspaceLeaf): WorkspaceLeaf {
		const mainReference = this.findMainPlacementReference(reference);
		if (!mainReference) throw new Error('No main-workspace leaf is available.');
		if (this.plugin.settings.bookSplitDirection === 'grid') {
			return this.createGridBookLeaf(mainReference);
		}
		if (this.plugin.settings.bookSplitDirection === 'spiral') {
			return this.createSpiralBookLeaf(mainReference);
		}
		const cardinalDirection = this.plugin.settings.bookSplitDirection;
		const direction = this.resolveSplitDirection(cardinalDirection);
		return this.plugin.app.workspace.createLeafBySplit(mainReference, direction.axis, direction.before);
	}

	private createBookLeafAt(reference: WorkspaceLeaf, direction: CardinalDirection, forceNested = false): WorkspaceLeaf {
		const split = this.resolveSplitDirection(direction);
		if (forceNested) {
			const nested = createNestedSplitLeaf(this.plugin.app.workspace, reference, split.axis, split.before);
			if (nested) return nested;
		}
		return this.plugin.app.workspace.createLeafBySplit(reference, split.axis, split.before);
	}

	private createGridBookLeaf(fallback: WorkspaceLeaf): WorkspaceLeaf {
		const orderedMainLeaves = this.getOrderedMainBookLeaves();
		const capacity = this.plugin.settings.gridRows * this.plugin.settings.gridColumns;
		if (orderedMainLeaves.length < capacity) {
			return this.createClockwiseGridBaseLeaf(
				orderedMainLeaves,
				fallback,
				getClockwiseGridCreationSteps(this.plugin.settings.gridRows, this.plugin.settings.gridColumns),
				capacity,
			);
		}
		const baseLeaves = this.syncGridBaseLeaves(orderedMainLeaves, capacity);
		const overflowStep = orderedMainLeaves.length - capacity;
		const reference = baseLeaves[overflowStep % baseLeaves.length] ?? orderedMainLeaves[0] ?? fallback;
		return this.createBookLeafAt(reference, this.plugin.settings.gridOverflowDirection, true);
	}

	private createSpiralBookLeaf(fallback: WorkspaceLeaf): WorkspaceLeaf {
		const orderedMainLeaves = this.getOrderedMainBookLeaves();
		const capacity = 4;
		if (orderedMainLeaves.length < capacity) {
			return this.createClockwiseGridBaseLeaf(orderedMainLeaves, fallback, getClockwiseGridCreationSteps(2, 2), capacity);
		}
		const baseLeaves = this.syncGridBaseLeaves(orderedMainLeaves, capacity);
		const overflowStep = orderedMainLeaves.length - capacity;
		const baseIndex = overflowStep % capacity;
		const reference = baseLeaves[baseIndex] ?? orderedMainLeaves[0] ?? fallback;
		const direction = SPIRAL_OVERFLOW_DIRECTIONS[baseIndex] ?? 'right';
		return this.createBookLeafAt(reference, direction, true);
	}

	private createClockwiseGridBaseLeaf(
		orderedMainLeaves: WorkspaceLeaf[],
		fallback: WorkspaceLeaf,
		steps: GridCreationStep[],
		capacity: number,
	): WorkspaceLeaf {
		const baseLeaves = this.syncGridBaseLeaves(orderedMainLeaves, capacity);
		const step = steps[orderedMainLeaves.length - 1];
		if (!step) return this.createBookLeafAt(orderedMainLeaves.at(-1) ?? fallback, 'right');
		const reference = baseLeaves[step.referenceIndex] ?? orderedMainLeaves.at(-1) ?? fallback;
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
			this.syncBookOrder();
			this.focusLeaf(leaf);
		} finally {
			this.routing = false;
		}
	}

	private resolveBookEntryFile(book: BookScope): TFile | null {
		const configured = this.plugin.app.vault.getFileByPath(`${book.folderPath}/${this.plugin.settings.configFileBaseName}.md`);
		if (configured) return configured;
		return this.plugin.app.vault.getFiles()
			.filter((file) => this.plugin.scopeResolver.resolveFile(file)?.id === book.id)
			.sort(compareBookEntryFiles)[0] ?? null;
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
		if (existing?.kind === 'managed' && existing.bookId && existing.bookId !== book.id && this.canonicalGroups.get(existing.bookId) === leaf.parent) {
			this.canonicalGroups.delete(existing.bookId);
		}
		const record: PersistedGroupRecord = { kind: 'managed', bookId: book.id, location: getLocation(leaf) };
		this.groupRecords.set(leaf.parent, record);
		this.canonicalGroups.set(book.id, leaf.parent);
		this.persistGroup(leaf.parent, record);
		return record;
	}

	private registerFreeGroup(leaf: WorkspaceLeaf): PersistedGroupRecord {
		const existing = this.groupRecords.get(leaf.parent);
		if (existing?.kind === 'managed' && existing.bookId && this.canonicalGroups.get(existing.bookId) === leaf.parent) {
			this.canonicalGroups.delete(existing.bookId);
		}
		const record: PersistedGroupRecord = { kind: 'free', location: getLocation(leaf) };
		this.groupRecords.set(leaf.parent, record);
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
		this.groupRecords.delete(group);
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
			new Notice('Root Books Tabs could not return the closed pop-out book to the main workspace.');
		} finally {
			this.routing = false;
		}
	}

	private focusLeaf(leaf: WorkspaceLeaf): void {
		this.plugin.app.workspace.setActiveLeaf(leaf, { focus: true });
		const root = getPopoutRoot(leaf);
		if (root) {
			try {
				root.win.focus();
			} catch {
				// A pop-out can finish closing between route resolution and focus.
			}
		}
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

	private applyTabInsertDirection(reference: WorkspaceLeaf, created: WorkspaceLeaf): void {
		if (this.plugin.settings.tabInsertDirection !== 'left') return;
		const parent = getMutableTabGroup(created);
		if (!parent || reference.parent !== created.parent) return;
		const referenceIndex = parent.children.indexOf(reference);
		const createdIndex = parent.children.indexOf(created);
		if (referenceIndex < 0 || createdIndex < 0 || createdIndex === referenceIndex - 1) return;
		try {
			parent.removeChild(created);
			parent.insertChild(referenceIndex, created);
		} catch {
			// Tab ordering is a compatibility enhancement; routing is already complete.
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

function getClockwiseGridCreationSteps(rows: number, columns: number): GridCreationStep[] {
	const coordinates = getClockwiseGridCoordinates(rows, columns);
	return coordinates.slice(1).map((coordinate, coordinateOffset) => {
		const coordinateIndex = coordinateOffset + 1;
		if (coordinate.row === 0) {
			const referenceIndex = findCoordinateIndex(coordinates, coordinateIndex, coordinate.row, coordinate.column - 1);
			return { referenceIndex: Math.max(0, referenceIndex), direction: 'right' };
		}

		let referenceIndex = -1;
		let nearestRow = -1;
		for (let index = 0; index < coordinateIndex; index++) {
			const candidate = coordinates[index];
			if (candidate?.column !== coordinate.column || candidate.row >= coordinate.row || candidate.row <= nearestRow) continue;
			nearestRow = candidate.row;
			referenceIndex = index;
		}
		if (referenceIndex >= 0) return { referenceIndex, direction: 'down' };

		let nearestBelow = Number.POSITIVE_INFINITY;
		for (let index = 0; index < coordinateIndex; index++) {
			const candidate = coordinates[index];
			if (candidate?.column !== coordinate.column || candidate.row <= coordinate.row || candidate.row >= nearestBelow) continue;
			nearestBelow = candidate.row;
			referenceIndex = index;
		}
		return { referenceIndex: Math.max(0, referenceIndex), direction: 'up' };
	});
}

function getClockwiseGridCoordinates(rows: number, columns: number): GridCoordinate[] {
	const result: GridCoordinate[] = [];
	let top = 0;
	let bottom = rows - 1;
	let left = 0;
	let right = columns - 1;
	while (top <= bottom && left <= right) {
		for (let column = left; column <= right; column++) result.push({ row: top, column });
		for (let row = top + 1; row <= bottom; row++) result.push({ row, column: right });
		if (top < bottom) {
			for (let column = right - 1; column >= left; column--) result.push({ row: bottom, column });
		}
		if (left < right) {
			for (let row = bottom - 1; row > top; row--) result.push({ row, column: left });
		}
		top++;
		bottom--;
		left++;
		right--;
	}
	return result;
}

function findCoordinateIndex(
	coordinates: GridCoordinate[],
	endIndex: number,
	row: number,
	column: number,
): number {
	for (let index = endIndex - 1; index >= 0; index--) {
		const candidate = coordinates[index];
		if (candidate?.row === row && candidate.column === column) return index;
	}
	return -1;
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
 * Grid and Spiral overflow must halve only a base cell, so this optional adapter wraps that
 * tab group in a fresh nested split first. The public split operation remains the fallback.
 */
function createNestedSplitLeaf(
	workspace: Workspace,
	reference: WorkspaceLeaf,
	direction: 'vertical' | 'horizontal',
	before: boolean,
): WorkspaceLeaf | null {
	const group: unknown = reference.parent;
	if (!isUnknownRecord(group)) return null;
	const parent = group.parent;
	if (!isUnknownRecord(parent) || !Array.isArray(parent.children)) return null;
	const index = parent.children.indexOf(group);
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
	let replaced = false;
	try {
		if (typeof setGroupDimension === 'function') Reflect.apply(setGroupDimension, group, [null]);
		Reflect.apply(replaceChild, parent, [index, nested]);
		replaced = true;
		if (typeof setNestedDimension === 'function') Reflect.apply(setNestedDimension, nested, [groupDimension ?? null]);
		Reflect.apply(nested.insertChild, nested, [0, group]);
		return workspace.createLeafInParent(nested as unknown as WorkspaceSplit, before ? 0 : 1);
	} catch {
		if (replaced) {
			try {
				const nestedIndex = parent.children.indexOf(nested);
				if (nestedIndex >= 0) Reflect.apply(replaceChild, parent, [nestedIndex, group]);
				if (typeof setGroupDimension === 'function') Reflect.apply(setGroupDimension, group, [groupDimension ?? null]);
			} catch {
				// The public split fallback below remains available when compatibility rollback is incomplete.
			}
		}
		return null;
	}
}

function getMutableTabGroup(leaf: WorkspaceLeaf): MutableTabGroupCompatibility | null {
	return getMutableTabGroupFromParent(leaf.parent);
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

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isWorkspaceLeafArray(value: unknown): value is WorkspaceLeaf[] {
	return Array.isArray(value) && value.every((item: unknown) => item instanceof WorkspaceLeaf);
}
