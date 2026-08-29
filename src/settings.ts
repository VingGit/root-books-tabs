import { App, DropdownComponent, Modal, Notice, PluginSettingTab, Setting, setIcon, type SettingDefinitionItem, type SliderComponent, type TextComponent } from 'obsidian';
import { isHexColor, isManualTabTextColor } from './colors';
import type ScopeTabsPlugin from './main';
import { DEFAULT_SETTINGS, sanitizeConfigBaseName, sanitizeFrontmatterProperty, sanitizeTabTextFrontmatterProperty } from './settings-model';
import type { BookNoteOpenMode, BookScope, ColorMode, FileExplorerOpenBehavior, MainBookSwitchBehavior, ManualTabTextColor } from './types';

export class ScopeTabsSettingTab extends PluginSettingTab {
	private manualSection: HTMLElement | null = null;
	private frontmatterSection: HTMLElement | null = null;
	private tabOptionsSection: HTMLElement | null = null;
	private customCssSection: HTMLElement | null = null;
	private backgroundTextButton: HTMLElement | null = null;
	private gridOverflowControl: HTMLElement | null = null;
	private gridDimensionsSection: HTMLElement | null = null;

	constructor(app: App, private readonly scopeTabs: ScopeTabsPlugin) {
		super(app, scopeTabs);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [{
			name: 'Root Books Tabs settings',
			desc: 'Book mode, navigation, book colors, tab styles, creation locations, and maintenance.',
			aliases: ['Grid', 'Background text', 'pop-out', 'new note', 'new folder'],
			render: (setting) => {
				setting.settingEl.empty();
				setting.settingEl.addClass('scope-tabs-settings-root');
				this.renderSettings(setting.settingEl);
			},
		}];
	}

	private renderSettings(containerEl: HTMLElement): void {
		containerEl.empty();
		containerEl.createEl('p', {
			text: 'Each first-level folder is a book. Root books tabs provides a focused explorer and keeps each book in one managed tab group or pop-out.',
		});
		this.renderBookMode(containerEl);
		this.renderNavigation(containerEl);
		this.renderColors(containerEl);
		this.renderDecorations(containerEl);
		this.renderMaintenance(containerEl);
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
		let startupNoteDropdown: DropdownComponent;
		new Setting(containerEl)
			.setName('Default startup book')
			.setDesc('Open this book only when Obsidian restored no content tabs or pop-outs. Existing workspace history always wins.')
			.addDropdown((dropdown) => {
				dropdown.addOption('', 'No startup default');
				for (const book of this.scopeTabs.scopeResolver.listBooks()) dropdown.addOption(book.id, book.name);
				dropdown
					.setValue(this.scopeTabs.settings.defaultStartupBookId ?? '')
					.onChange(async (value) => {
						this.scopeTabs.settings.defaultStartupBookId = value || null;
						this.scopeTabs.settings.defaultStartupNotePath = null;
						this.populateStartupNoteDropdown(startupNoteDropdown, value || null);
						await this.scopeTabs.saveSettings();
					});
			});
		new Setting(containerEl)
			.setName('Default startup note')
			.setDesc('Choose a note in the startup book, or use its normal entry note. The saved value is a vault-relative path for optional programmatic setup.')
			.addDropdown((dropdown) => {
				startupNoteDropdown = dropdown;
				this.populateStartupNoteDropdown(dropdown, this.scopeTabs.settings.defaultStartupBookId);
				dropdown.onChange(async (value) => {
					this.scopeTabs.settings.defaultStartupNotePath = value || null;
					await this.scopeTabs.saveSettings();
				});
			});
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
			.setDesc('Cardinal placement or a configurable clockwise grid with per-cell overflow.')
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
			.setDesc('Append newly opened files at the right edge of the book group, or place them immediately left of the current tab. Ordering uses a feature-detected compatibility adapter.')
			.addDropdown((dropdown) => dropdown
				.addOptions({ right: 'Right edge', left: 'Left of current' })
				.setValue(this.scopeTabs.settings.tabInsertDirection)
				.onChange(async (value: string) => {
					this.scopeTabs.settings.tabInsertDirection = value as 'left' | 'right';
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
				await this.scopeTabs.saveSettings();
			}));
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
			void this.scopeTabs.saveSettings();
		});
	}

	private populateStartupNoteDropdown(dropdown: DropdownComponent, bookId: string | null): void {
		dropdown.selectEl.empty();
		dropdown.addOption('', 'Use the book entry note');
		const book = this.scopeTabs.scopeResolver.listBooks().find((candidate) => candidate.id === bookId);
		if (book) {
			const prefix = `${book.folderPath}/`;
			const files = this.app.vault.getMarkdownFiles()
				.filter((file) => this.scopeTabs.scopeResolver.resolveFile(file)?.id === book.id)
				.sort((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: 'base' }));
			for (const file of files) {
				const label = file.path.startsWith(prefix) ? file.path.slice(prefix.length).replace(/\.md$/i, '') : file.basename;
				dropdown.addOption(file.path, label);
			}
		}
		dropdown.setDisabled(!book);
		const configured = this.scopeTabs.settings.defaultStartupNotePath;
		const valid = book && configured && this.scopeTabs.scopeResolver.resolveFile(this.app.vault.getFileByPath(configured))?.id === book.id;
		dropdown.setValue(valid ? configured : '');
	}

	private renderGridDimension(containerEl: HTMLElement, name: string, key: 'gridRows' | 'gridColumns'): void {
		let slider: SliderComponent;
		let number: TextComponent;
		const commit = async (value: number) => {
			const normalized = Math.min(16, Math.max(2, Math.round(value)));
			this.scopeTabs.settings[key] = normalized;
			slider.setValue(normalized);
			number.setValue(String(normalized));
			await this.scopeTabs.saveSettings();
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

	private renderColors(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Book colors').setHeading();
		const mode = new Setting(containerEl).setName('Color source').setDesc('Manual colors and frontmatter colors are mutually exclusive.');
		this.addRadio(mode.controlEl, 'manual', 'Manual', this.scopeTabs.settings.colorMode);
		this.addRadio(mode.controlEl, 'frontmatter', 'Frontmatter', this.scopeTabs.settings.colorMode);
		this.manualSection = containerEl.createDiv({ cls: 'scope-tabs-conditional-section' });
		this.renderManualColors(this.manualSection);
		this.frontmatterSection = containerEl.createDiv({ cls: 'scope-tabs-conditional-section' });
		this.renderFrontmatterColors(this.frontmatterSection);
	}

	private addRadio(container: HTMLElement, value: ColorMode, labelText: string, current: ColorMode): void {
		const label = container.createEl('label', { cls: 'scope-tabs-radio-label' });
		const input = label.createEl('input', { type: 'radio' });
		input.name = 'scope-tabs-color-mode';
		input.value = value;
		input.checked = current === value;
		label.appendText(labelText);
		input.addEventListener('change', () => {
			if (input.checked) void this.changeColorMode(value);
		});
	}

	private async changeColorMode(value: ColorMode): Promise<void> {
		this.scopeTabs.settings.colorMode = value;
		this.updateConditionalSections();
		await this.scopeTabs.saveSettings();
		await this.scopeTabs.refreshColorConfiguration(true);
	}

	private renderManualColors(containerEl: HTMLElement): void {
		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text: 'First-level folders are detected automatically. These controls set the book color; background-style text colors are configured under decorations.',
		});
		for (const book of this.scopeTabs.scopeResolver.listBooks()) {
			const row = new Setting(containerEl).setName(book.name);
			row.settingEl.addClass('scope-tabs-manual-color-row');
			const color = this.scopeTabs.settings.manualColors[book.id] ?? this.scopeTabs.colors.getColor(book);
			const colorInput = row.controlEl.createEl('input', { type: 'color' });
			colorInput.value = color;
			const hexInput = row.controlEl.createEl('input', { type: 'text', cls: 'scope-tabs-hex-input' });
			hexInput.value = color;
			hexInput.placeholder = '#123456';
			const commit = async (value: string) => {
				if (!isHexColor(value)) return;
				const normalized = value.toLowerCase();
				this.scopeTabs.settings.manualColors[book.id] = normalized;
				colorInput.value = normalized;
				hexInput.value = normalized;
				await this.scopeTabs.saveSettings();
				this.scopeTabs.decorations.refresh();
			};
			colorInput.addEventListener('input', () => void commit(colorInput.value));
			hexInput.addEventListener('change', () => {
				if (!isHexColor(hexInput.value)) {
					new Notice('Root books tabs colors must use #rrggbb format.');
					hexInput.value = this.scopeTabs.settings.manualColors[book.id] ?? this.scopeTabs.colors.getColor(book);
					return;
				}
				void commit(hexInput.value);
			});
		}
	}

	private renderFrontmatterColors(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName('Book config note')
			.setDesc('Markdown filename inside each first-level folder, without .md.')
			.addText((text) => text.setValue(this.scopeTabs.settings.configFileBaseName).setPlaceholder('Index').onChange(async (value: string) => {
				this.scopeTabs.settings.configFileBaseName = sanitizeConfigBaseName(value);
				await this.scopeTabs.saveSettings();
			}));
		new Setting(containerEl)
			.setName('Color frontmatter property')
			.setDesc('The value must be #rrggbb. Missing or invalid values are added automatically.')
			.addText((text) => text.setValue(this.scopeTabs.settings.colorFrontmatterProperty).setPlaceholder('Color').onChange(async (value: string) => {
				this.scopeTabs.settings.colorFrontmatterProperty = sanitizeFrontmatterProperty(value);
				await this.scopeTabs.saveSettings();
			}));
		new Setting(containerEl)
			.setName('Notify about missing config notes')
			.addToggle((toggle) => toggle.setValue(this.scopeTabs.settings.notifyMissingConfigFiles).onChange(async (value: boolean) => {
				this.scopeTabs.settings.notifyMissingConfigFiles = value;
				await this.scopeTabs.saveSettings();
			}));
		new Setting(containerEl)
			.setName('Manage missing config notes')
			.addButton((button) => button.setButtonText('Open manager').onClick(() => this.scopeTabs.openMissingConfigManager()));
	}

	private renderDecorations(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Decorations').setHeading();
		new Setting(containerEl)
			.setName('Show book name above notes')
			.setDesc('Markdown notes only; resource tabs still receive book color.')
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
		this.manualSection?.toggleClass('is-hidden', this.scopeTabs.settings.colorMode !== 'manual');
		this.frontmatterSection?.toggleClass('is-hidden', this.scopeTabs.settings.colorMode !== 'frontmatter');
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
				this.scopeTabs.settings = structuredClone(DEFAULT_SETTINGS);
				await this.scopeTabs.saveSettings();
				await this.scopeTabs.refreshColorConfiguration(false);
				this.update();
			}));
	}
}

class BookNoteOpeningOverridesModal extends Modal {
	private readonly draft: Record<string, BookNoteOpenMode>;

	constructor(app: App, private readonly plugin: ScopeTabsPlugin) {
		super(app);
		this.draft = { ...plugin.settings.bookNoteOpenModeOverrides };
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
		this.plugin.settings.bookNoteOpenModeOverrides = { ...this.draft };
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
			this.plugin.settings.tabTextFrontmatterProperty = sanitizeTabTextFrontmatterProperty(this.propertyDraft);
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

export class MissingConfigModal extends Modal {
	private selected = new Set<string>();

	constructor(app: App, private readonly plugin: ScopeTabsPlugin, private readonly books: BookScope[]) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.empty();
		this.contentEl.createEl('h2', { text: 'Missing root books tabs book config notes' });
		if (this.books.length === 0) {
			this.contentEl.createEl('p', { text: 'Every first-level folder already contains the configured book note.' });
			return;
		}
		this.contentEl.createEl('p', { text: 'Select books to create. Existing files are never overwritten; missing color frontmatter is added idempotently.' });
		for (const book of this.books) {
			const row = new Setting(this.contentEl).setName(book.name).setDesc(this.plugin.colors.getConfigPath(book));
			row.addToggle((toggle) => toggle.onChange((value: boolean) => {
				if (value) this.selected.add(book.id);
				else this.selected.delete(book.id);
			}));
		}
		const buttons = this.contentEl.createDiv({ cls: 'scope-tabs-modal-buttons' });
		buttons.createEl('button', { text: 'Create selected' }).addEventListener('click', () => void this.createSelected());
		buttons.createEl('button', { text: 'Create all' }).addEventListener('click', () => void this.createAll());
		buttons.createEl('button', { text: 'Never notify me' }).addEventListener('click', () => void this.disableNotifications());
	}

	private async createSelected(): Promise<void> {
		const selectedBooks = this.books.filter((book) => this.selected.has(book.id));
		if (selectedBooks.length === 0) return;
		await this.plugin.colors.createConfigFiles(selectedBooks);
		await this.plugin.refreshColorConfiguration(false);
		this.close();
	}

	private async createAll(): Promise<void> {
		await this.plugin.colors.createConfigFiles(this.books);
		await this.plugin.refreshColorConfiguration(false);
		this.close();
	}

	private async disableNotifications(): Promise<void> {
		this.plugin.settings.notifyMissingConfigFiles = false;
		await this.plugin.saveSettings();
		this.close();
	}
}
