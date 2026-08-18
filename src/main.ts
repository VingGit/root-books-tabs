import { Notice, Plugin } from 'obsidian';
import { BookColorService } from './colors';
import { DecorationController } from './decorations';
import { BookNavigationController } from './navigation';
import { FirstLevelFolderScopeResolver } from './scope';
import { DEFAULT_SETTINGS } from './settings-model';
import { MissingConfigModal, ScopeTabsSettingTab } from './settings';
import type { ScopeTabsSettings } from './types';

export default class ScopeTabsPlugin extends Plugin {
	settings!: ScopeTabsSettings;
	readonly scopeResolver = new FirstLevelFolderScopeResolver(this.app.vault);
	readonly colors = new BookColorService(this);
	readonly navigation = new BookNavigationController(this);
	readonly decorations = new DecorationController(this);

	async onload(): Promise<void> {
		await this.loadSettings();
		await this.refreshColorConfiguration(false);
		this.addSettingTab(new ScopeTabsSettingTab(this.app, this));
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
				new Notice('Scope Tabs refreshed book colors and decorations.');
			},
		});

		this.app.workspace.onLayoutReady(() => {
			this.navigation.install();
			this.decorations.refresh();
			void this.maybeNotifyMissingConfigFiles();
		});

		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.decorations.refresh()));
		this.registerEvent(this.app.workspace.on('layout-change', () => this.decorations.refresh()));
		this.registerEvent(this.app.workspace.on('file-open', () => this.decorations.refresh()));
		this.registerEvent(this.app.vault.on('create', () => void this.handleVaultStructureChange()));
		this.registerEvent(this.app.vault.on('delete', () => void this.handleVaultStructureChange()));
		this.registerEvent(this.app.vault.on('rename', () => void this.handleVaultStructureChange()));
		this.registerEvent(this.app.metadataCache.on('changed', () => {
			if (this.settings.colorMode === 'frontmatter') this.decorations.refresh();
		}));
	}

	onunload(): void {
		this.navigation.uninstall();
		this.decorations.cleanup();
	}

	async loadSettings(): Promise<void> {
		const saved = (await this.loadData()) as Partial<ScopeTabsSettings> | null;
		this.settings = Object.assign(structuredClone(DEFAULT_SETTINGS), saved ?? {});
		this.settings.manualColors = { ...DEFAULT_SETTINGS.manualColors, ...(saved?.manualColors ?? {}) };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async refreshColorConfiguration(notify: boolean): Promise<void> {
		if (!this.scopeResolver.hasMultipleBooks()) {
			this.decorations.refresh();
			return;
		}
		const books = this.scopeResolver.listBooks();
		await this.colors.ensureManualColors(books);
		if (this.settings.colorMode === 'frontmatter') await this.colors.ensureFrontmatterColors(books);
		this.decorations.refresh();
		if (notify) await this.maybeNotifyMissingConfigFiles();
	}

	openMissingConfigManager(): void {
		if (!this.scopeResolver.hasMultipleBooks()) {
			new Notice('Scope Tabs is inactive because this vault has fewer than two first-level folders.');
			return;
		}
		const books = this.scopeResolver.listBooks();
		new MissingConfigModal(this.app, this, this.colors.getMissingConfigBooks(books)).open();
	}

	private async maybeNotifyMissingConfigFiles(): Promise<void> {
		if (this.settings.colorMode !== 'frontmatter' || !this.settings.notifyMissingConfigFiles) return;
		const missing = this.colors.getMissingConfigBooks(this.scopeResolver.listBooks());
		if (missing.length === 0) return;
		new Notice(`Scope Tabs: ${missing.length} book${missing.length === 1 ? '' : 's'} missing ${this.settings.configFileBaseName}.md. Run “Scope Tabs: Manage missing book config notes” to create them, or disable notifications in settings.`, 9000);
	}

	private async handleVaultStructureChange(): Promise<void> {
		await this.refreshColorConfiguration(false);
	}
}
