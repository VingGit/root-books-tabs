import { Notice, Plugin } from 'obsidian';
import { BookColorService } from './colors';
import { DecorationController } from './decorations';
import { BookNavigationController } from './navigation';
import { NewNoteLocationController } from './new-note';
import { FirstLevelFolderScopeResolver } from './scope';
import { migrateRuntimeState, migrateSettings } from './settings-model';
import { MissingConfigModal, ScopeTabsSettingTab } from './settings';
import type { ScopeTabsRuntimeStateV1, ScopeTabsSettings } from './types';

export default class ScopeTabsPlugin extends Plugin {
	settings!: ScopeTabsSettings;
	runtimeState!: ScopeTabsRuntimeStateV1;
	readonly scopeResolver = new FirstLevelFolderScopeResolver(this.app.vault);
	readonly colors = new BookColorService(this);
	readonly navigation = new BookNavigationController(this);
	readonly decorations = new DecorationController(this);
	readonly newNoteLocation = new NewNoteLocationController(this);
	private unloading = false;
	private saveQueue: Promise<void> = Promise.resolve();

	async onload(): Promise<void> {
		this.unloading = false;
		await this.loadSettings();
		this.addSettingTab(new ScopeTabsSettingTab(this.app, this));
		this.addCommand({
			id: 'toggle-book-mode',
			name: 'Toggle book mode',
			callback: () => this.decorations.toggleBookMode(),
		});
		this.addCommand({
			id: 'manage-missing-book-config-notes',
			name: 'Manage missing book config notes',
			callback: () => this.openMissingConfigManager(),
		});
		this.addCommand({
			id: 'refresh-book-colors-and-decorations',
			name: 'Refresh book colors and decorations',
			callback: async () => {
				await this.refreshColorConfiguration(false);
				new Notice('Root books tabs refreshed book colors and decorations.');
			},
		});

		this.app.workspace.onLayoutReady(() => {
			void this.initializeWorkspace();
		});
	}

	onunload(): void {
		this.unloading = true;
		this.navigation.uninstall();
		this.newNoteLocation.uninstall();
		this.decorations.cleanup();
	}

	async loadSettings(): Promise<void> {
		const saved = await this.loadData() as unknown;
		this.settings = migrateSettings(saved);
		this.runtimeState = migrateRuntimeState(isRecord(saved) ? saved.runtimeStateV1 : undefined);
	}

	async saveSettings(): Promise<void> {
		await this.persistState();
	}

	async saveRuntimeState(): Promise<void> {
		await this.persistState();
	}

	async refreshColorConfiguration(notify: boolean): Promise<void> {
		if (this.unloading) return;
		if (!this.scopeResolver.hasMultipleBooks()) {
			this.decorations.refresh();
			return;
		}
		const books = this.scopeResolver.listBooks();
		await this.colors.ensureManualColors(books);
		if (this.settings.colorMode === 'frontmatter') await this.colors.ensureFrontmatterColors(books);
		if (this.unloading) return;
		this.decorations.refresh();
		if (notify) await this.maybeNotifyMissingConfigFiles();
	}

	openMissingConfigManager(): void {
		if (!this.scopeResolver.hasMultipleBooks()) {
			new Notice('Root books tabs is inactive because this vault has fewer than two first-level folders.');
			return;
		}
		const books = this.scopeResolver.listBooks();
		new MissingConfigModal(this.app, this, this.colors.getMissingConfigBooks(books)).open();
	}

	private async initializeWorkspace(): Promise<void> {
		if (this.unloading) return;
		const books = this.scopeResolver.listBooks();
		if (books.length > 1 && !books.some((book) => book.id === this.settings.selectedBookId)) {
			this.settings.selectedBookId = books[0]?.id ?? null;
			await this.saveSettings();
		}
		if (this.unloading) return;
		this.navigation.install();
		this.newNoteLocation.install();
		this.decorations.refresh();
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.refreshWorkspaceState()));
		this.registerEvent(this.app.workspace.on('layout-change', () => this.refreshWorkspaceState()));
		this.registerEvent(this.app.workspace.on('file-open', () => {
			this.refreshWorkspaceState();
			window.setTimeout(() => this.refreshWorkspaceState(), 0);
		}));
		this.registerEvent(this.app.workspace.on('window-open', () => {
			window.setTimeout(() => this.refreshWorkspaceState(), 0);
		}));
		this.registerEvent(this.app.workspace.on('window-close', (workspaceWindow) => {
			this.navigation.handleWindowClose(workspaceWindow);
		}));
		this.registerEvent(this.app.workspace.on('quit', () => {
			this.navigation.prepareForQuit();
		}));
		this.registerEvent(this.app.vault.on('create', () => void this.handleVaultStructureChange()));
		this.registerEvent(this.app.vault.on('delete', () => void this.handleVaultStructureChange()));
		this.registerEvent(this.app.vault.on('rename', () => void this.handleVaultStructureChange()));
		this.registerEvent(this.app.metadataCache.on('changed', () => {
			if (this.settings.colorMode === 'frontmatter') this.decorations.refresh();
		}));

		try {
			await this.refreshColorConfiguration(false);
			if (!this.unloading) await this.maybeNotifyMissingConfigFiles();
		} catch (error) {
			console.error('Root Books Tabs could not initialize book color metadata.', error);
			new Notice('Scope tabs navigation is active, but book color metadata could not be initialized. Check the developer console for details.');
		}
	}

	private async maybeNotifyMissingConfigFiles(): Promise<void> {
		if (this.settings.colorMode !== 'frontmatter' || !this.settings.notifyMissingConfigFiles) return;
		const missing = this.colors.getMissingConfigBooks(this.scopeResolver.listBooks());
		if (missing.length === 0) return;
		new Notice(`Root Books Tabs: ${missing.length} book${missing.length === 1 ? '' : 's'} missing ${this.settings.configFileBaseName}.md. Run “Root Books Tabs: Manage missing book config notes” to create them, or disable notifications in settings.`, 9000);
	}

	private async handleVaultStructureChange(): Promise<void> {
		try {
			await this.refreshColorConfiguration(false);
		} catch (error) {
			console.error('Root Books Tabs could not refresh after a vault structure change.', error);
		}
	}

	private persistState(): Promise<void> {
		const snapshot = structuredClone({ ...this.settings, runtimeStateV1: this.runtimeState });
		this.saveQueue = this.saveQueue.then(() => this.saveData(snapshot));
		return this.saveQueue;
	}

	private refreshWorkspaceState(): void {
		if (this.unloading) return;
		this.navigation.reconcileGroupRegistry();
		this.decorations.refresh();
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
