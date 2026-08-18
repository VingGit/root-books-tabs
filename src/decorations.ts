import { MarkdownView, WorkspaceLeaf, setIcon } from 'obsidian';
import type ScopeTabsPlugin from './main';
import type { BookScope } from './types';

interface InternalTabGroup {
	children?: WorkspaceLeaf[];
	containerEl?: HTMLElement;
}

export class DecorationController {
	private customStyleEls = new Map<Document, HTMLStyleElement>();
	private minimizedGroups = new WeakSet<object>();

	constructor(private readonly plugin: ScopeTabsPlugin) {}

	refresh(): void {
		if (!this.plugin.scopeResolver.hasMultipleBooks()) {
			this.cleanup();
			return;
		}
		this.refreshCustomCss();
		this.refreshNotesAndTabs();
		this.refreshExplorer();
		this.refreshBookControls();
	}

	cleanup(): void {
		const docs = new Set<Document>([document, ...this.customStyleEls.keys()]);
		for (const style of this.customStyleEls.values()) style.remove();
		this.customStyleEls.clear();
		for (const doc of docs) {
			doc.querySelectorAll('.scope-tabs-book-controls, .scope-tabs-book-label').forEach((el) => el.remove());
			doc.querySelectorAll<HTMLElement>('[data-scope-tabs-book]').forEach((el) => {
				el.removeAttribute('data-scope-tabs-book');
				el.style.removeProperty('--scope-tabs-book-color');
			});
		}
	}

	minimizeGroup(leaf: WorkspaceLeaf): void {
		const group = leaf.parent as unknown as InternalTabGroup;
		if (!group?.containerEl) return;
		this.minimizedGroups.add(group as object);
		group.containerEl.addClass('scope-tabs-group-minimized');
		const restoreOnTabClick = (event: MouseEvent) => {
			const target = event.target instanceof Element ? event.target : null;
			if (!target?.closest('.workspace-tab-header')) return;
			group.containerEl?.removeEventListener('click', restoreOnTabClick);
			this.restoreGroup(leaf);
		};
		group.containerEl.addEventListener('click', restoreOnTabClick);
	}

	restoreGroup(leaf: WorkspaceLeaf): void {
		const group = leaf.parent as unknown as InternalTabGroup;
		if (!group?.containerEl) return;
		this.minimizedGroups.delete(group as object);
		group.containerEl.removeClass('scope-tabs-group-minimized');
	}

	private refreshNotesAndTabs(): void {
		for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) {
			const file = leaf.view instanceof MarkdownView ? leaf.view.file : null;
			const book = this.plugin.scopeResolver.resolveFile(file);
			if (!book) continue;
			const color = this.plugin.colors.getColor(book);
			this.decorateLeaf(leaf, book, color);
			this.decorateTabHeader(leaf, book, color);
		}
	}

	private decorateLeaf(leaf: WorkspaceLeaf, book: BookScope, color: string): void {
		leaf.containerEl.setAttr('data-scope-tabs-book', book.id);
		leaf.containerEl.style.setProperty('--scope-tabs-book-color', color);
		if (!(leaf.view instanceof MarkdownView)) return;
		const content = leaf.view.contentEl;
		content.querySelector(':scope > .scope-tabs-book-label')?.remove();
		if (!this.plugin.settings.showBookLabel) return;
		const label = content.createDiv({ cls: 'scope-tabs-book-label', text: book.name, prepend: true });
		label.style.setProperty('--scope-tabs-book-color', color);
	}

	private decorateTabHeader(leaf: WorkspaceLeaf, book: BookScope, color: string): void {
		const group = leaf.parent as unknown as InternalTabGroup;
		if (!group?.containerEl || !Array.isArray(group.children)) return;
		const index = group.children.indexOf(leaf);
		if (index < 0) return;
		const headers = group.containerEl.querySelectorAll<HTMLElement>('.workspace-tab-header');
		const header = headers.item(index);
		if (!header) return;
		header.setAttr('data-scope-tabs-book', book.id);
		header.style.setProperty('--scope-tabs-book-color', color);
		header.toggleClass('scope-tabs-color-tab', this.plugin.settings.colorTabs);
		header.setAttr('data-scope-tabs-tab-style', this.plugin.settings.tabDecorationStyle);
	}

	private refreshExplorer(): void {
		const activeBook = this.plugin.scopeResolver.resolveFile(this.plugin.app.workspace.getActiveFile());
		const books = new Map(this.plugin.scopeResolver.listBooks().map((book) => [book.id, book]));
		document.querySelectorAll<HTMLElement>('.nav-folder').forEach((folder) => {
			folder.removeClass('scope-tabs-active-book-folder');
			folder.removeAttribute('data-scope-tabs-book');
			folder.style.removeProperty('--scope-tabs-book-color');
			const title = folder.querySelector<HTMLElement>(':scope > .nav-folder-title');
			const path = folder.getAttribute('data-path') ?? title?.getAttribute('data-path') ?? title?.dataset.path ?? '';
			const book = books.get(path);
			if (!book || activeBook?.id !== book.id || !this.plugin.settings.colorExplorer) return;
			folder.addClass('scope-tabs-active-book-folder');
			folder.setAttr('data-scope-tabs-book', book.id);
			folder.setAttr('data-scope-tabs-explorer-style', this.plugin.settings.explorerDecorationStyle);
			folder.style.setProperty('--scope-tabs-book-color', this.plugin.colors.getColor(book));
		});
	}

	private refreshBookControls(): void {
		const seen = new Set<object>();
		for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) {
			const group = leaf.parent as unknown as InternalTabGroup;
			if (!group?.containerEl || seen.has(group as object)) continue;
			seen.add(group as object);
			group.containerEl.querySelector('.scope-tabs-book-controls')?.remove();
			const book = this.plugin.navigation.getBookForGroup(leaf);
			if (!book || !this.plugin.navigation.isManagedGroup(leaf)) continue;
			const host = group.containerEl.querySelector<HTMLElement>('.workspace-tab-header-container') ?? group.containerEl;
			const controls = host.createDiv({ cls: 'scope-tabs-book-controls' });
			controls.setAttr('aria-label', `Scope Tabs controls for ${book.name}`);

			const minimize = controls.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Minimize book' } });
			setIcon(minimize, 'minus');
			minimize.addEventListener('click', (event: MouseEvent) => {
				event.stopPropagation();
				this.minimizeGroup(leaf);
			});

			const popout = controls.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Pop out book' } });
			setIcon(popout, 'picture-in-picture-2');
			popout.addEventListener('click', (event: MouseEvent) => {
				event.stopPropagation();
				void this.plugin.navigation.popOutBookGroup(leaf);
			});

			const close = controls.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Close book' } });
			setIcon(close, 'x');
			close.addEventListener('click', (event: MouseEvent) => {
				event.stopPropagation();
				void this.plugin.navigation.closeBookGroup(leaf);
			});
		}
	}

	private refreshCustomCss(): void {
		const docs = new Set<Document>([document]);
		for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) docs.add(leaf.containerEl.doc);
		for (const doc of docs) {
			let style = this.customStyleEls.get(doc);
			if (!style || !style.isConnected) {
				style = doc.createElement('style');
				style.className = 'scope-tabs-user-css';
				doc.head.appendChild(style);
				this.customStyleEls.set(doc, style);
			}
			style.textContent = `${this.plugin.settings.tabCustomCss}\n${this.plugin.settings.explorerCustomCss}`;
		}
	}
}
