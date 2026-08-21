import { MarkdownView, Menu, Notice, WorkspaceLeaf, WorkspaceWindow, setIcon, setTooltip, type Vault } from 'obsidian';
import { getLeafFile } from './leaf-file';
import type ScopeTabsPlugin from './main';
import type { BookScope, CardinalDirection } from './types';

type BookDropDirection = CardinalDirection;

interface InternalTabGroupDom {
	identity: object;
	children: WorkspaceLeaf[];
	containerEl: HTMLElement;
}

interface ExplorerDecoration {
	observer: MutationObserver;
	actions: HTMLElement;
	bookActions: HTMLElement;
	files: HTMLElement;
	filesParent: HTMLElement;
	modelReady: boolean;
	toggle: HTMLElement;
	bar: HTMLElement;
	closeAll: HTMLElement;
	openAnother: HTMLElement;
}

interface ExplorerTreeItemAdapter {
	identity: object;
	el: HTMLElement;
	path: string;
	collapse: () => void;
	expand: () => void;
}

interface ExplorerTreeAdapter {
	rootItems: ExplorerTreeItemAdapter[];
	itemsByPath: Map<string, ExplorerTreeItemAdapter>;
	reorder: (paths: string[]) => void;
	restoreOrder: () => void;
	invalidate: () => void;
}

interface BookGroupDrag {
	leaf: WorkspaceLeaf;
	button: HTMLElement;
}

export class DecorationController {
	private customStyleSheets = new Map<Document, CSSStyleSheet>();
	private explorerDecorations = new Map<HTMLElement, ExplorerDecoration>();
	private explorerRefreshQueued = false;
	private explorerRefreshFrame: number | null = null;
	private tabDecorationRefreshFrame: number | null = null;
	private primaryPromotionTimer: number | null = null;
	private previousOpenBookIds = new Set<string>();
	private instancePickerMenu: Menu | null = null;
	private instancePickerBookId: string | null = null;
	private closeTargetEl: HTMLElement | null = null;
	private restoreClosePreviewWindow: (() => void) | null = null;
	private bookDragDocuments = new Map<Document, () => void>();
	private bookGroupDrag: BookGroupDrag | null = null;
	private bookDropTargetEl: HTMLElement | null = null;
	private bookButtonLongPressCancels = new Set<() => void>();
	private collapsedSecondaryBookIds = new Set<string>();
	private explorerBookDropTargetEl: HTMLElement | null = null;
	private sortingTabs = false;

	constructor(private readonly plugin: ScopeTabsPlugin) {}

	refresh(): void {
		if (!this.plugin.scopeResolver.hasMultipleBooks()) {
			this.cleanup();
			return;
		}
		this.refreshCustomCss();
		this.refreshLeavesAndTabs();
		this.refreshExplorer();
		this.refreshBookMenus();
		this.queueTabDecorationRefresh();
	}

	cleanup(): void {
		if (this.explorerRefreshFrame !== null) window.cancelAnimationFrame(this.explorerRefreshFrame);
		if (this.tabDecorationRefreshFrame !== null) window.cancelAnimationFrame(this.tabDecorationRefreshFrame);
		if (this.primaryPromotionTimer !== null) window.clearTimeout(this.primaryPromotionTimer);
		this.explorerRefreshFrame = null;
		this.tabDecorationRefreshFrame = null;
		this.primaryPromotionTimer = null;
		this.explorerRefreshQueued = false;
		this.previousOpenBookIds.clear();
		this.instancePickerMenu?.hide();
		this.instancePickerMenu = null;
		this.instancePickerBookId = null;
		this.clearCloseTarget();
		this.clearBookGroupDrag();
		this.clearBookButtonLongPresses();
		this.clearExplorerBookDrag();
		this.collapsedSecondaryBookIds.clear();
		for (const removeListeners of this.bookDragDocuments.values()) removeListeners();
		this.bookDragDocuments.clear();
		const docs = new Set<Document>([...this.getWorkspaceDocuments(), ...this.customStyleSheets.keys()]);
		for (const [root, decoration] of [...this.explorerDecorations]) this.disposeExplorerDecoration(root, decoration, true);
		for (const [doc, sheet] of this.customStyleSheets) {
			doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((candidate) => candidate !== sheet);
		}
		this.customStyleSheets.clear();
		for (const doc of docs) {
			doc.querySelectorAll('.scope-tabs-book-menu-tab, .scope-tabs-book-mode-toggle, .scope-tabs-book-switcher, .scope-tabs-book-subtree-controls, .scope-tabs-book-actions').forEach((el) => el.remove());
			doc.querySelectorAll<HTMLElement>('.scope-tabs-book-label, .scope-tabs-book-mode-hidden, .scope-tabs-book-mode-selected, .scope-tabs-book-mode-secondary, .scope-tabs-book-root-title-hidden').forEach((el) => {
				if (el.hasClass('scope-tabs-book-label')) el.remove();
				else {
					el.style.removeProperty('order');
					el.removeClasses(['scope-tabs-book-mode-hidden', 'scope-tabs-book-mode-selected', 'scope-tabs-book-mode-secondary', 'scope-tabs-book-root-title-hidden']);
				}
			});
			doc.querySelectorAll<HTMLElement>('.scope-tabs-color-tab').forEach((el) => {
				el.removeClass('scope-tabs-color-tab');
				el.removeAttribute('data-scope-tabs-tab-style');
				el.style.removeProperty('--scope-tabs-tab-text-color');
			});
			doc.querySelectorAll<HTMLElement>('.scope-tabs-book-mode').forEach((el) => el.removeClass('scope-tabs-book-mode'));
			doc.querySelectorAll<HTMLElement>('.scope-tabs-close-target').forEach((el) => el.removeClass('scope-tabs-close-target'));
			doc.querySelectorAll<HTMLElement>('.scope-tabs-book-drop-target').forEach((el) => this.clearBookDropClasses(el));
			doc.querySelectorAll<HTMLElement>('.scope-tabs-tab-sort-moving').forEach((el) => el.removeClass('scope-tabs-tab-sort-moving'));
			doc.querySelectorAll<HTMLElement>('.scope-tabs-book-root-list').forEach((el) => el.removeClass('scope-tabs-book-root-list'));
			doc.querySelectorAll<HTMLElement>('[data-scope-tabs-book]').forEach((el) => {
				el.removeAttribute('data-scope-tabs-book');
				el.style.removeProperty('--scope-tabs-book-color');
				el.style.removeProperty('--scope-tabs-tab-text-color');
			});
		}
	}

	toggleBookMode(): void {
		this.plugin.settings.bookModeEnabled = !this.plugin.settings.bookModeEnabled;
		void this.plugin.saveSettings();
		this.refreshExplorer();
	}

	private refreshLeavesAndTabs(): void {
		for (const doc of this.getWorkspaceDocuments()) {
			doc.querySelectorAll<HTMLElement>('.workspace-tab-header').forEach((header) => {
				header.removeClass('scope-tabs-color-tab');
				header.removeAttribute('data-scope-tabs-book');
				header.removeAttribute('data-scope-tabs-tab-style');
				header.style.removeProperty('--scope-tabs-book-color');
				header.style.removeProperty('--scope-tabs-tab-text-color');
			});
		}
		this.plugin.app.workspace.iterateAllLeaves((leaf) => {
			leaf.view.containerEl.removeAttribute('data-scope-tabs-book');
			leaf.view.containerEl.style.removeProperty('--scope-tabs-book-color');
			if (leaf.view instanceof MarkdownView) leaf.view.contentEl.querySelector(':scope > .scope-tabs-book-label')?.remove();
			const book = this.plugin.scopeResolver.resolveFile(getLeafFile(leaf, this.plugin.app.vault));
			if (!book) return;
			const color = this.plugin.colors.getColor(book);
			this.decorateLeaf(leaf, book, color);
			this.decorateTabHeader(leaf, book, color);
		});
	}

	/**
	 * A tab close can emit layout-change before Obsidian has reconciled the tab-header DOM with
	 * the group's child array. Repeating just the DOM-sensitive passes on the next frame keeps the
	 * surviving leftmost tab decorated without creating a refresh loop.
	 */
	private queueTabDecorationRefresh(): void {
		if (this.tabDecorationRefreshFrame !== null) window.cancelAnimationFrame(this.tabDecorationRefreshFrame);
		this.tabDecorationRefreshFrame = window.requestAnimationFrame(() => {
			this.tabDecorationRefreshFrame = null;
			this.refreshLeavesAndTabs();
			this.refreshBookMenus();
		});
	}

	private decorateLeaf(leaf: WorkspaceLeaf, book: BookScope, color: string): void {
		leaf.view.containerEl.setAttr('data-scope-tabs-book', book.id);
		leaf.view.containerEl.style.setProperty('--scope-tabs-book-color', color);
		if (!(leaf.view instanceof MarkdownView)) return;
		const content = leaf.view.contentEl;
		content.querySelector(':scope > .scope-tabs-book-label')?.remove();
		if (!this.plugin.settings.showBookLabel) return;
		const label = content.createDiv({ cls: 'scope-tabs-book-label', text: book.name, prepend: true });
		label.style.setProperty('--scope-tabs-book-color', color);
	}

	private decorateTabHeader(leaf: WorkspaceLeaf, book: BookScope, color: string): void {
		const header = getTabHeaderForLeaf(leaf);
		if (!header) return;
		header.setAttr('data-scope-tabs-book', book.id);
		header.style.setProperty('--scope-tabs-book-color', color);
		header.style.setProperty('--scope-tabs-tab-text-color', this.plugin.colors.getTabTextColor(book));
		header.toggleClass('scope-tabs-color-tab', this.plugin.settings.colorTabs);
		header.setAttr('data-scope-tabs-tab-style', this.plugin.settings.tabDecorationStyle);
	}

	private refreshBookMenus(): void {
		this.syncBookDragDocuments();
		this.clearBookButtonLongPresses();
		for (const doc of this.getWorkspaceDocuments()) doc.querySelectorAll('.scope-tabs-book-menu-tab').forEach((el) => el.remove());
		const seenHosts = new Set<HTMLElement>();
		this.plugin.app.workspace.iterateAllLeaves((leaf) => {
			const group = getInternalTabGroupDom(leaf);
			const host = getTabHeaderHost(leaf, group);
			if (!host || seenHosts.has(host)) return;
			seenHosts.add(host);
			// Pop-out transitions can expose several transient group identities for one live tab host.
			// The DOM host is the invariant: keep exactly one pseudo-tab control attached to it.
			host.querySelectorAll(':scope > .scope-tabs-book-menu-tab').forEach((el) => el.remove());
			const book = this.plugin.navigation.getBookForGroup(leaf);
			if (!book) return;
			const button = host.createEl('button', {
				cls: 'scope-tabs-book-menu-tab clickable-icon',
				attr: {
					'aria-label': `Book menu and group drag handle for ${book.name}. Long press to sort all tabs by book.`,
					title: `Book menu for ${book.name}. Drag to move the whole book group; long press to sort all tabs by book.`,
					type: 'button',
					draggable: 'true',
				},
			});
			host.prepend(button);
			setIcon(button, 'book-open');
			button.style.setProperty('--scope-tabs-book-color', this.plugin.colors.getColor(book));
			let longPressed = false;
			let longPressTimer: number | null = null;
			const ownerWindow = button.ownerDocument.defaultView;
			const cancelLongPress = () => {
				if (longPressTimer !== null && ownerWindow) ownerWindow.clearTimeout(longPressTimer);
				longPressTimer = null;
			};
			this.bookButtonLongPressCancels.add(cancelLongPress);
			button.addEventListener('pointerdown', (event: PointerEvent) => {
				if (event.button !== 0 || !ownerWindow) return;
				cancelLongPress();
				longPressTimer = ownerWindow.setTimeout(() => {
					longPressTimer = null;
					longPressed = true;
					void this.sortTabsIntoBooks();
				}, 650);
			});
			button.addEventListener('pointerup', cancelLongPress);
			button.addEventListener('pointercancel', cancelLongPress);
			button.addEventListener('pointerleave', cancelLongPress);
			button.addEventListener('click', (event: MouseEvent) => {
				event.stopPropagation();
				if (longPressed) {
					longPressed = false;
					event.preventDefault();
					return;
				}
				this.showBookGroupMenu(event, leaf, book);
			});
			button.addEventListener('dragstart', (event: DragEvent) => {
				cancelLongPress();
				this.startBookGroupDrag(event, leaf, button);
			});
			button.addEventListener('dragend', (event: DragEvent) => this.finishBookGroupDrag(event, leaf));
		});
	}

	private syncBookDragDocuments(): void {
		const current = this.getWorkspaceDocuments();
		for (const [doc, removeListeners] of this.bookDragDocuments) {
			if (current.has(doc)) continue;
			removeListeners();
			this.bookDragDocuments.delete(doc);
		}
		for (const doc of current) {
			if (this.bookDragDocuments.has(doc)) continue;
			const dragOver = (event: DragEvent) => this.handleBookGroupDragOver(event);
			const drop = (event: DragEvent) => this.handleBookGroupDrop(event);
			const dragLeave = (event: DragEvent) => {
				if (event.relatedTarget === null) this.clearBookDropTarget();
			};
			doc.addEventListener('dragover', dragOver, true);
			doc.addEventListener('drop', drop, true);
			doc.addEventListener('dragleave', dragLeave, true);
			this.bookDragDocuments.set(doc, () => {
				doc.removeEventListener('dragover', dragOver, true);
				doc.removeEventListener('drop', drop, true);
				doc.removeEventListener('dragleave', dragLeave, true);
			});
		}
	}

	private startBookGroupDrag(event: DragEvent, leaf: WorkspaceLeaf, button: HTMLElement): void {
		event.stopPropagation();
		this.clearBookGroupDrag();
		this.bookGroupDrag = { leaf, button };
		button.addClass('scope-tabs-book-group-dragging');
		if (event.dataTransfer) {
			event.dataTransfer.effectAllowed = 'move';
			event.dataTransfer.setData('application/x-scope-tabs-book-group', this.plugin.navigation.getBookForGroup(leaf)?.id ?? 'book');
		}
	}

	private finishBookGroupDrag(event: DragEvent, leaf: WorkspaceLeaf): void {
		if (this.bookGroupDrag?.leaf !== leaf) return;
		const shouldPopOut = this.plugin.navigation.getGroupLocation(leaf) === 'main' && this.isOutsideWorkspaceWindows(event);
		this.clearBookGroupDrag();
		if (shouldPopOut) void this.plugin.navigation.moveBookGroupToPopout(leaf);
	}

	private handleBookGroupDragOver(event: DragEvent): void {
		const drag = this.bookGroupDrag;
		if (!drag) return;
		const target = getEventElement(event);
		const groupEl = target?.closest<HTMLElement>('.workspace-tabs');
		const targetLeaf = groupEl ? this.findLeafForGroupElement(groupEl) : null;
		if (!groupEl || !targetLeaf || targetLeaf.parent === drag.leaf.parent) {
			this.clearBookDropTarget();
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
		this.setBookDropTarget(groupEl, getBookDropDirection(event, groupEl));
	}

	private handleBookGroupDrop(event: DragEvent): void {
		const drag = this.bookGroupDrag;
		if (!drag) return;
		const target = getEventElement(event);
		const groupEl = target?.closest<HTMLElement>('.workspace-tabs');
		const targetLeaf = groupEl ? this.findLeafForGroupElement(groupEl) : null;
		if (!groupEl || !targetLeaf || targetLeaf.parent === drag.leaf.parent) return;
		event.preventDefault();
		event.stopPropagation();
		const direction = getBookDropDirection(event, groupEl);
		const sourceLeaf = drag.leaf;
		this.clearBookGroupDrag();
		void this.plugin.navigation.moveBookGroupByDrag(sourceLeaf, targetLeaf, direction);
	}

	private findLeafForGroupElement(groupEl: HTMLElement): WorkspaceLeaf | null {
		let result: WorkspaceLeaf | null = null;
		this.plugin.app.workspace.iterateAllLeaves((leaf) => {
			if (result) return;
			const internal = getInternalTabGroupDom(leaf);
			const candidate = internal?.containerEl ?? leaf.view.containerEl.closest<HTMLElement>('.workspace-tabs');
			if (candidate === groupEl) result = leaf;
		});
		return result;
	}

	private setBookDropTarget(target: HTMLElement, direction: BookDropDirection): void {
		if (this.bookDropTargetEl !== target) this.clearBookDropTarget();
		this.bookDropTargetEl = target;
		this.clearBookDropClasses(target);
		target.addClasses(['scope-tabs-book-drop-target', `scope-tabs-book-drop-${direction}`]);
	}

	private clearBookDropTarget(): void {
		if (this.bookDropTargetEl) this.clearBookDropClasses(this.bookDropTargetEl);
		this.bookDropTargetEl = null;
	}

	private clearBookDropClasses(target: HTMLElement): void {
		target.removeClasses([
			'scope-tabs-book-drop-target',
			'scope-tabs-book-drop-left',
			'scope-tabs-book-drop-right',
			'scope-tabs-book-drop-up',
			'scope-tabs-book-drop-down',
		]);
	}

	private clearBookGroupDrag(): void {
		this.bookGroupDrag?.button.removeClass('scope-tabs-book-group-dragging');
		this.bookGroupDrag = null;
		this.clearBookDropTarget();
	}

	private isOutsideWorkspaceWindows(event: DragEvent): boolean {
		if (event.screenX === 0 && event.screenY === 0) return false;
		for (const doc of this.getWorkspaceDocuments()) {
			const view = doc.defaultView;
			if (!view) continue;
			const insideX = event.screenX >= view.screenX && event.screenX <= view.screenX + view.outerWidth;
			const insideY = event.screenY >= view.screenY && event.screenY <= view.screenY + view.outerHeight;
			if (insideX && insideY) return false;
		}
		return true;
	}

	private showBookGroupMenu(event: MouseEvent, leaf: WorkspaceLeaf, book: BookScope): void {
		const menu = new Menu();
		menu.addItem((item) => item.setTitle(book.name).setIcon('book-open').setDisabled(true));
		menu.addSeparator();
		if (this.plugin.navigation.getGroupLocation(leaf) === 'popout') {
			const alwaysOnTop = getAlwaysOnTopCompatibility(leaf);
			if (alwaysOnTop) {
				const pinned = alwaysOnTop.isPinned();
				menu.addItem((item) => item
					.setTitle(pinned ? 'Unpin pop-out book' : 'Pin pop-out book')
					.setIcon('pin')
					.setChecked(pinned)
					.onClick(() => {
						alwaysOnTop.setPinned(!alwaysOnTop.isPinned());
						this.refreshBookMenus();
					}));
			}
			menu.addItem((item) => item.setTitle('Return book to Obsidian').setIcon('panel-top-open').onClick(() => void this.plugin.navigation.moveBookGroupToMain(leaf)));
		} else {
			menu.addItem((item) => item.setTitle('Move to pop-out').setIcon('picture-in-picture-2').onClick(() => void this.plugin.navigation.moveBookGroupToPopout(leaf)));
		}
		menu.addSeparator();
		menu.addItem((item) => item
			.setTitle('Sort all tabs into books')
			.setIcon('list-tree')
			.onClick(() => void this.sortTabsIntoBooks()));
		menu.addSeparator();
		menu.addItem((item) => item.setTitle('Close book').setIcon('x').setWarning(true).onClick(() => this.plugin.navigation.closeBookGroup(leaf)));
		menu.showAtMouseEvent(event);
	}

	private clearBookButtonLongPresses(): void {
		for (const cancel of this.bookButtonLongPressCancels) cancel();
		this.bookButtonLongPressCancels.clear();
	}

	private async sortTabsIntoBooks(): Promise<void> {
		if (this.sortingTabs) return;
		this.sortingTabs = true;
		try {
			const moved = await this.plugin.navigation.sortAllTabsIntoBooks((leaves) => this.animateTabSort(leaves));
			new Notice(moved > 0
				? `Root Books Tabs sorted ${moved} tab${moved === 1 ? '' : 's'} into their books.`
				: 'All scoped tabs are already sorted into their books.');
		} catch (error) {
			console.error('Root Books Tabs could not sort tabs into books.', error);
			new Notice('Root books tabs could not finish sorting the tabs. Existing tabs were preserved where possible.');
		} finally {
			this.sortingTabs = false;
			this.refresh();
		}
	}

	private async animateTabSort(leaves: WorkspaceLeaf[]): Promise<void> {
		const headers = new Set<HTMLElement>();
		for (const leaf of leaves) {
			const header = getTabHeaderForLeaf(leaf);
			if (header && header.ownerDocument.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches !== true) headers.add(header);
		}
		if (headers.size === 0) return;
		for (const header of headers) header.addClass('scope-tabs-tab-sort-moving');
		await new Promise<void>((resolve) => window.setTimeout(resolve, 160));
		for (const header of headers) header.removeClass('scope-tabs-tab-sort-moving');
	}

	private refreshExplorer(): void {
		this.updatePrimaryBookAfterClosures();
		const explorerRoots = new Set<HTMLElement>();
		for (const doc of this.getWorkspaceDocuments()) {
			for (const root of Array.from(doc.querySelectorAll<HTMLElement>('.workspace-leaf-content[data-type="file-explorer"]'))) {
				explorerRoots.add(root);
				this.ensureExplorerDecoration(root);
				this.applyBookMode(root);
			}
		}
		for (const [root, decoration] of this.explorerDecorations) {
			if (root.isConnected && explorerRoots.has(root)) continue;
			this.disposeExplorerDecoration(root, decoration, true);
		}
	}

	private disposeExplorerDecoration(root: HTMLElement, decoration: ExplorerDecoration, restoreOrder: boolean): void {
		decoration.observer.disconnect();
		const tree = getExplorerTreeAdapter(this.plugin, root);
		const itemEls = new Set<HTMLElement>(tree?.rootItems.map((item) => item.el) ?? []);
		root.querySelectorAll<HTMLElement>('.scope-tabs-book-mode-hidden, .scope-tabs-book-mode-selected, .scope-tabs-book-mode-secondary').forEach((item) => itemEls.add(item));
		for (const item of itemEls) {
			item.style.removeProperty('order');
			item.removeClasses(['scope-tabs-book-mode-hidden', 'scope-tabs-book-mode-selected', 'scope-tabs-book-mode-secondary']);
			item.querySelector<HTMLElement>(':scope > .nav-folder-title')?.removeClass('scope-tabs-book-root-title-hidden');
			item.querySelector(':scope > .scope-tabs-book-subtree-controls')?.remove();
		}
		root.querySelectorAll('.scope-tabs-book-subtree-controls').forEach((controls) => controls.remove());
		if (restoreOrder) tree?.restoreOrder();
		tree?.invalidate();
		decoration.toggle.remove();
		decoration.bar.remove();
		decoration.bookActions.remove();
		root.removeClass('scope-tabs-book-mode');
		this.explorerDecorations.delete(root);
	}

	private ensureExplorerDecoration(root: HTMLElement): void {
		let decoration = this.explorerDecorations.get(root);
		const actions = root.querySelector<HTMLElement>('.nav-buttons-container');
		const files = root.querySelector<HTMLElement>('.nav-files-container');
		const filesParent = files?.parentElement;
		if (!actions || !files || !filesParent) return;
		if (decoration && (decoration.actions !== actions || decoration.files !== files || decoration.filesParent !== filesParent)) {
			this.disposeExplorerDecoration(root, decoration, true);
			decoration = undefined;
		}
		if (!decoration) {
			const toggle = actions.createEl('button', {
				cls: 'clickable-icon scope-tabs-book-mode-toggle',
				attr: { 'aria-label': 'Toggle root books tabs book mode', type: 'button' },
			});
			setIcon(toggle, 'book-open-check');
			toggle.addEventListener('click', () => this.toggleBookMode());
			const bar = root.createEl('button', {
				cls: 'scope-tabs-book-switcher',
				attr: { type: 'button', 'aria-haspopup': 'menu' },
			});
			filesParent.insertBefore(bar, files);
			bar.addEventListener('click', (event: MouseEvent) => this.showBookSwitcher(event));
			const bookActions = filesParent.createDiv({ cls: 'scope-tabs-book-actions' });
			filesParent.insertBefore(bookActions, files);
			const openAnother = bookActions.createEl('button', {
				cls: 'scope-tabs-open-book-button',
				attr: { type: 'button', 'aria-haspopup': 'menu', 'aria-label': 'Open another book' },
			});
			openAnother.createSpan({ cls: 'scope-tabs-open-book-default', text: '+ Open another book' });
			openAnother.createSpan({ cls: 'scope-tabs-open-book-hover', text: 'Shift-click opens another book in a pop-out window instead.' });
			openAnother.addEventListener('click', (event: MouseEvent) => {
				event.stopPropagation();
				this.showOpenAnotherMenu(event, event.shiftKey);
			});
			const closeAll = bookActions.createEl('button', {
				cls: 'scope-tabs-close-all-books-button',
				text: 'Close all',
				attr: { type: 'button', 'aria-label': 'Close every secondary book while keeping the selected book open' },
			});
			closeAll.addEventListener('click', (event: MouseEvent) => {
				event.stopPropagation();
				const primaryBookId = this.plugin.settings.selectedBookId;
				if (!primaryBookId) return;
				this.plugin.navigation.closeAllSecondaryBooks(primaryBookId);
				this.queueExplorerRefresh();
			});
			const observer = new MutationObserver(() => {
				const current = this.explorerDecorations.get(root);
				if (!current) return;
				const liveActions = root.querySelector<HTMLElement>('.nav-buttons-container');
				const liveFiles = root.querySelector<HTMLElement>('.nav-files-container');
				if (liveActions !== current.actions || liveFiles !== current.files || !current.modelReady) this.queueExplorerRefresh();
			});
			observer.observe(root, { childList: true });
			decoration = { observer, actions, bookActions, files, filesParent, modelReady: false, toggle, bar, closeAll, openAnother };
			this.explorerDecorations.set(root, decoration);
			window.setTimeout(() => {
				const current = this.explorerDecorations.get(root);
				if (current && !current.modelReady) this.queueExplorerRefresh();
			}, 100);
		}
		decoration.toggle.toggleClass('is-active', this.plugin.settings.bookModeEnabled);
		decoration.toggle.setAttr('aria-pressed', String(this.plugin.settings.bookModeEnabled));
	}

	private applyBookMode(root: HTMLElement): void {
		const books = this.plugin.scopeResolver.listBooks();
		const booksById = new Map(books.map((book) => [book.id, book]));
		const bookOrder = this.plugin.navigation.getBookOrder();
		const openBookIds = this.plugin.navigation.getOpenBookIds();
		const selected = books.find((book) => book.id === this.plugin.settings.selectedBookId) ?? books[0];
		if (!selected) return;
		if (this.plugin.settings.selectedBookId !== selected.id) {
			this.plugin.settings.selectedBookId = selected.id;
			void this.plugin.saveSettings();
		}
		const decoration = this.explorerDecorations.get(root);
		if (!decoration) return;
		const tree = getExplorerTreeAdapter(this.plugin, root);
		decoration.modelReady = tree !== null;
		decoration.bar.setText(selected.name);
		decoration.bar.setAttr('aria-label', `Selected book: ${selected.name}. Choose another book.`);
		decoration.bar.toggle(this.plugin.settings.bookModeEnabled);
		decoration.bar.toggleClass('scope-tabs-book-switcher-colored', this.plugin.settings.colorBookSwitcher);
		decoration.bar.style.setProperty('--scope-tabs-book-color', this.plugin.colors.getColor(selected));
		const visibleBookIds = new Set(openBookIds);
		visibleBookIds.add(selected.id);
		root.toggleClass('scope-tabs-book-mode', this.plugin.settings.bookModeEnabled);

		const rootItems = new Map<string, HTMLElement>();
		for (const item of tree?.rootItems ?? []) rootItems.set(item.path, item.el);
		for (const item of getExplorerRootItems(root)) rootItems.set(getExplorerItemPath(item), item);
		for (const el of new Set(rootItems.values())) {
			el.style.removeProperty('order');
			el.removeClasses(['scope-tabs-book-mode-hidden', 'scope-tabs-book-mode-selected', 'scope-tabs-book-mode-secondary', 'scope-tabs-book-root-title-hidden']);
			el.querySelector<HTMLElement>(':scope > .nav-folder-title')?.removeClass('scope-tabs-book-root-title-hidden');
		}
		if (this.plugin.settings.bookModeEnabled && !tree) {
			root.removeClass('scope-tabs-book-mode');
			decoration.bar.toggle(false);
			decoration.bookActions.toggle(false);
			root.querySelectorAll('.scope-tabs-book-subtree-controls').forEach((controls) => controls.remove());
			return;
		}
		if (!this.plugin.settings.bookModeEnabled) {
			for (const item of rootItems.values()) item.querySelector(':scope > .scope-tabs-book-subtree-controls')?.remove();
			tree?.restoreOrder();
			tree?.invalidate();
			decoration.bookActions.remove();
			decoration.filesParent.insertBefore(decoration.bookActions, decoration.files);
			decoration.bookActions.toggle(false);
			return;
		}
		const secondaryPaths = bookOrder.filter((id) => id !== selected.id && openBookIds.has(id));
		for (const book of books) {
			if (book.id !== selected.id && openBookIds.has(book.id) && !secondaryPaths.includes(book.id)) secondaryPaths.push(book.id);
		}
		tree?.reorder([selected.id, ...secondaryPaths]);
		let selectedItem: HTMLElement | null = null;
		for (const [path, item] of rootItems) {
			const subtreeControls = item.querySelector<HTMLElement>(':scope > .scope-tabs-book-subtree-controls');
			if (path === selected.folderPath && item.hasClass('nav-folder')) {
				selectedItem = item;
				subtreeControls?.remove();
				item.addClass('scope-tabs-book-mode-selected');
				item.querySelector<HTMLElement>(':scope > .nav-folder-title')?.addClass('scope-tabs-book-root-title-hidden');
				tree?.itemsByPath.get(path)?.expand();
			} else if (openBookIds.has(path) && item.hasClass('nav-folder')) {
				const book = booksById.get(path);
				if (!book) continue;
				item.addClass('scope-tabs-book-mode-secondary');
				item.querySelector<HTMLElement>(':scope > .nav-folder-title')?.addClass('scope-tabs-book-root-title-hidden');
				const treeItem = tree?.itemsByPath.get(path);
				if (this.collapsedSecondaryBookIds.has(book.id)) treeItem?.collapse();
				else treeItem?.expand();
				this.ensureSubtreeControls(item, book);
			} else {
				subtreeControls?.remove();
				item.addClass('scope-tabs-book-mode-hidden');
			}
		}
		const showOpenAnother = books.some((book) => !visibleBookIds.has(book.id));
		const showCloseAll = secondaryPaths.length > 0;
		if (selectedItem) {
			if (selectedItem.lastElementChild !== decoration.bookActions) selectedItem.appendChild(decoration.bookActions);
			decoration.openAnother.toggle(showOpenAnother);
			decoration.closeAll.toggle(showCloseAll);
			decoration.bookActions.toggle(showOpenAnother || showCloseAll);
		} else {
			decoration.bookActions.toggle(false);
		}
		tree?.invalidate();
	}

	private ensureSubtreeControls(folder: HTMLElement, book: BookScope): void {
		let controls = folder.querySelector<HTMLElement>(':scope > .scope-tabs-book-subtree-controls');
		if (!controls) {
			folder.querySelector(':scope > .scope-tabs-book-subtree-bar')?.remove();
			controls = folder.createDiv({ cls: 'scope-tabs-book-subtree-controls' });
			const controlsEl = controls;
			const handle = controlsEl.createEl('button', {
				cls: 'scope-tabs-book-subtree-handle',
				attr: { type: 'button' },
			});
			const reorder = controlsEl.createEl('button', {
				cls: 'scope-tabs-book-subtree-reorder',
				attr: { type: 'button' },
			});
			setIcon(reorder, 'grip-vertical');
			const bar = controlsEl.createEl('button', {
				cls: 'scope-tabs-book-subtree-bar',
				attr: { type: 'button' },
			});
			controlsEl.createSpan({ cls: 'scope-tabs-book-subtree-divider', attr: { 'aria-hidden': 'true' } });
			const copy = controlsEl.createEl('button', {
				cls: 'scope-tabs-book-subtree-copy',
				attr: { type: 'button' },
			});
			setIcon(copy, 'copy-plus');
			const children = folder.querySelector<HTMLElement>(':scope > .nav-folder-children');
			if (children) folder.insertBefore(controls, children);
			bar.addEventListener('click', (event: MouseEvent) => {
				event.stopPropagation();
				const id = controls?.dataset.bookId;
				const currentBook = this.plugin.scopeResolver.listBooks().find((candidate) => candidate.id === id);
				if (!currentBook) return;
				if (event.ctrlKey) {
					this.plugin.navigation.closeAllBookGroups(currentBook);
					return;
				}
				if (event.shiftKey) {
					this.showBookInstancePicker(event, currentBook);
					return;
				}
				this.plugin.navigation.closeLatestBookGroup(currentBook);
			});
			handle.addEventListener('click', (event: MouseEvent) => {
				event.preventDefault();
				event.stopPropagation();
				const id = controls?.dataset.bookId;
				if (id) this.toggleSecondaryBookSubtree(folder, id);
			});
			reorder.addEventListener('click', (event: MouseEvent) => {
				event.preventDefault();
				event.stopPropagation();
			});
			copy.addEventListener('click', (event: MouseEvent) => {
				event.preventDefault();
				event.stopPropagation();
				const id = controls?.dataset.bookId;
				const currentBook = this.plugin.scopeResolver.listBooks().find((candidate) => candidate.id === id);
				if (currentBook) void this.plugin.navigation.openBookCopy(currentBook);
			});
			let pointerDrag: { pointerId: number; startX: number; startY: number; dragging: boolean } | null = null;
			reorder.addEventListener('pointerdown', (event: PointerEvent) => {
				if (event.button !== 0 || !controlsEl.dataset.bookId) return;
				pointerDrag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, dragging: false };
				reorder.setPointerCapture(event.pointerId);
			});
			reorder.addEventListener('pointermove', (event: PointerEvent) => {
				const drag = pointerDrag;
				if (!drag || drag.pointerId !== event.pointerId) return;
				if (!drag.dragging && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return;
				if (!drag.dragging) {
					drag.dragging = true;
					controlsEl.addClass('scope-tabs-book-subtree-dragging');
				}
				event.preventDefault();
				const target = controlsEl.ownerDocument.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('.scope-tabs-book-subtree-controls');
				if (target && target !== controlsEl) this.setExplorerBookDropTarget(target, event.clientY);
				else this.clearExplorerBookDropTarget();
			});
			const finishPointerDrag = (event: PointerEvent, cancelled: boolean): void => {
				const drag = pointerDrag;
				if (!drag || drag.pointerId !== event.pointerId) return;
				let reordered = false;
				if (drag.dragging && !cancelled) {
					const target = controlsEl.ownerDocument.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('.scope-tabs-book-subtree-controls');
					const sourceId = controlsEl.dataset.bookId;
					const targetId = target?.dataset.bookId;
					if (target && target !== controlsEl && sourceId && targetId) {
						const rect = target.getBoundingClientRect();
						this.plugin.navigation.reorderSecondaryBook(sourceId, targetId, event.clientY < rect.top + rect.height / 2 ? 'before' : 'after');
						reordered = true;
					}
				}
				if (reorder.hasPointerCapture(event.pointerId)) reorder.releasePointerCapture(event.pointerId);
				pointerDrag = null;
				this.clearExplorerBookDrag();
				if (reordered) this.queueExplorerRefresh();
			};
			reorder.addEventListener('pointerup', (event: PointerEvent) => finishPointerDrag(event, false));
			reorder.addEventListener('pointercancel', (event: PointerEvent) => finishPointerDrag(event, true));
		}
		controls.dataset.bookId = book.id;
		const handle = controls.querySelector<HTMLButtonElement>(':scope > .scope-tabs-book-subtree-handle');
		const reorder = controls.querySelector<HTMLButtonElement>(':scope > .scope-tabs-book-subtree-reorder');
		const bar = controls.querySelector<HTMLButtonElement>(':scope > .scope-tabs-book-subtree-bar');
		const copy = controls.querySelector<HTMLButtonElement>(':scope > .scope-tabs-book-subtree-copy');
		if (!bar || !handle || !reorder || !copy) return;
		let title = bar.querySelector<HTMLElement>(':scope > .scope-tabs-book-subtree-title');
		let close = bar.querySelector<HTMLElement>(':scope > .scope-tabs-book-subtree-close');
		if (!title) title = bar.createSpan({ cls: 'scope-tabs-book-subtree-title' });
		if (!close) {
			close = bar.createSpan({ cls: 'scope-tabs-book-subtree-close' });
			close.createSpan({ cls: 'scope-tabs-book-subtree-close-label', text: 'Close latest book' });
		}
		close.querySelector(':scope > .scope-tabs-book-subtree-close-hint')?.remove();
		if (title.textContent !== book.name) title.setText(book.name);
		const collapsed = this.collapsedSecondaryBookIds.has(book.id);
		setIcon(handle, collapsed ? 'chevron-right' : 'chevron-down');
		setTooltip(bar, `Close the latest ${book.name} book. Shift-click to choose an instance or tab. Ctrl-click to close every instance and tab for this book.`, { delay: 0, placement: 'bottom' });
		setTooltip(handle, collapsed ? 'Expand subtree' : 'Collapse subtree', { delay: 0, placement: 'left' });
		handle.setAttr('aria-expanded', collapsed ? 'false' : 'true');
		setTooltip(reorder, 'Drag to reorder', { delay: 0, placement: 'left' });
		setTooltip(copy, `Open another ${book.name} instance`, { delay: 0, placement: 'right' });
		bar.toggleClass('scope-tabs-book-switcher-colored', this.plugin.settings.colorBookSwitcher);
		bar.style.setProperty('--scope-tabs-book-color', this.plugin.colors.getColor(book));
	}

	private showBookInstancePicker(event: MouseEvent, book: BookScope): boolean {
		const instances = this.plugin.navigation.getBookGroupInstances(book);
		if (instances.length === 0) return false;
		if (this.instancePickerBookId === book.id) return true;
		this.instancePickerMenu?.hide();
		const menu = new Menu();
		const previewBindings: Array<{ label: HTMLElement; leaf: WorkspaceLeaf; targetKind: 'group' | 'tab' }> = [];
		this.instancePickerMenu = menu;
		this.instancePickerBookId = book.id;
		menu.addItem((item) => item.setTitle(book.name).setIcon('book-open').setIsLabel(true));
		instances.forEach((leaf, index) => {
			const file = getLeafFile(leaf, this.plugin.app.vault);
			const location = this.plugin.navigation.getGroupLocation(leaf);
			const title = createFragment();
			const label = title.createSpan({
				cls: 'scope-tabs-book-instance-option scope-tabs-book-instance-heading',
				text: `${location === 'popout' ? 'Pop-out' : 'Main workspace'} ${index + 1}${file ? ` — ${file.basename}` : ''}`,
			});
			menu.addItem((item) => {
				item
					.setTitle(title)
					.setIcon(location === 'popout' ? 'picture-in-picture-2' : 'panels-top-left')
					.setWarning(true)
					.onClick(() => {
						this.clearCloseTarget();
						this.plugin.navigation.closeBookGroupInstance(book, leaf);
					});
				previewBindings.push({ label, leaf, targetKind: 'group' });
			});

			for (const child of this.plugin.navigation.getGroupLeaves(leaf)) {
				const childFile = getLeafFile(child, this.plugin.app.vault);
				if (!childFile || this.plugin.scopeResolver.resolveFile(childFile)?.id !== book.id) continue;
				const tabTitle = createFragment();
				const tabLabel = tabTitle.createSpan({
					cls: 'scope-tabs-book-instance-option scope-tabs-book-instance-tab',
					text: childFile.basename,
				});
				menu.addItem((item) => {
					item
						.setTitle(tabTitle)
						.setIcon('file')
						.setWarning(true)
						.onClick(() => {
							this.clearCloseTarget();
							this.plugin.navigation.closeBookTab(child);
						});
					previewBindings.push({ label: tabLabel, leaf: child, targetKind: 'tab' });
				});
			}
			if (index < instances.length - 1) menu.addSeparator();
		});
		menu.onHide(() => {
			if (this.instancePickerMenu === menu) {
				this.instancePickerMenu = null;
				this.instancePickerBookId = null;
			}
			this.clearCloseTarget();
		});
		menu.showAtMouseEvent(event);
		for (const binding of previewBindings) this.bindClosePreview(binding.label, binding.leaf, binding.targetKind);
		return true;
	}

	private bindClosePreview(label: HTMLElement, leaf: WorkspaceLeaf, targetKind: 'group' | 'tab'): void {
		const hoverTarget = label.closest<HTMLElement>('.menu-item') ?? label;
		hoverTarget.addEventListener('mouseenter', () => this.setCloseTarget(leaf, targetKind, hoverTarget.ownerDocument.defaultView));
	}

	private setCloseTarget(leaf: WorkspaceLeaf, targetKind: 'group' | 'tab', sourceWindow: Window | null): void {
		this.clearCloseTarget();
		const restoreWindow = bringPopoutForwardForClosePreview(leaf, sourceWindow);
		const group = getInternalTabGroupDom(leaf);
		const target = targetKind === 'tab'
			? getTabHeaderForFileLeaf(leaf, group, this.plugin.app.vault)
			: group?.containerEl ?? leaf.view.containerEl.closest<HTMLElement>('.workspace-tabs');
		if (!target) {
			restoreWindow?.();
			return;
		}
		this.restoreClosePreviewWindow = restoreWindow;
		target.addClass('scope-tabs-close-target');
		this.closeTargetEl = target;
	}

	private toggleSecondaryBookSubtree(folder: HTMLElement, bookId: string): void {
		const book = this.plugin.scopeResolver.listBooks().find((candidate) => candidate.id === bookId);
		if (!book) return;
		const collapse = !this.collapsedSecondaryBookIds.has(bookId);
		if (collapse) this.collapsedSecondaryBookIds.add(bookId);
		else this.collapsedSecondaryBookIds.delete(bookId);
		for (const root of this.explorerDecorations.keys()) {
			if (!root.contains(folder)) continue;
			const item = getExplorerTreeAdapter(this.plugin, root)?.itemsByPath.get(book.folderPath);
			if (collapse) item?.collapse();
			else item?.expand();
			break;
		}
		this.queueExplorerRefresh();
	}

	private setExplorerBookDropTarget(target: HTMLElement, clientY: number): void {
		if (this.explorerBookDropTargetEl && this.explorerBookDropTargetEl !== target) {
			this.explorerBookDropTargetEl.removeClasses(['scope-tabs-book-subtree-drop-before', 'scope-tabs-book-subtree-drop-after']);
		}
		const rect = target.getBoundingClientRect();
		target.toggleClass('scope-tabs-book-subtree-drop-before', clientY < rect.top + rect.height / 2);
		target.toggleClass('scope-tabs-book-subtree-drop-after', clientY >= rect.top + rect.height / 2);
		this.explorerBookDropTargetEl = target;
	}

	private clearExplorerBookDropTarget(): void {
		this.explorerBookDropTargetEl?.removeClasses(['scope-tabs-book-subtree-drop-before', 'scope-tabs-book-subtree-drop-after']);
		this.explorerBookDropTargetEl = null;
	}

	private clearExplorerBookDrag(): void {
		this.clearExplorerBookDropTarget();
		for (const doc of this.getWorkspaceDocuments()) doc.querySelectorAll<HTMLElement>('.scope-tabs-book-subtree-dragging').forEach((el) => el.removeClass('scope-tabs-book-subtree-dragging'));
	}

	private clearCloseTarget(): void {
		this.closeTargetEl?.removeClass('scope-tabs-close-target');
		this.closeTargetEl = null;
		this.restoreClosePreviewWindow?.();
		this.restoreClosePreviewWindow = null;
	}

	private showBookSwitcher(event: MouseEvent): void {
		const menu = new Menu();
		for (const book of this.plugin.scopeResolver.listBooks()) {
			const selected = book.id === this.plugin.settings.selectedBookId;
			menu.addItem((item) => {
				const title = createFragment();
				const label = title.createSpan({ text: book.name });
				if (selected && this.plugin.settings.colorBookSwitcher) {
					label.addClass('scope-tabs-book-switcher-menu-selected');
					label.style.setProperty('--scope-tabs-book-color', this.plugin.colors.getColor(book));
				}
				item.setTitle(title).setChecked(selected).onClick(() => void this.selectBook(book));
			});
		}
		menu.showAtMouseEvent(event);
	}

	private showOpenAnotherMenu(event: MouseEvent, popout: boolean): void {
		const openBookIds = this.plugin.navigation.getOpenBookIds();
		if (this.plugin.settings.selectedBookId) openBookIds.add(this.plugin.settings.selectedBookId);
		const books = this.plugin.scopeResolver.listBooks().filter((book) => !openBookIds.has(book.id));
		if (books.length === 0) return;
		const menu = new Menu();
		for (const book of books) {
			menu.addItem((item) => item
				.setTitle(book.name)
				.setIcon(popout ? 'picture-in-picture-2' : 'book-plus')
				.onClick(async () => {
					await this.plugin.navigation.openAdditionalBook(book, popout);
					this.refreshExplorer();
				}));
		}
		menu.showAtMouseEvent(event);
	}

	private async selectBook(book: BookScope): Promise<void> {
		this.plugin.settings.selectedBookId = book.id;
		this.plugin.navigation.setPrimaryBook(book.id);
		await this.plugin.saveSettings();
		this.refreshExplorer();
		await this.plugin.navigation.activateBook(book);
	}

	private updatePrimaryBookAfterClosures(): void {
		const openBookIds = this.plugin.navigation.getOpenBookIds();
		const selectedBookId = this.plugin.settings.selectedBookId;
		const selectedBookClosed = selectedBookId !== null
			&& this.previousOpenBookIds.has(selectedBookId)
			&& !openBookIds.has(selectedBookId)
			&& openBookIds.size > 0;
		this.previousOpenBookIds = openBookIds;
		if (selectedBookId && openBookIds.has(selectedBookId) && this.primaryPromotionTimer !== null) {
			window.clearTimeout(this.primaryPromotionTimer);
			this.primaryPromotionTimer = null;
		}
		if (!selectedBookClosed || this.primaryPromotionTimer !== null) return;
		const closedBookId = selectedBookId;
		this.primaryPromotionTimer = window.setTimeout(() => {
			this.primaryPromotionTimer = null;
			if (this.plugin.settings.selectedBookId !== closedBookId) return;
			const currentOpenBookIds = this.plugin.navigation.getOpenBookIds();
			if (currentOpenBookIds.has(closedBookId)) return;
			const nextBookId = this.plugin.navigation.getLatestOpenBookId(closedBookId);
			if (!nextBookId) return;
			this.plugin.settings.selectedBookId = nextBookId;
			this.plugin.navigation.setPrimaryBook(nextBookId);
			void this.plugin.saveSettings();
			this.refreshExplorer();
			const nextBook = this.plugin.scopeResolver.listBooks().find((book) => book.id === nextBookId);
			if (nextBook) void this.plugin.navigation.activateBook(nextBook);
		}, 200);
	}

	private queueExplorerRefresh(): void {
		if (this.explorerRefreshQueued) return;
		this.explorerRefreshQueued = true;
		this.explorerRefreshFrame = window.requestAnimationFrame(() => {
			this.explorerRefreshFrame = null;
			this.explorerRefreshQueued = false;
			this.refreshExplorer();
		});
	}

	private refreshCustomCss(): void {
		const css = this.plugin.settings.colorTabs && this.plugin.settings.tabDecorationStyle === 'custom'
			? this.plugin.settings.tabCustomCss
			: '';
		for (const doc of this.getWorkspaceDocuments()) {
			let sheet = this.customStyleSheets.get(doc);
			if (!sheet) {
				sheet = createConstructedStyleSheet(doc);
				if (!sheet) continue;
				doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
				this.customStyleSheets.set(doc, sheet);
			}
			try {
				sheet.replaceSync(css);
			} catch {
				sheet.replaceSync('');
			}
		}
	}

	private getWorkspaceDocuments(): Set<Document> {
		const docs = new Set<Document>([document]);
		this.plugin.app.workspace.iterateAllLeaves((leaf) => docs.add(leaf.view.containerEl.ownerDocument));
		return docs;
	}

}

function getEventElement(event: DragEvent): Element | null {
	const target: unknown = event.target;
	return isUnknownRecord(target) && typeof target.closest === 'function' ? target as unknown as Element : null;
}

function getBookDropDirection(event: DragEvent, target: HTMLElement): BookDropDirection {
	const rect = target.getBoundingClientRect();
	const width = Math.max(rect.width, 1);
	const height = Math.max(rect.height, 1);
	const edges: Array<[BookDropDirection, number]> = [
		['left', Math.abs(event.clientX - rect.left) / width],
		['right', Math.abs(rect.right - event.clientX) / width],
		['up', Math.abs(event.clientY - rect.top) / height],
		['down', Math.abs(rect.bottom - event.clientY) / height],
	];
	edges.sort((left, right) => left[1] - right[1]);
	return edges[0]?.[0] ?? 'right';
}

function getExplorerRootItems(root: HTMLElement): HTMLElement[] {
	const files = root.querySelector<HTMLElement>('.nav-files-container');
	if (!files) return [];
	const candidates = files.querySelectorAll<HTMLElement>('.nav-folder, .nav-file');
	return Array.from(candidates).filter((item) => {
		const path = getExplorerItemPath(item);
		return path.length > 0 && !path.includes('/');
	});
}

function getExplorerItemPath(item: HTMLElement): string {
	const title = item.querySelector<HTMLElement>(':scope > .nav-folder-title, :scope > .nav-file-title');
	return item.dataset.path ?? item.getAttribute('data-path') ?? title?.dataset.path ?? title?.getAttribute('data-path') ?? '';
}

/**
 * Obsidian's file explorer is virtualized: off-screen item elements are intentionally detached,
 * and its logical `vChildren` order—not DOM/CSS order—drives later reattachment. There is no
 * public folder-expansion API, so this adapter feature-detects the same tiny model surface used by
 * core sorting/filtering. If any required piece is absent, book mode falls back to decoration only.
 */
function getExplorerTreeAdapter(plugin: ScopeTabsPlugin, root: HTMLElement): ExplorerTreeAdapter | null {
	const leaf = plugin.app.workspace.getLeavesOfType('file-explorer')
		.find((candidate) => candidate.view.containerEl === root);
	const viewValue: unknown = leaf?.view;
	if (!isUnknownRecord(viewValue)) return null;
	const fileItems = viewValue.fileItems;
	const getSortedFolderItems = viewValue.getSortedFolderItems;
	const tree = viewValue.tree;
	if (!isUnknownRecord(fileItems) || typeof getSortedFolderItems !== 'function' || !isUnknownRecord(tree)) return null;
	const infinityScroll = tree.infinityScroll;
	if (!isUnknownRecord(infinityScroll)) return null;
	const invalidateAll = infinityScroll.invalidateAll;
	if (typeof invalidateAll !== 'function') return null;
	const rootModel = infinityScroll.rootEl;
	if (!isUnknownRecord(rootModel)) return null;
	const virtualChildren = rootModel.vChildren;
	if (!isUnknownRecord(virtualChildren)) return null;
	const setChildren = virtualChildren.setChildren;
	if (typeof setChildren !== 'function') return null;

	let sortedValues: unknown;
	try {
		sortedValues = Reflect.apply(getSortedFolderItems, viewValue, [plugin.app.vault.getRoot()]);
	} catch {
		return null;
	}
	if (!Array.isArray(sortedValues)) return null;
	const rootItems: ExplorerTreeItemAdapter[] = [];
	for (const value of sortedValues) {
		if (!isUnknownRecord(value)) return null;
		const file = value.file;
		const el = value.el;
		if (!isUnknownRecord(file) || typeof file.path !== 'string' || !isHtmlElement(el, root.ownerDocument)) return null;
		const setCollapsed = value.setCollapsed;
		const childrenEl = isHtmlElement(value.childrenEl, root.ownerDocument) ? value.childrenEl : null;
		rootItems.push({
			identity: value,
			el,
			path: file.path,
			collapse: () => {
				if (value.collapsed === true || typeof setCollapsed !== 'function') return;
				try {
					void Reflect.apply(setCollapsed, value, [true, false]);
				} catch {
					// Collapse is optional when Obsidian changes its internal explorer model.
				}
			},
			expand: () => {
				if (value.collapsed === false && childrenEl && childrenEl.parentElement !== el) {
					// Repair an inconsistent expanded item left by an interrupted async collapse/render pass.
					childrenEl.show();
					el.appendChild(childrenEl);
					return;
				}
				if (value.collapsed !== true || typeof setCollapsed !== 'function') return;
				try {
					void Reflect.apply(setCollapsed, value, [false, false]);
				} catch {
					// Expansion is optional when Obsidian changes its internal explorer model.
				}
			},
		});
	}
	const itemsByPath = new Map(rootItems.map((item) => [item.path, item]));
	const baseOrder = rootItems.map((item) => item.identity);
	const setOrder = (items: object[]): void => {
		const current = virtualChildren.children;
		if (Array.isArray(current) && current.length === items.length && current.every((item, index) => item === items[index])) return;
		try {
			Reflect.apply(setChildren, virtualChildren, [items]);
		} catch {
			// Keeping native order is the safe fallback.
		}
	};
	const invalidate = (): void => {
		try {
			Reflect.apply(invalidateAll, infinityScroll, []);
		} catch {
			// DOM decoration remains usable if virtualizer invalidation becomes unavailable.
		}
	};
	return {
		rootItems,
		itemsByPath,
		reorder: (paths) => {
			const ordered: object[] = [];
			const seen = new Set<object>();
			for (const path of paths) {
				const item = itemsByPath.get(path)?.identity;
				if (!item || seen.has(item)) continue;
				seen.add(item);
				ordered.push(item);
			}
			for (const item of baseOrder) {
				if (seen.has(item)) continue;
				seen.add(item);
				ordered.push(item);
			}
			setOrder(ordered);
		},
		restoreOrder: () => setOrder(baseOrder),
		invalidate,
	};
}

function getInternalTabGroupDom(leaf: WorkspaceLeaf): InternalTabGroupDom | null {
	const candidate: unknown = leaf.parent;
	if (!isUnknownRecord(candidate)) return null;
	const children = candidate.children;
	const containerEl = candidate.containerEl;
	if (!isWorkspaceLeafArray(children) || !isHtmlElement(containerEl, leaf.view.containerEl.ownerDocument)) return null;
	return { identity: leaf.parent, children, containerEl };
}

/**
 * Resolve the header against the live children rather than trusting a briefly stale child index
 * during tab closure. New Obsidian builds may expose the header directly; that feature-detected
 * path is preferred, while the group/header order remains the compatibility fallback.
 */
function getTabHeaderForLeaf(leaf: WorkspaceLeaf): HTMLElement | null {
	const leafRecord: unknown = leaf;
	if (isUnknownRecord(leafRecord)) {
		for (const key of ['tabHeaderEl', 'tabHeader']) {
			const candidate = leafRecord[key];
			if (isHtmlElement(candidate, leaf.view.containerEl.ownerDocument) && candidate.hasClass('workspace-tab-header')) return candidate;
		}
	}
	const group = getInternalTabGroupDom(leaf);
	if (!group) return null;
	const liveChildren = group.children.filter((candidate) => candidate.view.containerEl.isConnected);
	const index = liveChildren.indexOf(leaf);
	if (index < 0) return null;
	return group.containerEl
		.querySelectorAll<HTMLElement>('.workspace-tab-header-container-inner > .workspace-tab-header')
		.item(index);
}

function getTabHeaderForFileLeaf(leaf: WorkspaceLeaf, group: InternalTabGroupDom | null, vault: Vault): HTMLElement | null {
	const indexedHeader = getTabHeaderForLeaf(leaf);
	const file = getLeafFile(leaf, vault);
	if (!group || !file) return indexedHeader;
	const headers = group.containerEl.querySelectorAll<HTMLElement>('.workspace-tab-header-container-inner .workspace-tab-header');
	for (const header of Array.from(headers)) {
		const title = header.querySelector<HTMLElement>('.workspace-tab-header-inner-title')?.textContent?.trim();
		if (title === file.basename) return header;
	}
	return indexedHeader;
}

function getTabHeaderHost(leaf: WorkspaceLeaf, group: InternalTabGroupDom | null): HTMLElement | null {
	const selector = '.workspace-tab-header-container-inner';
	const groupHost = group?.containerEl.querySelector<HTMLElement>(selector);
	if (groupHost) return groupHost;
	return leaf.view.containerEl.closest<HTMLElement>('.workspace-tabs')?.querySelector<HTMLElement>(selector) ?? null;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isWorkspaceLeafArray(value: unknown): value is WorkspaceLeaf[] {
	return Array.isArray(value) && value.every((item: unknown) => {
		if (!isUnknownRecord(item) || typeof item.getViewState !== 'function' || typeof item.detach !== 'function') return false;
		const view = item.view;
		return isUnknownRecord(view) && 'containerEl' in view;
	});
}

function isHtmlElement(value: unknown, document: Document): value is HTMLElement {
	const HtmlElement = document.defaultView?.HTMLElement;
	return HtmlElement !== undefined && value instanceof HtmlElement;
}

function createConstructedStyleSheet(document: Document): CSSStyleSheet | undefined {
	const StyleSheet = document.defaultView?.CSSStyleSheet;
	return StyleSheet ? new StyleSheet() : undefined;
}

interface AlwaysOnTopCompatibility {
	isPinned: () => boolean;
	setPinned: (value: boolean) => void;
}

/** Obsidian exposes its Electron window on desktop, but not through the public plugin typings. */
function getAlwaysOnTopCompatibility(leaf: WorkspaceLeaf): AlwaysOnTopCompatibility | null {
	const root = leaf.getRoot();
	const popout = root instanceof WorkspaceWindow || leaf.view.containerEl.ownerDocument !== document;
	if (!popout || !isUnknownRecord(root)) return null;
	const rootWindow = root.win;
	const browserWindow = getElectronWindow(leaf.view.containerEl.ownerDocument.defaultView)
		?? (isUnknownRecord(rootWindow) ? rootWindow.electronWindow : undefined);
	if (!isUnknownRecord(browserWindow)) return null;
	const isAlwaysOnTop = browserWindow.isAlwaysOnTop;
	const setAlwaysOnTop = browserWindow.setAlwaysOnTop;
	if (typeof isAlwaysOnTop !== 'function' || typeof setAlwaysOnTop !== 'function') return null;
	return {
		isPinned: () => {
			try {
				return Reflect.apply(isAlwaysOnTop, browserWindow, []) === true;
			} catch {
				return false;
			}
		},
		setPinned: (value) => {
			try {
				Reflect.apply(setAlwaysOnTop, browserWindow, [value]);
			} catch {
				// Always-on-top is optional and should never affect book routing.
			}
		},
	};
}

/**
 * Temporarily lift a pop-out without activating one of its leaves. Electron's inactive-show and
 * always-on-top methods are desktop-only implementation details, so every method is detected and
 * failure simply leaves the preview in its current stacking position.
 */
function bringPopoutForwardForClosePreview(leaf: WorkspaceLeaf, sourceWindow: Window | null): (() => void) | null {
	const targetWindow = leaf.view.containerEl.ownerDocument.defaultView;
	if (!targetWindow || targetWindow === sourceWindow) return null;
	const root: unknown = leaf.getRoot();
	const rootWindow = isUnknownRecord(root) ? root.win : undefined;
	const browserWindow = getElectronWindow(targetWindow)
		?? (isUnknownRecord(rootWindow) ? rootWindow.electronWindow : undefined);
	if (!isUnknownRecord(browserWindow)) return null;
	const previousFrontWindow = getElectronWindow(sourceWindow);
	const showInactive = browserWindow.showInactive;
	const moveTop = browserWindow.moveTop;
	const isAlwaysOnTop = browserWindow.isAlwaysOnTop;
	const setAlwaysOnTop = browserWindow.setAlwaysOnTop;
	let wasPinned = false;
	let repeatMoveTimer: number | null = null;
	try {
		if (typeof isAlwaysOnTop === 'function') wasPinned = Reflect.apply(isAlwaysOnTop, browserWindow, []) === true;
		if (!wasPinned && typeof setAlwaysOnTop === 'function') {
			try {
				Reflect.apply(setAlwaysOnTop, browserWindow, [true, 'pop-up-menu']);
			} catch {
				Reflect.apply(setAlwaysOnTop, browserWindow, [true]);
			}
		}
		if (typeof showInactive === 'function') Reflect.apply(showInactive, browserWindow, []);
		if (typeof moveTop === 'function') Reflect.apply(moveTop, browserWindow, []);
		repeatMoveTimer = window.setTimeout(() => {
			try {
				if (typeof showInactive === 'function') Reflect.apply(showInactive, browserWindow, []);
				if (typeof moveTop === 'function') Reflect.apply(moveTop, browserWindow, []);
			} catch {
				// The first stacking attempt may already have succeeded.
			}
		}, 0);
	} catch {
		// The red DOM preview remains useful even if Electron window stacking is unavailable.
	}
	let restored = false;
	return () => {
		if (restored) return;
		restored = true;
		if (repeatMoveTimer !== null) window.clearTimeout(repeatMoveTimer);
		try {
			if (!wasPinned && typeof setAlwaysOnTop === 'function') {
				Reflect.apply(setAlwaysOnTop, browserWindow, [false]);
			}
		} catch {
			// The pop-out may already be closing.
		}
		try {
			if (isUnknownRecord(previousFrontWindow) && previousFrontWindow !== browserWindow) {
				const restoreTop = previousFrontWindow.moveTop;
				if (typeof restoreTop === 'function') Reflect.apply(restoreTop, previousFrontWindow, []);
			}
		} catch {
			// Restoring the prior stacking order is optional and must never block closing.
		}
	};
}

function getElectronWindow(candidate: Window | null): unknown {
	const windowRecord: unknown = candidate;
	return isUnknownRecord(windowRecord) ? windowRecord.electronWindow : undefined;
}
