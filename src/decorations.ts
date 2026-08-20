import { MarkdownView, Menu, Notice, WorkspaceLeaf, WorkspaceWindow, setIcon } from 'obsidian';
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
	toggle: HTMLElement;
	bar: HTMLElement;
	openAnother: HTMLElement;
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
	private primaryPromotionTimer: number | null = null;
	private previousOpenBookIds = new Set<string>();
	private instancePickerMenu: Menu | null = null;
	private instancePickerBookId: string | null = null;
	private closeTargetEl: HTMLElement | null = null;
	private bookDragDocuments = new Map<Document, () => void>();
	private bookGroupDrag: BookGroupDrag | null = null;
	private bookDropTargetEl: HTMLElement | null = null;
	private bookButtonLongPressCancels = new Set<() => void>();
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
	}

	cleanup(): void {
		if (this.explorerRefreshFrame !== null) window.cancelAnimationFrame(this.explorerRefreshFrame);
		if (this.primaryPromotionTimer !== null) window.clearTimeout(this.primaryPromotionTimer);
		this.explorerRefreshFrame = null;
		this.primaryPromotionTimer = null;
		this.explorerRefreshQueued = false;
		this.previousOpenBookIds.clear();
		this.instancePickerMenu?.hide();
		this.instancePickerMenu = null;
		this.instancePickerBookId = null;
		this.clearCloseTarget();
		this.clearBookGroupDrag();
		this.clearBookButtonLongPresses();
		for (const removeListeners of this.bookDragDocuments.values()) removeListeners();
		this.bookDragDocuments.clear();
		const docs = new Set<Document>([...this.getWorkspaceDocuments(), ...this.customStyleSheets.keys()]);
		for (const decoration of this.explorerDecorations.values()) decoration.observer.disconnect();
		this.explorerDecorations.clear();
		for (const [doc, sheet] of this.customStyleSheets) {
			doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((candidate) => candidate !== sheet);
		}
		this.customStyleSheets.clear();
		for (const doc of docs) {
			doc.querySelectorAll('.scope-tabs-book-menu-tab, .scope-tabs-book-mode-toggle, .scope-tabs-book-switcher, .scope-tabs-book-subtree-bar, .scope-tabs-open-book-button').forEach((el) => el.remove());
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
		const group = getInternalTabGroupDom(leaf);
		if (!group) return;
		const index = group.children.indexOf(leaf);
		if (index < 0) return;
		const headers = group.containerEl.querySelectorAll<HTMLElement>('.workspace-tab-header-container-inner > .workspace-tab-header');
		const header = headers.item(index);
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
		const seen = new Set<object>();
		this.plugin.app.workspace.iterateAllLeaves((leaf) => {
			const group = getInternalTabGroupDom(leaf);
			const identity = group?.identity ?? leaf.parent;
			if (seen.has(identity)) return;
			seen.add(identity);
			const book = this.plugin.navigation.getBookForGroup(leaf);
			if (!book) return;
			const host = getTabHeaderHost(leaf, group);
			if (!host) return;
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
			new Notice('Root Books Tabs could not finish sorting the tabs. Existing tabs were preserved where possible.');
		} finally {
			this.sortingTabs = false;
			this.refresh();
		}
	}

	private async animateTabSort(leaves: WorkspaceLeaf[]): Promise<void> {
		const headers = new Set<HTMLElement>();
		for (const leaf of leaves) {
			const group = getInternalTabGroupDom(leaf);
			if (!group) continue;
			const index = group.children.indexOf(leaf);
			const header = index >= 0
				? group.containerEl.querySelectorAll<HTMLElement>('.workspace-tab-header-container-inner > .workspace-tab-header').item(index)
				: null;
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
			decoration.observer.disconnect();
			decoration.toggle.remove();
			decoration.bar.remove();
			decoration.openAnother.remove();
			this.explorerDecorations.delete(root);
		}
	}

	private ensureExplorerDecoration(root: HTMLElement): void {
		let decoration = this.explorerDecorations.get(root);
		const actions = root.querySelector<HTMLElement>('.nav-buttons-container');
		const files = root.querySelector<HTMLElement>('.nav-files-container');
		if (!actions || !files) return;
		if (!decoration) {
			const toggle = actions.createEl('button', {
				cls: 'clickable-icon scope-tabs-book-mode-toggle',
				attr: { 'aria-label': 'Toggle Root Books Tabs book mode', type: 'button' },
			});
			setIcon(toggle, 'book-open-check');
			toggle.addEventListener('click', () => this.toggleBookMode());
			const bar = root.createEl('button', {
				cls: 'scope-tabs-book-switcher',
				attr: { type: 'button', 'aria-haspopup': 'menu' },
			});
			files.parentElement?.insertBefore(bar, files);
			bar.addEventListener('click', (event: MouseEvent) => this.showBookSwitcher(event));
			const openAnother = files.createEl('button', {
				cls: 'scope-tabs-open-book-button',
				attr: { type: 'button', 'aria-haspopup': 'menu', 'aria-label': 'Open another book' },
			});
			openAnother.createSpan({ cls: 'scope-tabs-open-book-default', text: '+ Open another book' });
			openAnother.createSpan({ cls: 'scope-tabs-open-book-hover', text: 'Shift-click opens another book in a pop-out window instead.' });
			openAnother.addEventListener('click', (event: MouseEvent) => {
				event.stopPropagation();
				this.showOpenAnotherMenu(event, event.shiftKey);
			});
			const observer = new MutationObserver(() => this.queueExplorerRefresh());
			observer.observe(files, { childList: true, subtree: true });
			decoration = { observer, toggle, bar, openAnother };
			this.explorerDecorations.set(root, decoration);
		}
		decoration.toggle.toggleClass('is-active', this.plugin.settings.bookModeEnabled);
		decoration.toggle.setAttr('aria-pressed', String(this.plugin.settings.bookModeEnabled));
	}

	private applyBookMode(root: HTMLElement): void {
		const books = this.plugin.scopeResolver.listBooks();
		const booksById = new Map(books.map((book) => [book.id, book]));
		const bookOrder = this.plugin.navigation.getBookOrder();
		const bookOrderIndexes = new Map(bookOrder.map((id, index) => [id, index]));
		const openBookIds = this.plugin.navigation.getOpenBookIds();
		const selected = books.find((book) => book.id === this.plugin.settings.selectedBookId) ?? books[0];
		if (!selected) return;
		if (this.plugin.settings.selectedBookId !== selected.id) {
			this.plugin.settings.selectedBookId = selected.id;
			void this.plugin.saveSettings();
		}
		const decoration = this.explorerDecorations.get(root);
		if (!decoration) return;
		decoration.bar.setText(selected.name);
		decoration.bar.setAttr('aria-label', `Selected book: ${selected.name}. Choose another book.`);
		decoration.bar.toggle(this.plugin.settings.bookModeEnabled);
		decoration.bar.toggleClass('scope-tabs-book-switcher-colored', this.plugin.settings.colorBookSwitcher);
		decoration.bar.style.setProperty('--scope-tabs-book-color', this.plugin.colors.getColor(selected));
		const visibleBookIds = new Set(openBookIds);
		visibleBookIds.add(selected.id);
		decoration.openAnother.toggle(this.plugin.settings.bookModeEnabled && books.some((book) => !visibleBookIds.has(book.id)));
		root.toggleClass('scope-tabs-book-mode', this.plugin.settings.bookModeEnabled);

		root.querySelectorAll<HTMLElement>('.scope-tabs-book-mode-hidden, .scope-tabs-book-mode-selected, .scope-tabs-book-mode-secondary, .scope-tabs-book-root-title-hidden').forEach((el) => {
			el.style.removeProperty('order');
			el.removeClasses(['scope-tabs-book-mode-hidden', 'scope-tabs-book-mode-selected', 'scope-tabs-book-mode-secondary', 'scope-tabs-book-root-title-hidden']);
		});
		root.querySelectorAll<HTMLElement>('.scope-tabs-book-root-list').forEach((el) => el.removeClass('scope-tabs-book-root-list'));
		if (!this.plugin.settings.bookModeEnabled) {
			root.querySelectorAll('.scope-tabs-book-subtree-bar').forEach((el) => el.remove());
			return;
		}
		for (const item of getExplorerRootItems(root)) {
			item.parentElement?.addClass('scope-tabs-book-root-list');
			const path = getExplorerItemPath(item);
			const subtreeBar = item.querySelector<HTMLElement>(':scope > .scope-tabs-book-subtree-bar');
			if (path === selected.folderPath && item.hasClass('nav-folder')) {
				subtreeBar?.remove();
				item.addClass('scope-tabs-book-mode-selected');
				item.querySelector<HTMLElement>(':scope > .nav-folder-title')?.addClass('scope-tabs-book-root-title-hidden');
				expandExplorerFolder(item);
			} else if (openBookIds.has(path) && item.hasClass('nav-folder')) {
				const book = booksById.get(path);
				if (!book) continue;
				item.addClass('scope-tabs-book-mode-secondary');
				item.style.order = String(bookOrderIndexes.get(path) ?? bookOrder.length);
				item.querySelector<HTMLElement>(':scope > .nav-folder-title')?.addClass('scope-tabs-book-root-title-hidden');
				expandExplorerFolder(item);
				this.ensureSubtreeBar(item, book);
			} else {
				subtreeBar?.remove();
				item.addClass('scope-tabs-book-mode-hidden');
			}
		}
	}

	private ensureSubtreeBar(folder: HTMLElement, book: BookScope): void {
		let bar = folder.querySelector<HTMLButtonElement>(':scope > .scope-tabs-book-subtree-bar');
		if (!bar) {
			bar = folder.createEl('button', {
				cls: 'scope-tabs-book-subtree-bar',
				attr: { type: 'button' },
			});
			const children = folder.querySelector<HTMLElement>(':scope > .nav-folder-children');
			if (children) folder.insertBefore(bar, children);
			bar.addEventListener('click', (event: MouseEvent) => {
				event.stopPropagation();
				const id = bar?.dataset.bookId;
				const currentBook = this.plugin.scopeResolver.listBooks().find((candidate) => candidate.id === id);
				if (!currentBook) return;
				if (event.ctrlKey) {
					this.plugin.navigation.closeAllBookGroups(currentBook);
					return;
				}
				if (event.shiftKey) return;
				this.plugin.navigation.closeBook(currentBook);
			});
			const showInstancePicker = (event: MouseEvent) => {
				if (!event.shiftKey) {
					bar?.removeClass('scope-tabs-instance-picker-ready');
					return;
				}
				const id = bar?.dataset.bookId;
				const currentBook = this.plugin.scopeResolver.listBooks().find((candidate) => candidate.id === id);
				bar?.toggleClass('scope-tabs-instance-picker-ready', currentBook ? this.showBookInstancePicker(event, currentBook) : false);
			};
			bar.addEventListener('mouseenter', showInstancePicker);
			bar.addEventListener('mousemove', showInstancePicker);
			bar.addEventListener('mouseleave', () => bar?.removeClass('scope-tabs-instance-picker-ready'));
		}
		bar.dataset.bookId = book.id;
		let title = bar.querySelector<HTMLElement>(':scope > .scope-tabs-book-subtree-title');
		let close = bar.querySelector<HTMLElement>(':scope > .scope-tabs-book-subtree-close');
		let choose = bar.querySelector<HTMLElement>(':scope > .scope-tabs-book-subtree-choose');
		if (!title) title = bar.createSpan({ cls: 'scope-tabs-book-subtree-title' });
		if (!close) {
			close = bar.createSpan({ cls: 'scope-tabs-book-subtree-close' });
			close.createSpan({ cls: 'scope-tabs-book-subtree-close-label', text: 'Close book' });
			close.createSpan({ cls: 'scope-tabs-book-subtree-close-hint', text: 'Shift: choose window · Ctrl+click: close all' });
		}
		if (!choose) choose = bar.createSpan({ cls: 'scope-tabs-book-subtree-choose' });
		if (title.textContent !== book.name) title.setText(book.name);
		if (choose.textContent !== 'Choose book window') choose.setText('Choose book window');
		bar.setAttr('aria-label', `Close book ${book.name}. Hold Shift to choose a book window. Ctrl-click to close all book windows.`);
		bar.toggleClass('scope-tabs-book-switcher-colored', this.plugin.settings.colorBookSwitcher);
		bar.style.setProperty('--scope-tabs-book-color', this.plugin.colors.getColor(book));
	}

	private showBookInstancePicker(event: MouseEvent, book: BookScope): boolean {
		const instances = this.plugin.navigation.getBookGroupInstances(book);
		if (instances.length < 2) return false;
		if (this.instancePickerBookId === book.id) return true;
		this.instancePickerMenu?.hide();
		const menu = new Menu();
		this.instancePickerMenu = menu;
		this.instancePickerBookId = book.id;
		instances.forEach((leaf, index) => {
			const activeLeaf = this.plugin.app.workspace.getMostRecentLeaf(leaf.parent) ?? leaf;
			const file = getLeafFile(activeLeaf, this.plugin.app.vault);
			const location = this.plugin.navigation.getGroupLocation(leaf);
			const title = createFragment();
			const label = title.createSpan({
				cls: 'scope-tabs-book-instance-option',
				text: `${location === 'popout' ? 'Pop-out' : 'Main workspace'} ${index + 1}${file ? ` — ${file.basename}` : ''}`,
			});
			label.addEventListener('mouseenter', () => this.setCloseTarget(leaf));
			label.addEventListener('mouseleave', () => this.clearCloseTarget());
			menu.addItem((item) => item
				.setTitle(title)
				.setIcon(location === 'popout' ? 'picture-in-picture-2' : 'panels-top-left')
				.setWarning(true)
				.onClick(() => this.plugin.navigation.closeBookGroup(leaf)));
		});
		menu.onHide(() => {
			if (this.instancePickerMenu === menu) {
				this.instancePickerMenu = null;
				this.instancePickerBookId = null;
			}
			this.clearCloseTarget();
		});
		menu.showAtMouseEvent(event);
		return true;
	}

	private setCloseTarget(leaf: WorkspaceLeaf): void {
		this.clearCloseTarget();
		const group = getInternalTabGroupDom(leaf);
		const target = group?.containerEl ?? leaf.view.containerEl.closest<HTMLElement>('.workspace-tabs');
		if (!target) return;
		target.addClass('scope-tabs-close-target');
		this.closeTargetEl = target;
	}

	private clearCloseTarget(): void {
		this.closeTargetEl?.removeClass('scope-tabs-close-target');
		this.closeTargetEl = null;
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

/** Folder expansion is DOM-sensitive and optional; hiding/filtering remains safe if the adapter cannot expand it. */
function expandExplorerFolder(folder: HTMLElement): void {
	const title = folder.querySelector<HTMLElement>(':scope > .nav-folder-title');
	if (!title) return;
	const collapsed = folder.hasClass('is-collapsed') || title.hasClass('is-collapsed') || title.getAttribute('aria-expanded') === 'false';
	if (!collapsed) return;
	title.dispatchEvent(new MouseEvent('click', { bubbles: true, view: title.ownerDocument.defaultView }));
}

function getInternalTabGroupDom(leaf: WorkspaceLeaf): InternalTabGroupDom | null {
	const candidate: unknown = leaf.parent;
	if (!isUnknownRecord(candidate)) return null;
	const children = candidate.children;
	const containerEl = candidate.containerEl;
	if (!isWorkspaceLeafArray(children) || !isHtmlElement(containerEl, leaf.view.containerEl.ownerDocument)) return null;
	return { identity: leaf.parent, children, containerEl };
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
	return Array.isArray(value) && value.every((item: unknown) => item instanceof WorkspaceLeaf);
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
	const browserWindow = isUnknownRecord(rootWindow) ? rootWindow.electronWindow : undefined;
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
