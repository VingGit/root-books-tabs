import { MarkdownView, Notice, type Hotkey, type Menu, type ViewState, type WorkspaceLeaf } from 'obsidian';
import type ScopeTabsPlugin from './main';
import { getSourcePopoutInit } from './popout-position';

export class FrontmatterActions {
	private shown = new Map<WorkspaceLeaf, ViewState>();
	private rootLeaf: WorkspaceLeaf | null = null;
	private decoratedMenus = new WeakSet<Menu>();
	constructor(private readonly plugin: ScopeTabsPlugin) {}

	install(): void {
		const actions = [
			{ id: 'show-note-frontmatter', name: 'Show frontmatter for the focused note', key: 'P', run: () => this.showFocused() },
			{ id: 'open-vault-frontmatter', name: 'Open vault config in a standalone pop-out', key: 'R', run: () => this.showRoot() },
			{ id: 'hide-opened-frontmatter', name: 'Hide frontmatter opened by Root Books Tabs', key: 'H', run: () => this.hide() },
		];
		// User-requested shortcuts are registered only after checking the native registry for collisions.
		for (const action of actions) this.plugin.addCommand({ id: action.id, name: action.name, hotkeys: this.availableHotkey(action.key), callback: () => action.run() });
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

	/** No public shortcut registry exists. Assign defaults only when every binding can be inspected. */
	private availableHotkey(key: string): Hotkey[] {
		const app = this.plugin.app as unknown as Record<string, unknown>;
		const manager = app.hotkeyManager;
		if (!isRecord(manager) || !isRecord(manager.defaultKeys) || !isRecord(manager.customKeys)) return [];
		const bindings = { ...manager.defaultKeys, ...manager.customKeys };
		for (const value of Object.values(bindings)) {
			if (!Array.isArray(value)) return [];
			for (const binding of value as unknown[]) {
				if (!isRecord(binding) || !Array.isArray(binding.modifiers)) return [];
				if (typeof binding.key !== 'string') return [];
				if (binding.key.toUpperCase() === key && binding.modifiers.includes('Shift') && (binding.modifiers.includes('Mod') || binding.modifiers.includes('Ctrl'))) return [];
			}
		}
		return [{ modifiers: ['Mod', 'Shift'], key }];
	}
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
