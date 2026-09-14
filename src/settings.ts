import { App, FuzzySuggestModal, TAbstractFile, TFile, TFolder, DropdownComponent, Modal, Notice, PluginSettingTab, Setting, setIcon, type SettingDefinitionItem, type SliderComponent, type TextComponent } from 'obsidian';
import { isManualTabTextColor } from './colors';
import type ScopeTabsPlugin from './main';
import { DEFAULT_SETTINGS, sanitizeConfigBaseName, sanitizeFrontmatterProperty, sanitizeTabTextFrontmatterProperty } from './settings-model';
import type { FolderTemplateOverrides } from './templates';
import type { BookNoteOpenMode, FileExplorerOpenBehavior, MainBookSwitchBehavior, ManualTabTextColor } from './types';

export class ScopeTabsSettingTab extends PluginSettingTab {


	private tabOptionsSection: HTMLElement | null = null;
	private customCssSection: HTMLElement | null = null;
	private backgroundTextButton: HTMLElement | null = null;
	private gridOverflowControl: HTMLElement | null = null;
	private gridDimensionsSection: HTMLElement | null = null;
	private gridRefillTimer: number | null = null;

	constructor(app: App, private readonly scopeTabs: ScopeTabsPlugin) {
		super(app, scopeTabs);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const groups: [string, (container: HTMLElement) => void][] = [
			['Book mode', el => this.renderBookMode(el)], ['Navigation', el => this.renderNavigation(el)],
			['Ordering', el => this.renderOrdering(el)],
			['Per book config', el => this.renderColors(el)], ['Decorations', el => this.renderDecorations(el)],
			['Folder templates', el => this.renderTemplates(el)],
			['Hidden and excluded', el => this.renderHiddenAndExcluded(el)], ['Maintenance', el => this.renderMaintenance(el)],
		];
		return groups.map(([name, render]) => ({ type: 'group', heading: name, cls: 'scope-tabs-settings-section', items: [{ name, render: setting => {
			setting.settingEl.empty(); setting.settingEl.addClass('scope-tabs-settings-root'); render(setting.settingEl); this.updateConditionalSections();
		} }] }));
	}

	private renderSettings(containerEl: HTMLElement): void {
		containerEl.empty();
		containerEl.createEl('p', {
			text: 'Each first-level folder is a book. Root books tabs provides a focused explorer and keeps each book in one managed tab group or pop-out.',
		});
		this.renderBookMode(containerEl.createDiv({ cls: 'scope-tabs-settings-section' }));
		this.renderNavigation(containerEl.createDiv({ cls: 'scope-tabs-settings-section' }));
		this.renderOrdering(containerEl.createDiv({ cls: 'scope-tabs-settings-section' }));
		this.renderColors(containerEl.createDiv({ cls: 'scope-tabs-settings-section' }));
		this.renderTemplates(containerEl.createDiv({ cls: 'scope-tabs-settings-section' }));
		this.renderDecorations(containerEl.createDiv({ cls: 'scope-tabs-settings-section' }));
		this.renderMaintenance(containerEl.createDiv({ cls: 'scope-tabs-settings-section' }));
		this.renderHiddenAndExcluded(containerEl.createDiv({ cls: 'scope-tabs-settings-section' }));
		this.updateConditionalSections();
	}

	private renderBookMode(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Book mode').setHeading();
		new Setting(containerEl)
			.setName('Enable book mode')
			.setDesc('Show only the selected book contents in the file explorer. The explorer toolbar button and command change the same persistent setting.')
			.addToggle((toggle) => toggle.setValue(this.scopeTabs.settings.bookModeEnabled).onChange(async (value: boolean) => {
				this.scopeTabs.settings.bookModeEnabled = value;
				await this.scopeTabs.saveSettings();
				this.scopeTabs.decorations.refresh();
			}));
		new Setting(containerEl)
			.setName('Color book bars')
			.setDesc('Color the selected book bar, its selected dropdown entry, and temporary open-book subtree bars.')
			.addToggle((toggle) => toggle.setValue(this.scopeTabs.settings.colorBookSwitcher).onChange(async (value: boolean) => {
				this.scopeTabs.settings.colorBookSwitcher = value;
				await this.scopeTabs.saveSettings();
				this.scopeTabs.decorations.refresh();
			}));
		const mainBookSwitch = new Setting(containerEl)
			.setName('Switching the main book')
			.setDesc('Choose what happens to the previously selected book when the main book dropdown changes.');
		this.addMainBookSwitchRadio(mainBookSwitch.controlEl, 'close-previous', 'Close previous book');
		this.addMainBookSwitchRadio(mainBookSwitch.controlEl, 'keep-open', 'Keep previous book open');
	}

	private addMainBookSwitchRadio(container: HTMLElement, value: MainBookSwitchBehavior, labelText: string): void {
		const label = container.createEl('label', { cls: 'scope-tabs-radio-label' });
		const input = label.createEl('input', { type: 'radio' });
		input.name = 'scope-tabs-main-book-switch-behavior';
		input.value = value;
		input.checked = this.scopeTabs.settings.mainBookSwitchBehavior === value;
		label.appendText(labelText);
		input.addEventListener('change', () => {
			if (!input.checked) return;
			this.scopeTabs.settings.mainBookSwitchBehavior = value;
			void this.scopeTabs.saveSettings();
		});
	}

	private renderNavigation(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Navigation').setHeading();
		new Setting(containerEl).setName('Fresh clone opening path')
			.setDesc('Choose a book or note to open once on a fresh start. Stored in the vault root index.md.')
			.addButton(button => button.setButtonText('Choose path').onClick(() => new VaultPathModal(this.app, this.scopeTabs, async file => {
				await this.scopeTabs.vaultConfig.set('freshCloneOpeningPath', file.path);
				this.update();
			}, true).open()));
		new Setting(containerEl).setName('Opening path').setDesc(typeof this.scopeTabs.vaultConfig.values.freshCloneOpeningPath === 'string' ? this.scopeTabs.vaultConfig.values.freshCloneOpeningPath : 'Latest edited note if no workspace is saved');
		new Setting(containerEl).setName('Open the configured path next time')
			.setDesc('Arm the fresh-start switch in root index.md. It resets after the next startup.')
			.addToggle(toggle => toggle.setValue(this.scopeTabs.vaultConfig.values.isFreshClone === true).onChange(value => this.scopeTabs.vaultConfig.set('isFreshClone', value)));
		const fileExplorerOpening = new Setting(containerEl)
			.setName('File explorer note opening')
			.setDesc('Choose whether a file explorer note opens in the most recently opened matching book instance or in the currently focused book group.');
		this.addFileExplorerOpenRadio(fileExplorerOpening.controlEl, 'book-instance', 'Corresponding book instance');
		this.addFileExplorerOpenRadio(fileExplorerOpening.controlEl, 'current-group', 'Current book group');
		new Setting(containerEl)
			.setName('New note location')
			.setDesc('Create a note beside the focused note, or in the root of its book. Root-level and non-note creation keeps Obsidian’s normal behavior.')
			.addDropdown((dropdown) => dropdown
				.addOptions({ 'current-folder': 'Current note folder', 'book-root': 'Book root' })
				.setValue(this.scopeTabs.settings.newNoteLocation)
				.onChange(async (value: string) => {
					this.scopeTabs.settings.newNoteLocation = value as typeof this.scopeTabs.settings.newNoteLocation;
					await this.scopeTabs.saveSettings();
				}));
		new Setting(containerEl)
			.setName('New folder location')
			.setDesc('Create toolbar folders beside the focused note, or in the root of its book. An explicitly selected explorer folder is still respected.')
			.addDropdown((dropdown) => dropdown
				.addOptions({ 'current-folder': 'Current note folder', 'book-root': 'Book root' })
				.setValue(this.scopeTabs.settings.newFolderLocation)
				.onChange(async (value: string) => {
					this.scopeTabs.settings.newFolderLocation = value as typeof this.scopeTabs.settings.newFolderLocation;
					await this.scopeTabs.saveSettings();
				}));
		const bookPosition = new Setting(containerEl)
			.setName('New book position')
			.setDesc('Cardinal placement or a configurable row-by-row grid with per-cell overflow.')
			.addDropdown((dropdown) => {
				dropdown.selectEl.addClass('scope-tabs-book-position-select');
				dropdown
					.addOptions({ right: 'Right', left: 'Left', down: 'Down', up: 'Up', grid: 'Grid' })
					.setValue(this.scopeTabs.settings.bookSplitDirection)
					.onChange(async (value: string) => {
					this.scopeTabs.settings.bookSplitDirection = value as typeof this.scopeTabs.settings.bookSplitDirection;
					this.updateConditionalSections();
					await this.scopeTabs.saveSettings();
					});
			});
		this.gridOverflowControl = bookPosition.controlEl.createDiv({ cls: 'scope-tabs-grid-overflow' });
		this.gridOverflowControl.createSpan({ text: 'Overflow', attr: { title: 'Direction used when splitting each base cell after the configured grid is full' } });
		new DropdownComponent(this.gridOverflowControl)
			.addOptions({ right: 'Right', down: 'Down', left: 'Left', up: 'Up' })
			.setValue(this.scopeTabs.settings.gridOverflowDirection)
			.onChange(async (value: string) => {
				this.scopeTabs.settings.gridOverflowDirection = value as typeof this.scopeTabs.settings.gridOverflowDirection;
				await this.scopeTabs.saveSettings();
			});
		this.gridDimensionsSection = containerEl.createDiv({ cls: 'scope-tabs-conditional-section scope-tabs-grid-dimensions' });
		this.renderGridDimension(this.gridDimensionsSection, 'Grid rows', 'gridRows');
		this.renderGridDimension(this.gridDimensionsSection, 'Grid columns', 'gridColumns');
		new Setting(containerEl)
			.setName('New tab position')
			.setDesc('Open tabs immediately right of the current tab or at the end. Stored in root index.md; each book can override this.')
			.addDropdown((dropdown) => dropdown
				.addOptions({ right: 'To right of current one', end: 'Always at the end' })
				.setValue(this.scopeTabs.settings.tabInsertDirection)
				.onChange(async (value: string) => {
					this.scopeTabs.settings.tabInsertDirection = value as 'end' | 'right';
					await this.scopeTabs.vaultConfig.set('tabInsertDirection', value);
					await this.scopeTabs.saveSettings();
				}));
		new Setting(containerEl)
			.setName('Book note opening')
			.setDesc('Open same-book notes in the current tab, a background tab, or a focused new tab. Cross-book navigation still focuses its destination book.')
			.addDropdown((dropdown) => dropdown
				.addOptions({
					'same-tab': 'Same tab',
					'background-tab': 'New tab in background',
					'focused-tab': 'New tab and focus',
				})
				.setValue(this.scopeTabs.settings.bookNoteOpenMode)
				.onChange(async (value: string) => {
					this.scopeTabs.settings.bookNoteOpenMode = value as typeof this.scopeTabs.settings.bookNoteOpenMode;
					this.scopeTabs.navigation.resetBookHistories();
					await this.scopeTabs.saveSettings();
				}));
		new Setting(containerEl)
			.setName('Per-book note opening')
			.setDesc('Override the global note-opening mode for individual books. Books without an override follow the global setting above.')
			.addButton((button) => button
				.setButtonText('Configure')
				.onClick(() => new BookNoteOpeningOverridesModal(this.app, this.scopeTabs).open()));
		new Setting(containerEl)
			.setName('Open new books in pop-outs')
			.setDesc('Use an Obsidian desktop pop-out instead of a split when a book is first opened.')
			.addToggle((toggle) => toggle.setValue(this.scopeTabs.settings.openBooksInExternalWindows).onChange(async (value: boolean) => {
				this.scopeTabs.settings.openBooksInExternalWindows = value;
				await this.scopeTabs.vaultConfig.set('openBooksInExternalWindows', value);
				await this.scopeTabs.saveSettings();
			}));
		new Setting(containerEl)
			.setName('Keep internal links updated')
			.setDesc('Keep Obsidian’s automatic link updating enabled while this plugin is active. This is on after installation and reset.')
			.addToggle(toggle => toggle.setValue(this.scopeTabs.settings.forceUpdateLinks).onChange(async value => {
				this.scopeTabs.settings.forceUpdateLinks = value;
				await this.scopeTabs.vaultConfig.set('forceUpdateLinks', value);
				void this.scopeTabs.linkMaintenance.enforce();
			}));
	}

	private renderOrdering(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Ordering').setHeading();
		new Setting(containerEl)
			.setName('Default ordering direction')
			.setDesc('Descending keeps the newest items at the top for date sorting. The ordering-mode arrow changes this value.')
			.addDropdown(dropdown => dropdown
				.addOptions({ descending: 'Descending', ascending: 'Ascending' })
				.setValue(this.scopeTabs.settings.orderingDirection)
				.onChange(async value => {
					this.scopeTabs.settings.orderingDirection = value as typeof this.scopeTabs.settings.orderingDirection;
					await this.scopeTabs.vaultConfig.set('orderingDirection', value);
					this.scopeTabs.decorations.refresh();
				}));
		new Setting(containerEl)
			.setName('Config note position')
			.setDesc('Keep each folder’s config note outside manual file order and pin it at the top or bottom.')
			.addDropdown(dropdown => dropdown
				.addOptions({ top: 'Top', bottom: 'Bottom' })
				.setValue(this.scopeTabs.settings.configNotePosition)
				.onChange(async value => {
					this.scopeTabs.settings.configNotePosition = value as typeof this.scopeTabs.settings.configNotePosition;
					await this.scopeTabs.vaultConfig.set('configNotePosition', value);
					this.scopeTabs.decorations.refresh();
				}));
		if (this.scopeTabs.settings.indexMoveDecision !== 'ask') new Setting(containerEl)
			.setName('Remembered config-note move action')
			.setDesc('Clear the saved choice so the safety dialog appears again.')
			.addButton(button => button.setButtonText('Forget choice').onClick(async () => {
				this.scopeTabs.settings.indexMoveDecision = 'ask';
				await this.scopeTabs.saveSettings();
				this.update();
			}));
	}

	private renderTemplates(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Folder templates').setHeading();
		new Setting(containerEl).setName('Filename prefix').setDesc('Added to new matching files. Use {{date}} to insert the formatted creation date.')
			.addText(text => text.setValue(this.scopeTabs.settings.templateFilePrefix).onChange(async value => {
				this.scopeTabs.settings.templateFilePrefix = value;
				await this.scopeTabs.vaultConfig.set('templateFilePrefix', value);
			}));
		new Setting(containerEl).setName('Date format').setDesc('Moment-style date format. A time suffix is added when the date-only filename already exists.')
			.addText(text => text.setValue(this.scopeTabs.settings.templateFileDate).onChange(async value => {
				this.scopeTabs.settings.templateFileDate = value || DEFAULT_SETTINGS.templateFileDate;
				await this.scopeTabs.vaultConfig.set('templateFileDate', this.scopeTabs.settings.templateFileDate);
			}));
		new Setting(containerEl).setName('Template file').setDesc('Vault-relative file copied into a new matching file after it is named.')
			.addText(text => text.setValue(this.scopeTabs.settings.templateFilePath).onChange(async value => {
				this.scopeTabs.settings.templateFilePath = value.replace(/^\.\//, '');
				await this.scopeTabs.vaultConfig.set('templateFilePath', this.scopeTabs.settings.templateFilePath);
			}));
		new Setting(containerEl).setName('Applied file types').setDesc('An inclusion list for new files created in a folder. Listed extensions receive the folder template filename treatment (prefix and date) and copied template contents; unlisted file types are left unchanged. Enter extensions without dots, separated by commas (for example: md, canvas, PNG), or * for every extension. Matching is case-insensitive. Default: md.')
			.addText(text => text.setValue(this.scopeTabs.settings.templateFileAppliedTo).onChange(async value => {
				this.scopeTabs.settings.templateFileAppliedTo = value || 'md';
				await this.scopeTabs.vaultConfig.set('templateFileAppliedTo', this.scopeTabs.settings.templateFileAppliedTo);
			}));
		new Setting(containerEl).setName('Folder overrides')
			.setDesc('Manage optional per-folder values. Each field inherits independently from its nearest parent or the vault defaults.')
			.addButton(button => button.setButtonText('Manage overrides').onClick(() => new FolderTemplateOverridesModal(this.app, this.scopeTabs).open()));
	}

	private addFileExplorerOpenRadio(container: HTMLElement, value: FileExplorerOpenBehavior, labelText: string): void {
		const label = container.createEl('label', { cls: 'scope-tabs-radio-label' });
		const input = label.createEl('input', { type: 'radio' });
		input.name = 'scope-tabs-file-explorer-open-behavior';
		input.value = value;
		input.checked = this.scopeTabs.settings.fileExplorerOpenBehavior === value;
		label.appendText(labelText);
		input.addEventListener('change', () => {
			if (!input.checked) return;
			this.scopeTabs.settings.fileExplorerOpenBehavior = value;
			void this.scopeTabs.vaultConfig.set('fileExplorerOpenBehavior', value).then(() => this.scopeTabs.saveSettings());
		});
	}

	private renderGridDimension(containerEl: HTMLElement, name: string, key: 'gridRows' | 'gridColumns'): void {
		let slider: SliderComponent;
		let number: TextComponent;
		const commit = async (value: number) => {
			const normalized = Math.min(16, Math.max(2, Math.round(value)));
			const previous = this.scopeTabs.settings[key];
			this.scopeTabs.settings[key] = normalized;
			slider.setValue(normalized);
			number.setValue(String(normalized));
			await this.scopeTabs.saveSettings();
			if (normalized !== previous && this.scopeTabs.settings.bookSplitDirection === 'grid') this.scheduleGridRefill();
		};
		new Setting(containerEl)
			.setName(name)
			.setDesc('Choose 2–16. Drag the slider or type an exact whole number.')
			.addSlider((component) => {
				slider = component;
				component
					.setLimits(2, 16, 1)
					.setValue(this.scopeTabs.settings[key])
					.onChange((value) => void commit(value));
			})
			.addText((component) => {
				number = component;
				component.inputEl.type = 'number';
				component.inputEl.min = '2';
				component.inputEl.max = '16';
				component.inputEl.step = '1';
				component.inputEl.addClass('scope-tabs-grid-number');
				component.setValue(String(this.scopeTabs.settings[key]));
				component.inputEl.addEventListener('change', () => {
					const parsed = Number(component.getValue());
					if (Number.isFinite(parsed)) void commit(parsed);
					else component.setValue(String(this.scopeTabs.settings[key]));
				});
			});
	}

	private scheduleGridRefill(): void {
		const ownerWindow = this.containerEl.ownerDocument.defaultView ?? window;
		if (this.gridRefillTimer !== null) ownerWindow.clearTimeout(this.gridRefillTimer);
		this.gridRefillTimer = ownerWindow.setTimeout(() => {
			this.gridRefillTimer = null;
			void this.scopeTabs.navigation.sortAllTabsIntoBooks()
				.then(() => this.scopeTabs.decorations.refresh())
				.catch((error: unknown) => {
					console.error('Root Books Tabs could not refill the expanded Grid.', error);
					new Notice('The grid size was saved, but the open books could not be rearranged automatically.');
				});
		}, 250);
	}

	private renderColors(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Per book config').setHeading();
		const books = this.scopeTabs.scopeResolver.listBooks();
		const missing = this.scopeTabs.colors.getMissingConfigBooks(books);
		new Setting(containerEl).setName('Create a config note for new books')
			.addToggle(toggle => toggle.setValue(this.scopeTabs.vaultConfig.values.createBookIndex !== false).onChange(value => this.scopeTabs.vaultConfig.set('createBookIndex', value)))
			.addButton(button => button.setButtonText(missing.length ? 'Create missing' : 'Regenerate all').onClick(async () => {
				await this.scopeTabs.colors.createConfigFiles(missing.length ? missing : books);
				await this.scopeTabs.refreshColorConfiguration(false);
				this.update();
			}));
		new Setting(containerEl).setName('Hide new book config notes')
			.setDesc('Adds the exact new config path to .obsidianignore. Enable the ignore plugin for vault-wide hiding.')
			.addToggle(toggle => toggle.setValue(this.scopeTabs.vaultConfig.values.hideNewBookIndex === true).onChange(value => this.scopeTabs.vaultConfig.set('hideNewBookIndex', value)));
		new Setting(containerEl).setName('Automatic book colors').setDesc('Book frontmatter overrides automatic colors. Automatic colors stay local and survive resetting settings.')
			.addButton(button => button.setButtonText('Add color override').onClick(() => new ColorOverridesModal(this.app, this.scopeTabs).open()));
		this.renderFrontmatterColors(containerEl);
	}

	private renderFrontmatterColors(containerEl: HTMLElement): void {
		let base = this.scopeTabs.settings.configFileBaseName, key = this.scopeTabs.settings.colorFrontmatterProperty;
		new Setting(containerEl).setName('Book config note').setDesc('Filename without .md. Apply renames existing book and subfolder config notes.')
			.addText(text => text.setValue(base).onChange(value => { base = sanitizeConfigBaseName(value); }));
		new Setting(containerEl).setName('Color frontmatter property').setDesc('Apply renames existing color fields while preserving other properties.')
			.addText(text => text.setValue(key).onChange(value => { key = sanitizeFrontmatterProperty(value); }));
		new Setting(containerEl).addButton(button => button.setButtonText('Apply config names').onClick(async () => {
			try { await this.scopeTabs.colors.renameConfiguration(base, key); this.update(); }
			catch (error) { new Notice(error instanceof Error ? error.message : 'Could not rename configuration.'); }
		}));
		new Setting(containerEl)
			.setName('Notify about missing config notes')
			.addToggle((toggle) => toggle.setValue(this.scopeTabs.settings.notifyMissingConfigFiles).onChange(async (value: boolean) => {
				this.scopeTabs.settings.notifyMissingConfigFiles = value;
				await this.scopeTabs.saveSettings();
			}));
	}

	private renderDecorations(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Decorations').setHeading();
		new Setting(containerEl)
			.setName('Show book name above notes')
			.setDesc('Show the book name and navigation arrows above every supported Obsidian file view.')
			.addToggle((toggle) => toggle.setValue(this.scopeTabs.settings.showBookLabel).onChange(async (value: boolean) => {
				this.scopeTabs.settings.showBookLabel = value;
				await this.scopeTabs.saveSettings();
				this.scopeTabs.decorations.refresh();
			}));
		new Setting(containerEl)
			.setName('Color tabs')
			.addToggle((toggle) => toggle.setValue(this.scopeTabs.settings.colorTabs).onChange(async (value: boolean) => {
				this.scopeTabs.settings.colorTabs = value;
				this.updateConditionalSections();
				await this.scopeTabs.saveSettings();
				this.scopeTabs.decorations.refresh();
			}));
		this.tabOptionsSection = containerEl.createDiv({ cls: 'scope-tabs-conditional-section' });
		const tabStyle = new Setting(this.tabOptionsSection)
			.setName('Tab color style')
			.addDropdown((dropdown) => dropdown
				.addOptions({ underline: 'Underline', background: 'Background', dot: 'Colored dot', custom: 'Custom CSS' })
				.setValue(this.scopeTabs.settings.tabDecorationStyle)
				.onChange(async (value: string) => {
					this.scopeTabs.settings.tabDecorationStyle = value as typeof this.scopeTabs.settings.tabDecorationStyle;
					this.updateConditionalSections();
					await this.scopeTabs.saveSettings();
					this.scopeTabs.decorations.refresh();
				}));
		this.backgroundTextButton = tabStyle.controlEl.createEl('button', {
			cls: 'clickable-icon scope-tabs-background-text-button',
			attr: {
				type: 'button',
				'aria-label': 'Configure background tab text colors',
				title: 'Background tab text colors',
			},
		});
		setIcon(this.backgroundTextButton, 'contrast');
		this.backgroundTextButton.addEventListener('click', () => new BackgroundTabTextModal(this.app, this.scopeTabs).open());
		this.customCssSection = this.tabOptionsSection.createDiv({ cls: 'scope-tabs-conditional-section' });
		new Setting(this.customCssSection)
			.setName('Custom tab CSS')
			.setDesc('Edit CSS in a responsive preview modal. Apply saves; Cancel discards the draft.')
			.addButton((button) => button.setButtonText('Open CSS editor').onClick(() => new CustomTabCssModal(this.app, this.scopeTabs).open()));
	}

	private updateConditionalSections(): void {
		this.tabOptionsSection?.toggleClass('is-hidden', !this.scopeTabs.settings.colorTabs);
		this.customCssSection?.toggleClass('is-hidden', !this.scopeTabs.settings.colorTabs || this.scopeTabs.settings.tabDecorationStyle !== 'custom');
		this.backgroundTextButton?.toggleClass('is-hidden', !this.scopeTabs.settings.colorTabs || this.scopeTabs.settings.tabDecorationStyle !== 'background');
		const gridHidden = this.scopeTabs.settings.bookSplitDirection !== 'grid';
		this.gridOverflowControl?.toggleClass('is-hidden', gridHidden);
		this.gridDimensionsSection?.toggleClass('is-hidden', gridHidden);
	}

	private renderMaintenance(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Maintenance').setHeading();
		new Setting(containerEl)
			.setName('Reset settings')
			.setDesc('Restore all root books tabs settings to defaults. Runtime group ownership is retained.')
			.addButton((button) => button.setDestructive().setButtonText('Reset to defaults').onClick(async () => {
				try {
					await this.scopeTabs.colors.renameConfiguration(DEFAULT_SETTINGS.configFileBaseName, DEFAULT_SETTINGS.colorFrontmatterProperty, DEFAULT_SETTINGS.tabTextFrontmatterProperty);
				} catch (error) {
					new Notice(error instanceof Error ? error.message : 'Could not restore config names.');
					return;
				}
				const automaticColors = this.scopeTabs.settings.manualColors;
				this.scopeTabs.settings = structuredClone(DEFAULT_SETTINGS);
				this.scopeTabs.settings.manualColors = automaticColors;
				await this.scopeTabs.saveSettings();
				void this.scopeTabs.linkMaintenance.enforce();
				await this.scopeTabs.refreshColorConfiguration(false);
				this.update();
			}));
	}

	private renderHiddenAndExcluded(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Hidden and excluded').setHeading();
		new Setting(containerEl).setName('Hidden paths').setHeading();
		const description = containerEl.createEl('p', { cls: 'setting-item-description', text: 'Install the ignore community plugin for exclusions across Obsidian. ' });
		description.createEl('a', { text: 'Install ignore', href: 'https://community.obsidian.md/plugins/ignore' });
		new Setting(containerEl).setName('Hide a file or folder').setDesc('Literal vault-relative paths; selecting a folder includes its contents.')
			.addButton(button => button.setButtonText('Add hidden path').onClick(() => new VaultPathModal(this.app, this.scopeTabs, async file => {
				await this.scopeTabs.bookIgnore.add(file); this.update();
			}).open()));
		for (const entry of this.scopeTabs.bookIgnore.entries()) new Setting(containerEl).setName(entry.startsWith('/') ? `.${entry}` : entry)
			.addExtraButton(button => button.setIcon('x').setTooltip('Remove this exclusion').onClick(async () => { await this.scopeTabs.bookIgnore.remove(entry); this.update(); }));
		new Setting(containerEl).setName('Excluded first-level folders').setHeading();
		new Setting(containerEl).setName('Exclude a folder from books').setDesc('Excluded folders remain ordinary Obsidian folders and never receive generated config notes.')
			.addButton(button => button.setButtonText('Add excluded folder').onClick(() => new ExcludedFolderModal(this.app, this.scopeTabs).open()));
		new Setting(containerEl).setName('Excluded file group location')
			.setDesc('Open files from every excluded folder in one dedicated tab group, either beside the active tab group or in a pop-out window.')
			.addDropdown(dropdown => dropdown
				.addOptions({ 'next-to-current': 'Next to current tab group', popout: 'Pop-out window' })
				.setValue(this.scopeTabs.settings.excludedFileGroupLocation)
				.onChange(async value => {
					this.scopeTabs.settings.excludedFileGroupLocation = value as typeof this.scopeTabs.settings.excludedFileGroupLocation;
					await this.scopeTabs.vaultConfig.set('excludedFileGroupLocation', value);
				}));
		for (const path of this.scopeTabs.settings.excludedBookFolders) new Setting(containerEl).setName(path)
			.addExtraButton(button => button.setIcon('x').setTooltip('Include this folder in the book system').onClick(async () => {
				this.scopeTabs.settings.excludedBookFolders = this.scopeTabs.settings.excludedBookFolders.filter(value => value !== path);
				await this.scopeTabs.vaultConfig.set('excludedBookFolders', this.scopeTabs.settings.excludedBookFolders);
				await this.scopeTabs.handleScopeConfigurationChange();
				this.update();
			}));
	}
}

class ExcludedFolderModal extends FuzzySuggestModal<TFolder> {
	constructor(app: App, private readonly plugin: ScopeTabsPlugin) {
		super(app);
		this.setPlaceholder('Choose a first-level folder');
	}
	getItems(): TFolder[] {
		const excluded = new Set(this.plugin.settings.excludedBookFolders);
		return this.app.vault.getRoot().children.filter((entry): entry is TFolder => entry instanceof TFolder && !excluded.has(entry.path));
	}
	getItemText(folder: TFolder): string { return folder.name; }
	onChooseItem(folder: TFolder): void {
		void (async () => {
			this.plugin.settings.excludedBookFolders = [...new Set([...this.plugin.settings.excludedBookFolders, folder.path])];
			await this.plugin.vaultConfig.set('excludedBookFolders', this.plugin.settings.excludedBookFolders);
			await this.plugin.handleScopeConfigurationChange();
		})().catch(console.error);
	}
}

class FolderTemplateOverridesModal extends Modal {
	private selectedPath = '';
	constructor(app: App, private readonly plugin: ScopeTabsPlugin) { super(app); }
	onOpen(): void {
		this.selectedPath = this.plugin.templates.discoverFolderOverrides()[0]?.folder.path
			?? this.folders()[0]?.path
			?? '';
		this.render();
	}
	private folders(): TFolder[] {
		return this.app.vault.getAllLoadedFiles().filter((entry): entry is TFolder => entry instanceof TFolder && !entry.isRoot())
			.sort((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: 'base' }));
	}
	private render(): void {
		this.contentEl.empty();
		this.titleEl.setText('Folder template overrides');
		const folders = this.folders();
		if (!folders.length) {
			this.contentEl.createEl('p', { text: 'No book folders are available.' });
			return;
		}
		if (!folders.some(folder => folder.path === this.selectedPath)) this.selectedPath = folders[0]!.path;
		new Setting(this.contentEl).setName('Folder').addDropdown(dropdown => {
			for (const folder of folders) dropdown.addOption(folder.path, folder.path);
			dropdown.setValue(this.selectedPath).onChange(value => { this.selectedPath = value; this.render(); });
		});
		const folder = this.app.vault.getFolderByPath(this.selectedPath);
		if (!folder) return;
		const existing = this.plugin.templates.readFolderOverrides(folder);
		const draft: FolderTemplateOverrides = { ...existing };
		const add = (name: string, description: string, key: keyof FolderTemplateOverrides) => new Setting(this.contentEl)
			.setName(name).setDesc(description)
			.addText(text => text.setPlaceholder('Inherit').setValue(existing[key] ?? '').onChange(value => { draft[key] = value || undefined; }));
		add('Filename prefix', 'Optional. Use {{date}} for the configured date.', 'templateFilePrefix');
		add('Date format', 'Optional Moment-style date format.', 'templateFileDate');
		add('Template file', 'Optional vault-relative source path.', 'templateFilePath');
		add('Applied file types', 'Inclusion list for new files in this folder. Listed extensions receive the template filename treatment and contents; unlisted types are unchanged. Enter extensions without dots, separated by commas, or * for every extension. The default is md.', 'templateFileAppliedTo');
		new Setting(this.contentEl).setDesc('Blank values inherit independently from the nearest parent config or root defaults.')
			.addButton(button => button.setButtonText('Save overrides').setCta().onClick(async () => {
				await this.plugin.templates.writeFolderOverrides(folder, draft);
				this.render();
			}));
		const discovered = this.plugin.templates.discoverFolderOverrides();
		if (discovered.length) {
			new Setting(this.contentEl).setName('Folders with overrides').setHeading();
			for (const entry of discovered) new Setting(this.contentEl).setName(entry.folder.path)
				.setDesc(Object.entries(entry.overrides).map(([key, value]) => `${key}: ${value}`).join(' · '));
		}
	}
}

class ColorOverridesModal extends Modal {
	constructor(app: App, private readonly plugin: ScopeTabsPlugin) { super(app); }
	onOpen(): void { this.render(); }
	private render(): void {
		this.contentEl.empty(); this.titleEl.setText('Book color overrides');
		const books = this.plugin.scopeResolver.listBooks();
		let selected = books[0]?.id ?? '', color = '#5588cc', foreground = 'white';
		new Setting(this.contentEl).setName('Book').addDropdown(dropdown => {
			for (const book of books) dropdown.addOption(book.id, book.name);
			dropdown.setValue(selected).onChange(value => { selected = value; });
		});
		new Setting(this.contentEl).setName('Color').addColorPicker(picker => picker.setValue(color).onChange(value => { color = value; }));
		new Setting(this.contentEl).setName('Background tab text').setDesc('White, black, or a CSS hex color.')
			.addText(text => text.setValue(foreground).onChange(value => { foreground = value; }));
		new Setting(this.contentEl).addButton(button => button.setButtonText('Save override').setCta().onClick(async () => {
			const book = books.find(book => book.id === selected); if (!book) return;
			try { await this.plugin.colors.setOverride(book, color, foreground); window.setTimeout(() => this.render(), 150); }
			catch (error) { new Notice(error instanceof Error ? error.message : 'Enter a valid color and text color.'); }
		}));
		const box = this.contentEl.createDiv({ cls: 'scope-tabs-overrides-box' });
		for (const book of books.filter(book => this.plugin.colors.hasOverride(book))) new Setting(box).setName(book.name)
			.setDesc(`${this.plugin.colors.getColor(book)} / ${this.plugin.colors.getTabTextColor(book)}`)
			.addExtraButton(button => button.setIcon('x').setTooltip('Remove override and roll a new automatic color').onClick(async () => {
				await this.plugin.colors.removeOverride(book); window.setTimeout(() => this.render(), 150);
			}));
	}
}

class VaultPathModal extends FuzzySuggestModal<TAbstractFile> {
	constructor(app: App, private readonly plugin: ScopeTabsPlugin, private readonly choose: (file: TAbstractFile) => Promise<void>, private readonly opening = false) {
		super(app); this.setPlaceholder('Search vault paths');
	}
	getItems(): TAbstractFile[] {
		return this.app.vault.getAllLoadedFiles().filter(file => file.path && file.path !== '/' && (this.opening
			? file instanceof TFile && file.extension === 'md' || file instanceof TFolder && file.parent?.isRoot()
			: !this.plugin.bookIgnore.isHidden(file)));
	}
	getItemText(file: TAbstractFile): string { return `./${file.path}${file instanceof TFolder ? '/' : ''}`; }
	onChooseItem(file: TAbstractFile): void { void this.choose(file).catch((error: unknown) => { console.error(error); new Notice('Could not save the selected path.'); }); }
}

export class CreateBookModal extends Modal {
	constructor(app: App, private readonly plugin: ScopeTabsPlugin) { super(app); }
	onOpen(): void {
		this.titleEl.setText('Create a new book');
		let name = '';
		new Setting(this.contentEl).setName('Book name').addText(text => text.onChange(value => { name = value.trim(); }));
		new Setting(this.contentEl).addButton(button => button.setButtonText('Create book').setCta().onClick(async () => {
			if (!name || /[\\/:*?"<>|]/.test(name) || name === '.' || name === '..') { new Notice('Enter a valid first-level folder name.'); return; }
			button.setDisabled(true);
			try {
				const folder = await this.app.vault.createFolder(name);
				if (this.plugin.settings.excludedBookFolders.includes(folder.path)) {
					await this.plugin.handleScopeConfigurationChange();
					new Notice(`${folder.name} was created as an excluded folder.`);
					this.close();
					return;
				}
				if (this.plugin.vaultConfig.values.createBookIndex !== false) {
					const file = await this.plugin.bookOrder.ensureConfig(folder);
					if (this.plugin.vaultConfig.values.hideNewBookIndex === true) await this.plugin.bookIgnore.add(file);
				}
				this.plugin.settings.selectedBookId = folder.path;
				await this.plugin.saveSettings();
				this.plugin.decorations.refresh(); this.close();
			} catch (error) { console.error(error); new Notice('Could not create the book. Check whether its name already exists.'); button.setDisabled(false); }
		}));
	}
}

class BookNoteOpeningOverridesModal extends Modal {
	private readonly draft: Record<string, BookNoteOpenMode>;

	constructor(app: App, private readonly plugin: ScopeTabsPlugin) {
		super(app);
		this.draft = {};
		for (const book of plugin.scopeResolver.listBooks()) {
			const mode = plugin.navigation.getBookNoteOpenModeOverride(book);
			if (mode) this.draft[book.id] = mode;
		}
	}

	onOpen(): void {
		this.modalEl.addClass('scope-tabs-book-note-opening-modal');
		this.contentEl.empty();
		this.contentEl.createEl('h2', { text: 'Per-book note opening' });
		this.contentEl.createEl('p', {
			text: `The global mode is ${getBookNoteOpenModeLabel(this.plugin.settings.bookNoteOpenMode).toLowerCase()}. Choose “Use global” to keep a book in sync with it.`,
		});
		const rows = this.contentEl.createDiv({ cls: 'scope-tabs-book-note-opening-rows' });
		for (const book of this.plugin.scopeResolver.listBooks()) {
			new Setting(rows)
				.setName(book.name)
				.addDropdown((dropdown) => dropdown
					.addOptions({
						global: `Use global (${getBookNoteOpenModeLabel(this.plugin.settings.bookNoteOpenMode)})`,
						'same-tab': 'Same tab',
						'background-tab': 'New tab in background',
						'focused-tab': 'New tab and focus',
					})
					.setValue(this.draft[book.id] ?? 'global')
					.onChange((value) => {
						if (value === 'global') delete this.draft[book.id];
						else this.draft[book.id] = value as BookNoteOpenMode;
					}));
		}
		const buttons = this.contentEl.createDiv({ cls: 'scope-tabs-modal-buttons' });
		buttons.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
		buttons.createEl('button', { text: 'Apply', cls: 'mod-cta' }).addEventListener('click', () => void this.apply());
	}

	private async apply(): Promise<void> {
		for (const book of this.plugin.scopeResolver.listBooks()) await this.plugin.navigation.setBookNoteOpenMode(book, this.draft[book.id] ?? null);
		this.plugin.navigation.resetBookHistories();
		await this.plugin.saveSettings();
		this.close();
	}
}

function getBookNoteOpenModeLabel(mode: BookNoteOpenMode): string {
	if (mode === 'same-tab') return 'Same tab';
	if (mode === 'background-tab') return 'New tab in background';
	return 'New tab and focus';
}

class BackgroundTabTextModal extends Modal {
	private readonly manualDraft: Record<string, ManualTabTextColor>;
	private propertyDraft: string;

	constructor(app: App, private readonly plugin: ScopeTabsPlugin) {
		super(app);
		this.manualDraft = { ...plugin.settings.manualTabTextColors };
		this.propertyDraft = plugin.settings.tabTextFrontmatterProperty;
	}

	onOpen(): void {
		this.modalEl.addClass('scope-tabs-background-text-modal');
		this.contentEl.empty();
		this.contentEl.createEl('h2', { text: 'Background tab text' });
		this.contentEl.createEl('p', {
			text: 'These colors apply only to background-style tabs. Other tab styles keep Obsidian’s normal text color.',
		});
		if (this.plugin.settings.colorMode === 'manual') this.renderManualChoices();
		else this.renderFrontmatterProperty();

		const buttons = this.contentEl.createDiv({ cls: 'scope-tabs-modal-buttons' });
		buttons.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
		const apply = buttons.createEl('button', { text: 'Apply', cls: 'mod-cta' });
		apply.addEventListener('click', () => void this.apply());
	}

	private renderManualChoices(): void {
		this.contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: 'White is the default. Each compact button switches one book between white and black.',
		});
		const grid = this.contentEl.createDiv({ cls: 'scope-tabs-background-text-grid' });
		for (const book of this.plugin.scopeResolver.listBooks()) {
			const configured = this.manualDraft[book.id];
			let value: ManualTabTextColor = isManualTabTextColor(configured)
				? configured
				: '#ffffff';
			const button = grid.createEl('button', {
				cls: 'scope-tabs-background-text-choice',
				attr: { type: 'button' },
			});
			button.createSpan({ cls: 'scope-tabs-background-text-book', text: book.name });
			const valueEl = button.createSpan({ cls: 'scope-tabs-background-text-value' });
			const dot = valueEl.createSpan({ cls: 'scope-tabs-tab-text-dot' });
			const label = valueEl.createSpan();
			const refresh = () => {
				const name = value === '#000000' ? 'Black' : 'White';
				dot.style.background = value;
				label.setText(name);
				button.setAttr('aria-label', `${book.name}: ${name} Background tab text. Click to switch.`);
			};
			refresh();
			button.addEventListener('click', () => {
				value = value === '#000000' ? '#ffffff' : '#000000';
				this.manualDraft[book.id] = value;
				refresh();
			});
		}
	}

	private renderFrontmatterProperty(): void {
		new Setting(this.contentEl)
			.setName('Tab text frontmatter property')
			.setDesc('Accepts black, white, or any CSS hex color. Missing or invalid values resolve to white.')
			.addText((text) => text
				.setValue(this.propertyDraft)
				.setPlaceholder('Tab-text-bg')
				.onChange((value) => {
					this.propertyDraft = value;
				}));
	}

	private async apply(): Promise<void> {
		if (this.plugin.settings.colorMode === 'manual') {
			for (const book of this.plugin.scopeResolver.listBooks()) {
				this.plugin.settings.manualTabTextColors[book.id] = this.manualDraft[book.id] ?? '#ffffff';
			}
		} else {
			try {
				await this.plugin.colors.renameConfiguration(this.plugin.settings.configFileBaseName, this.plugin.settings.colorFrontmatterProperty, sanitizeTabTextFrontmatterProperty(this.propertyDraft));
			} catch (error) {
				new Notice(error instanceof Error ? error.message : 'Could not rename the tab text property.');
				return;
			}
		}
		await this.plugin.saveSettings();
		this.plugin.decorations.refresh();
		this.close();
	}
}

class CustomTabCssModal extends Modal {
	private draft: string;
	private previewSheet: CSSStyleSheet | null = null;

	constructor(app: App, private readonly plugin: ScopeTabsPlugin) {
		super(app);
		this.draft = plugin.settings.tabCustomCss;
	}

	onOpen(): void {
		this.modalEl.addClass('scope-tabs-css-modal');
		this.contentEl.empty();
		this.contentEl.createEl('h2', { text: 'Custom tab CSS' });
		this.contentEl.createEl('p', {
			text: 'Target .workspace-tab-header.scope-tabs-color-tab and use --scope-tabs-book-color. The preview is isolated from Obsidian and updates while you type.',
		});
		const layout = this.contentEl.createDiv({ cls: 'scope-tabs-css-editor-layout' });
		const editorColumn = layout.createDiv({ cls: 'scope-tabs-css-editor-column' });
		const area = editorColumn.createEl('textarea', { attr: { 'aria-label': 'Custom tab CSS' } });
		area.value = this.draft;
		const examples = editorColumn.createDiv({ cls: 'scope-tabs-css-examples' });
		examples.createEl('p', { text: 'Example: add a left border and brighten the active tab:' });
		examples.createEl('pre').createEl('code', { text: '.workspace-tab-header.scope-tabs-color-tab {\n  border-left: 3px solid var(--scope-tabs-book-color);\n}\n.workspace-tab-header.scope-tabs-color-tab.is-active {\n  filter: brightness(1.2);\n}' });
		const previewColumn = layout.createDiv({ cls: 'scope-tabs-css-preview-column' });
		previewColumn.createEl('h3', { text: 'Live preview' });
		const previewHost = previewColumn.createDiv({ cls: 'scope-tabs-css-preview-host' });
		const shadow = previewHost.attachShadow({ mode: 'open' });
		const preview = createDiv();
		preview.className = 'preview-workspace';
		const previewTabs = preview.createDiv({ cls: 'workspace-tab-header-container-inner' });
		this.createPreviewTab(previewTabs, 'Inactive page', false);
		this.createPreviewTab(previewTabs, 'Active page', true);
		shadow.appendChild(preview);
		const Sheet = shadow.ownerDocument.defaultView?.CSSStyleSheet;
		if (Sheet) {
			this.previewSheet = new Sheet();
			shadow.adoptedStyleSheets = [this.previewSheet];
			this.updatePreview();
		}
		area.addEventListener('input', () => {
			this.draft = area.value;
			this.updatePreview();
		});
		const buttons = this.contentEl.createDiv({ cls: 'scope-tabs-modal-buttons' });
		const cancel = buttons.createEl('button', { text: 'Cancel' });
		cancel.addEventListener('click', () => this.close());
		const apply = buttons.createEl('button', { text: 'Apply', cls: 'mod-cta' });
		apply.addEventListener('click', () => void this.apply());
	}

	onClose(): void {
		this.contentEl.empty();
		this.previewSheet = null;
	}

	private updatePreview(): void {
		try {
			this.previewSheet?.replaceSync(`${PREVIEW_BASE_CSS}\n${this.draft}`);
		} catch {
			this.previewSheet?.replaceSync(PREVIEW_BASE_CSS);
		}
	}

	private createPreviewTab(container: HTMLElement, title: string, active: boolean): void {
		const tab = container.createDiv({ cls: `workspace-tab-header scope-tabs-color-tab${active ? ' is-active' : ''}` });
		tab.setAttr('data-scope-tabs-book', 'example');
		tab.setCssProps({ '--scope-tabs-book-color': '#8465d6' });
		tab.createDiv({ cls: 'workspace-tab-header-inner' }).createSpan({ cls: 'workspace-tab-header-inner-title', text: title });
	}

	private async apply(): Promise<void> {
		this.plugin.settings.tabCustomCss = this.draft;
		await this.plugin.saveSettings();
		this.plugin.decorations.refresh();
		this.close();
	}
}

const PREVIEW_BASE_CSS = `
:host { display:block; padding:20px; color:#ddd; font:14px system-ui; background:#202020; min-height:100px; }
.workspace-tab-header-container-inner { display:flex; align-items:stretch; gap:4px; }
.workspace-tab-header { padding:10px 14px; border-radius:6px 6px 0 0; background:#303030; }
.workspace-tab-header.is-active { background:#454545; }
`;
