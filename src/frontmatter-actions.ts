import { MarkdownView, Notice, type Menu, type ViewState, type WorkspaceLeaf } from 'obsidian';
import type ScopeTabsPlugin from './main';
import { getSourcePopoutInit } from './popout-position';

export class FrontmatterActions {
	private shown = new Map<WorkspaceLeaf, ViewState>();
	private rootLeaf: WorkspaceLeaf | null = null;
	private decoratedMenus = new WeakSet<Menu>();
	constructor(private readonly plugin: ScopeTabsPlugin) {}

	install(): void {
		const actions = [
			{ id: 'show-note-frontmatter', name: 'Show frontmatter for the focused note', run: () => this.showFocused() },
			{ id: 'open-vault-frontmatter', name: 'Open vault config in a standalone pop-out', run: () => this.showRoot() },
			{ id: 'hide-opened-frontmatter', name: 'Hide frontmatter opened by Root Books Tabs', run: () => this.hide() },
		];
		for (const action of actions) this.plugin.addCommand({ id: action.id, name: action.name, callback: () => action.run() });
		this.plugin.registerEvent(this.plugin.app.workspace.on('editor-menu', (menu, _editor, info) => {
			this.addMenuItems(menu, info instanceof MarkdownView ? info.leaf : undefined);
		}));
		this.plugin.registerEvent(this.plugin.app.workspace.on('file-menu', (menu, file, _source, leaf) => {
			if (leaf?.view instanceof MarkdownView && leaf.view.file === file) this.addMenuItems(menu, leaf);
		}));
	}

	/** Shared by native note menus and the reading-view context-menu decoration. */
	addMenuItems(menu: Menu, leaf?: WorkspaceLeaf): void {
		if (this.decoratedMenus.has(menu)) return;
		this.decoratedMenus.add(menu);
		menu.addSeparator();
		menu.addItem(item => item.setTitle('Show frontmatter for the focused note').setIcon('list').onClick(() => leaf ? this.show(leaf) : this.showFocused()));
		menu.addItem(item => item.setTitle('Open vault config in a standalone pop-out').setIcon('external-link').onClick(() => this.showRoot(leaf)));
		menu.addItem(item => item.setTitle('Hide frontmatter opened this way').setIcon('eye-off').onClick(() => this.hide()));
	}

	private async showFocused(): Promise<void> {
		const leaf = this.plugin.app.workspace.getMostRecentLeaf();
		if (!leaf || !(leaf.view instanceof MarkdownView)) return;
		await this.show(leaf);
	}

	private async show(leaf: WorkspaceLeaf): Promise<void> {
		if (!(leaf.view instanceof MarkdownView) || !leaf.view.file) return;
		if (!this.shown.has(leaf)) this.shown.set(leaf, structuredClone(leaf.getViewState()));
		const state = leaf.getViewState();
		await leaf.setViewState({ ...state, state: { ...state.state, mode: 'source', source: true } });
		if (leaf.view instanceof MarkdownView) leaf.view.editor.setCursor({ line: 0, ch: 0 });
	}

	private async showRoot(sourceLeaf?: WorkspaceLeaf): Promise<void> {
		try {
			const file = await this.plugin.vaultConfig.ensureRoot();
			if (!this.rootLeaf || !this.rootLeaf.view.containerEl.isConnected) {
				const source = sourceLeaf ?? this.plugin.app.workspace.getMostRecentLeaf();
				const init = source ? getSourcePopoutInit(source) : undefined;
				this.rootLeaf = init ? this.plugin.app.workspace.openPopoutLeaf(init) : this.plugin.app.workspace.openPopoutLeaf();
			}
			await this.rootLeaf.openFile(file);
			await this.show(this.rootLeaf);
		} catch (error) { console.error(error); new Notice('Could not open the vault config pop-out.'); }
	}

	async hide(): Promise<void> {
		const root = this.rootLeaf; this.rootLeaf = null;
		for (const [leaf, state] of this.shown) {
			if (leaf === root || !leaf.view.containerEl.isConnected) continue;
			if (leaf.getViewState().state?.file === state.state?.file) await leaf.setViewState(state);
		}
		this.shown.clear(); root?.detach();
	}

}
