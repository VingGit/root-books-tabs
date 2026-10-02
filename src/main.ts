import { hasPluginFrontmatter, readPluginFrontmatter, updateConfigFrontmatter, writePluginFrontmatter } from './config-frontmatter';
import { Notice, Plugin, TFile, TFolder } from 'obsidian';
import { BookColorService } from './colors';
import { BookOrderService } from './book-order';
import { BookIgnoreService } from './ignore';
import { VaultConfigService } from './vault-config';
import { FrontmatterActions } from './frontmatter-actions';
import { DecorationController } from './decorations';
import { BookNavigationController } from './navigation';
import { NewNoteLocationController } from './new-note';
import { IndexMoveController } from './index-move';
import { LinkMaintenanceController } from './link-maintenance';
import { FolderTemplateService } from './templates';
import { ConfigNoteTitleService } from './config-note-titles';
import { ArticleNavigatorIntegration } from './article-navigator';
import { FrontmatterMaintenanceService } from './frontmatter-maintenance';
import { FirstLevelFolderScopeResolver } from './scope';
import { migrateRuntimeState, migrateSettings } from './settings-model';
import { ScopeTabsSettingTab } from './settings';
import type { ScopeTabsRuntimeStateV1, ScopeTabsSettings } from './types';

export default class ScopeTabsPlugin extends Plugin {
	settings!: ScopeTabsSettings;
	runtimeState!: ScopeTabsRuntimeStateV1;
	readonly scopeResolver = new FirstLevelFolderScopeResolver(this.app.vault, () => this.settings?.excludedBookFolders ?? ['templates']);
	readonly colors = new BookColorService(this);
	readonly bookOrder = new BookOrderService(this);
	readonly bookIgnore = new BookIgnoreService(this);
	readonly vaultConfig = new VaultConfigService(this);
	readonly frontmatterActions = new FrontmatterActions(this);
	readonly navigation = new BookNavigationController(this);
	readonly decorations = new DecorationController(this);
	readonly newNoteLocation = new NewNoteLocationController(this);
	readonly indexMoves = new IndexMoveController(this);
	readonly linkMaintenance = new LinkMaintenanceController(this);
	readonly templates = new FolderTemplateService(this);
	readonly configNoteTitles = new ConfigNoteTitleService(this);
	readonly articleNavigator = new ArticleNavigatorIntegration(this.app);
	readonly frontmatterMaintenance = new FrontmatterMaintenanceService(this);
	private unloading = false;
	private settingTab: ScopeTabsSettingTab | null = null;
	private saveQueue: Promise<void> = Promise.resolve();
	private legacyManual = false;
	private configurationMigrated = false;
	private portableConfigurationReady = false;
	private portableConfigurationTask: Promise<void> | null = null;
	private suggestedPluginSyncTask: Promise<void> | null = null;

	async onload(): Promise<void> {
		this.unloading = false;
		await this.loadSettings();
		this.frontmatterActions.install();
		this.indexMoves.install();
		this.settingTab = new ScopeTabsSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
		this.addCommand({
			id: 'toggle-book-mode',
			name: 'Toggle book mode',
			callback: () => this.decorations.toggleBookMode(),
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
		this.indexMoves.uninstall();
		this.decorations.cleanup();
		void this.frontmatterActions.hide();
	}

	async loadSettings(): Promise<void> {
		const saved = await this.loadData() as unknown;
		this.configurationMigrated = isRecord(saved) && saved.configurationMigratedV1 === true;
		this.legacyManual = isRecord(saved) && saved.colorMode === 'manual';
		this.settings = migrateSettings(saved);
		this.frontmatterMaintenance.paused = isRecord(saved) && isRecord(saved.frontmatterMaintenanceV1) && saved.frontmatterMaintenanceV1.paused === true;
		if (isRecord(saved) && isRecord(saved.automaticColorsV1)) {
			for (const [book, color] of Object.entries(saved.automaticColorsV1)) if (typeof color === 'string') this.settings.manualColors[book] = color;
		}
		this.runtimeState = migrateRuntimeState(isRecord(saved) ? saved.runtimeStateV1 : undefined);
	}

	async saveSettings(): Promise<void> {
		await this.vaultConfig.saveSettings();
		await this.persistState();
	}

	async saveRuntimeState(): Promise<void> {
		await this.persistState();
	}

	async settleFrontmatterWrites(): Promise<void> {
		await Promise.all([this.portableConfigurationTask, this.suggestedPluginSyncTask]);
		await Promise.all([this.bookOrder.whenIdle(), this.vaultConfig.whenIdle(), this.configNoteTitles.whenIdle()]);
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

	private async initializeWorkspace(): Promise<void> {
		if (this.unloading) return;
		await this.bookIgnore.load();
		this.registerInterval(window.setInterval(() => { void this.bookIgnore.load().then(changed => { if (changed) this.decorations.refresh(); }).catch(console.error); }, 3000));
		this.registerInterval(window.setInterval(() => { void this.syncSuggestedPluginKeys().catch(console.error); }, 3000));
		try {
			if (this.app.vault.getFileByPath('index.md')) await this.vaultConfig.load();
		} catch (error) { console.error(error); new Notice('Could not read portable book settings. Existing navigation will remain available.'); }
		let books = this.scopeResolver.listBooks();
		const restoredWorkspaceHistory = this.navigation.hasRestoredWorkspaceHistory();
		let startupFile: TFile | null = null;
		let startupResolved = false;
		try {
			if (books.length > 1) {
				await this.ensurePortableConfiguration();
				books = this.scopeResolver.listBooks();
				startupFile = await this.vaultConfig.startupFile(restoredWorkspaceHistory);
				startupResolved = true;
			}
		} catch (error) { console.error(error); new Notice('Could not read portable book settings. Existing navigation will remain available.'); }
		const defaultBook = this.scopeResolver.resolveFile(startupFile);
		const shouldOpenDefault = defaultBook !== null;
		const selectedBookId = shouldOpenDefault
			? defaultBook.id
			: books.some((book) => book.id === this.settings.selectedBookId)
				? this.settings.selectedBookId
				: books[0]?.id ?? null;
		if (books.length > 1 && this.settings.selectedBookId !== selectedBookId) {
			this.settings.selectedBookId = selectedBookId;
			await this.saveSettings();
		}
		if (this.unloading) return;
		this.navigation.install();
		this.newNoteLocation.install();
		void this.linkMaintenance.enforce();
		this.decorations.refresh();
		this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
			this.navigation.observeActiveLeaf(leaf);
			this.refreshWorkspaceState();
		}));
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
		this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
			if (file instanceof TFolder) this.decorations.addFolderNoteMenu(menu, file);
		}));
		this.registerEvent(this.app.workspace.on('quit', () => {
			this.navigation.prepareForQuit();
		}));
		this.registerEvent(this.app.vault.on('create', (file) => {
			void (async () => {
				if (file instanceof TFile && this.scopeResolver.hasMultipleBooks() && this.scopeResolver.resolveFile(file)) await this.templates.handleCreate(file);
				if (!this.frontmatterMaintenance.paused && file instanceof TFolder && file.parent?.isRoot() && this.scopeResolver.hasMultipleBooks() && this.scopeResolver.listBooks().some(book => book.id === file.path)) {
					const config = await this.bookOrder.ensureConfig(file);
					if (this.settings.indexTitleSync) await this.configNoteTitles.syncFile(config, this.settings.indexTitleProperty);
				}
				if (this.scopeResolver.hasMultipleBooks()) await this.bookOrder.syncStructure(file);
				await this.handleVaultStructureChange();
			})().catch(console.error);
		}));
		this.registerEvent(this.app.vault.on('delete', () => {
			void this.handleVaultStructureChange().catch(console.error);
		}));
		this.registerEvent(this.app.vault.on('rename', (file) => {
			void (this.scopeResolver.hasMultipleBooks() ? this.bookOrder.syncStructure(file) : Promise.resolve()).then(() => this.handleVaultStructureChange()).catch(console.error);
		}));
		this.registerEvent(this.app.metadataCache.on('changed', (file) => {
			if (!this.frontmatterMaintenance.paused && this.scopeResolver.hasMultipleBooks() && file.path === 'index.md') {
				const frontmatter: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter;
				const aliases = isRecord(frontmatter) ? frontmatter.aliases : undefined;
				if (!Array.isArray(aliases) || aliases.length !== 1 || aliases[0] !== this.app.vault.getName()) {
					new Notice('The vault config alias follows the vault name. Rename the vault instead.');
					void this.vaultConfig.ensureRoot().catch(console.error);
				}
			} else if (!this.frontmatterMaintenance.paused && this.scopeResolver.hasMultipleBooks() && !this.bookOrder.hasExpectedAlias(file)) {
				new Notice('Folder-note aliases follow their folder names. Rename the folder instead.');
			}
			this.bookOrder.refresh(file);
			this.templates.refresh(file);
			if (this.scopeResolver.hasMultipleBooks()) void this.bookOrder.syncConfig(file).catch(console.error);
			if (this.scopeResolver.hasMultipleBooks()) void this.bookOrder.syncCreationDate(file).catch(console.error);
			if (!this.frontmatterMaintenance.paused && this.scopeResolver.hasMultipleBooks() && this.settings.indexTitleSync && this.configNoteTitles.isManagedConfigNote(file)) {
				void this.configNoteTitles.syncFile(file, this.settings.indexTitleProperty).catch(console.error);
			}
			if (file.path === 'index.md') {
				void this.vaultConfig.load()
					.then(() => this.handleScopeConfigurationChange())
					.then(() => this.linkMaintenance.enforce())
					.catch(console.error);
			}
			if (file.name === `${this.settings.configFileBaseName}.md`) this.settingTab?.refreshForConfigChange();
			if (this.settings.colorMode === 'frontmatter') this.decorations.refresh();
		}));
		if (shouldOpenDefault) {
			this.navigation.setPrimaryBook(defaultBook.id);
			await this.navigation.activateBook(defaultBook, startupFile);
		}
		if (startupFile && !defaultBook) await this.app.workspace.getLeaf('tab').openFile(startupFile);
		if (startupResolved && this.vaultConfig.values.isFreshClone === true) await this.vaultConfig.set('isFreshClone', false);

		try {
			if (this.scopeResolver.hasMultipleBooks() && !this.frontmatterMaintenance.paused) {
				await this.bookOrder.refreshCreationDates();
				await this.syncSuggestedPluginKeys();
				if (this.settings.indexTitleSync) await this.configNoteTitles.reconcileAll(this.settings.indexTitleProperty);
			}
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
		new Notice(`Root Books Tabs: ${missing.length} book${missing.length === 1 ? '' : 's'} missing ${this.settings.configFileBaseName}.md. Use “Create missing” beside the new-book config setting, or disable notifications.`, 9000);
	}

	private async handleVaultStructureChange(): Promise<void> {
		try {
			if (this.scopeResolver.hasMultipleBooks()) {
				if (!this.app.vault.getFileByPath('index.md')) this.portableConfigurationReady = false;
				await this.ensurePortableConfiguration();
				await this.bookOrder.refreshCreationDates();
				await this.linkMaintenance.enforce();
			}
			await this.refreshColorConfiguration(false);
		} catch (error) {
			console.error('Root Books Tabs could not refresh after a vault structure change.', error);
		}
	}

	private ensurePortableConfiguration(): Promise<void> {
		if (this.frontmatterMaintenance.paused) return Promise.resolve();
		if (this.portableConfigurationReady) return Promise.resolve();
		if (this.portableConfigurationTask) return this.portableConfigurationTask;
		const operation = (async () => {
			await this.vaultConfig.ensureRoot();
			for (const book of this.scopeResolver.listBooks()) {
				const folder = this.app.vault.getFolderByPath(book.folderPath);
				if (folder) await this.bookOrder.ensureConfig(folder);
				await this.bookOrder.reconcileExistingConfigs(book);
			}
			await this.migrateBookConfiguration();
			this.portableConfigurationReady = true;
		})();
		this.portableConfigurationTask = operation;
		void operation.finally(() => {
			if (this.portableConfigurationTask === operation) this.portableConfigurationTask = null;
		}).catch(() => undefined);
		return operation;
	}

	async handleScopeConfigurationChange(): Promise<void> {
		const books = this.scopeResolver.listBooks();
		if (!books.some(book => book.id === this.settings.selectedBookId)) {
			this.settings.selectedBookId = books[0]?.id ?? null;
			if (this.settings.selectedBookId) this.navigation.setPrimaryBook(this.settings.selectedBookId);
			await this.persistState();
		}
		this.navigation.reconcileGroupRegistry();
		this.settingTab?.refreshForConfigChange();
		await this.refreshColorConfiguration(false);
	}

	private persistState(): Promise<void> {
		const snapshot = structuredClone({
			selectedBookId: this.settings.selectedBookId,
			tabCustomCss: this.settings.tabCustomCss,
			manualColors: this.settings.manualColors,
			manualTabTextColors: this.settings.manualTabTextColors,
			indexMoveDecision: this.settings.indexMoveDecision,
			frontmatterDisplayMode: this.settings.frontmatterDisplayMode,
			frontmatterMaintenanceV1: { paused: this.frontmatterMaintenance.paused },
			configurationMigratedV1: this.configurationMigrated,
			automaticColorsV1: this.settings.manualColors,
			runtimeStateV1: this.runtimeState,
			...(!this.configurationMigrated ? {
				colorMode: this.legacyManual ? 'manual' : 'frontmatter',
				bookNoteOpenModeOverrides: this.settings.bookNoteOpenModeOverrides,
			} : {}),
		});
		const result = this.saveQueue.then(() => this.saveData(snapshot));
		this.saveQueue = result.catch(() => undefined);
		return result;
	}

	private async migrateBookConfiguration(): Promise<void> {
		if (this.configurationMigrated) return;
		for (const book of this.scopeResolver.listBooks()) {
			const mode = this.settings.bookNoteOpenModeOverrides[book.id];
			const color = this.legacyManual ? this.settings.manualColors[book.id] : undefined;
			if (!mode && !color) continue;
			const folder = this.app.vault.getFolderByPath(book.id);
			if (!folder) continue;
			const existing = this.app.vault.getFileByPath(this.colors.getConfigPath(book));
			const existingFrontmatter = existing ? this.app.metadataCache.getFileCache(existing)?.frontmatter : null;
			const hadMode = !!existingFrontmatter && readPluginFrontmatter(existingFrontmatter, 'bookNoteOpenMode') !== undefined;
			const file = await this.bookOrder.ensureConfig(folder);
			await updateConfigFrontmatter(this.app, file, (fm: Record<string, unknown>, context) => {
				if (mode && !hadMode) writePluginFrontmatter(fm, 'bookNoteOpenMode', mode, context.ownedPlainKeys);
				if (color && !hasPluginFrontmatter(fm, this.settings.colorFrontmatterProperty)) writePluginFrontmatter(fm, this.settings.colorFrontmatterProperty, color, context.ownedPlainKeys);
				if (color && !hasPluginFrontmatter(fm, this.settings.tabTextFrontmatterProperty)) writePluginFrontmatter(fm, this.settings.tabTextFrontmatterProperty, this.settings.manualTabTextColors[book.id] ?? 'white', context.ownedPlainKeys);
			}, { aliases: {
				[this.settings.colorFrontmatterProperty]: 'color',
				[this.settings.tabTextFrontmatterProperty]: 'tab-text-bg',
			} });
		}
		this.configurationMigrated = true;
		await this.persistState();
	}

	private refreshWorkspaceState(): void {
		if (this.unloading) return;
		this.navigation.reconcileGroupRegistry();
		this.decorations.refresh();
	}

	private syncSuggestedPluginKeys(): Promise<void> {
		if (this.unloading || !this.portableConfigurationReady || !this.scopeResolver.hasMultipleBooks() || !this.settings.indexTitleSync || !this.settings.indexTitleFollowPlugin) return Promise.resolve();
		if (this.suggestedPluginSyncTask) return this.suggestedPluginSyncTask;
		const operation = (async () => {
			const status = this.configNoteTitles.propertyPluginStatus();
			if (status.state !== 'connected' || status.propertyKey === this.settings.indexTitleProperty) return;
			const previous = this.settings.indexTitleProperty;
			this.settings.indexTitleProperty = status.propertyKey;
			await this.vaultConfig.set('indexTitleProperty', status.propertyKey);
			await this.configNoteTitles.reconcileAll(status.propertyKey, previous);
		})().finally(() => { if (this.suggestedPluginSyncTask === operation) this.suggestedPluginSyncTask = null; });
		this.suggestedPluginSyncTask = operation;
		return operation;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
