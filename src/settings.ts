import { App, Modal, Notice, PluginSettingTab, Setting } from 'obsidian';
import type ScopeTabsPlugin from './main';
import { DEFAULT_SETTINGS, sanitizeConfigBaseName, sanitizeFrontmatterProperty } from './settings-model';
import { isHexColor } from './colors';
import type { BookScope, ColorMode } from './types';

export class ScopeTabsSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly scopeTabs: ScopeTabsPlugin) {
		super(app, scopeTabs);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		new Setting(containerEl).setName('Scope Tabs').setHeading();
		containerEl.createEl('p', {
			text: 'Each first-level folder is a book. Scope Tabs keeps navigation inside a book tab group and creates or reuses another group when navigation crosses book boundaries.',
		});

		this.renderNavigation(containerEl);
		this.renderColors(containerEl);
		this.renderDecorations(containerEl);
		this.renderMaintenance(containerEl);
	}

	private renderNavigation(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Navigation').setHeading();
		new Setting(containerEl)
			.setName('New book position')
			.setDesc('Where a newly encountered book group is created relative to the current group.')
			.addDropdown((dropdown) => dropdown
				.addOptions({ right: 'Right', left: 'Left', down: 'Down', up: 'Up', spiral: 'Spiral' })
				.setValue(this.scopeTabs.settings.bookSplitDirection)
				.onChange(async (value: string) => {
					this.scopeTabs.settings.bookSplitDirection = value as typeof this.scopeTabs.settings.bookSplitDirection;
					await this.scopeTabs.saveSettings();
				}));

		new Setting(containerEl)
			.setName('New tab position')
			.setDesc('Place new notes in the current book to the right or left of the current tab. Left placement is a compatibility-assisted operation because Obsidian has no public tab-reorder API.')
			.addDropdown((dropdown) => dropdown
				.addOptions({ right: 'Right', left: 'Left' })
				.setValue(this.scopeTabs.settings.tabInsertDirection)
				.onChange(async (value: string) => {
					this.scopeTabs.settings.tabInsertDirection = value as 'left' | 'right';
					await this.scopeTabs.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Focus newly opened tabs')
			.setDesc('When disabled, same-book navigation opens a tab but leaves focus on the current note. Cross-book navigation still focuses the destination book.')
			.addToggle((toggle) => toggle
				.setValue(this.scopeTabs.settings.focusNewTabs)
				.onChange(async (value: boolean) => {
					this.scopeTabs.settings.focusNewTabs = value;
					await this.scopeTabs.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Open new books in external windows')
			.setDesc('Use Obsidian desktop pop-out windows instead of splits when a book is first opened.')
			.addToggle((toggle) => toggle
				.setValue(this.scopeTabs.settings.openBooksInExternalWindows)
				.onChange(async (value: boolean) => {
					this.scopeTabs.settings.openBooksInExternalWindows = value;
					await this.scopeTabs.saveSettings();
				}));
	}

	private renderColors(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Book colors').setHeading();
		const mode = new Setting(containerEl)
			.setName('Color source')
			.setDesc('Manual colors and frontmatter colors are mutually exclusive.');
		this.addRadio(mode.controlEl, 'manual', 'Manual', this.scopeTabs.settings.colorMode);
		this.addRadio(mode.controlEl, 'frontmatter', 'Frontmatter', this.scopeTabs.settings.colorMode);

		if (this.scopeTabs.settings.colorMode === 'manual') {
			this.renderManualColors(containerEl);
		} else {
			this.renderFrontmatterColors(containerEl);
		}
	}

	private addRadio(container: HTMLElement, value: ColorMode, labelText: string, current: ColorMode): void {
		const label = container.createEl('label', { cls: 'scope-tabs-radio-label' });
		const input = label.createEl('input', { type: 'radio' });
		input.name = 'scope-tabs-color-mode';
		input.value = value;
		input.checked = current === value;
		label.appendText(labelText);
		input.addEventListener('change', async () => {
			if (!input.checked) return;
			this.scopeTabs.settings.colorMode = value;
			await this.scopeTabs.saveSettings();
			await this.scopeTabs.refreshColorConfiguration(true);
			this.display();
		});
	}

	private renderManualColors(containerEl: HTMLElement): void {
		const books = this.scopeTabs.scopeResolver.listBooks();
		containerEl.createEl('p', { cls: 'setting-item-description', text: 'First-level folders are detected automatically.' });
		for (const book of books) {
			const row = new Setting(containerEl).setName(book.name);
			const color = this.scopeTabs.settings.manualColors[book.id];
			const colorInput = row.controlEl.createEl('input', { type: 'color' });
			colorInput.value = color;
			const hexInput = row.controlEl.createEl('input', { type: 'text', cls: 'scope-tabs-hex-input' });
			hexInput.value = color;
			hexInput.placeholder = '#RRGGBB';
			const commit = async (value: string) => {
				if (!isHexColor(value)) return;
				this.scopeTabs.settings.manualColors[book.id] = value.toLowerCase();
				colorInput.value = value;
				hexInput.value = value.toLowerCase();
				await this.scopeTabs.saveSettings();
				this.scopeTabs.decorations.refresh();
			};
			colorInput.addEventListener('input', () => void commit(colorInput.value));
			hexInput.addEventListener('change', () => {
				if (!isHexColor(hexInput.value)) {
					new Notice('Scope Tabs colors must use #RRGGBB format.');
					hexInput.value = this.scopeTabs.settings.manualColors[book.id];
					return;
				}
				void commit(hexInput.value);
			});
		}
	}

	private renderFrontmatterColors(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName('Book config note')
			.setDesc('Markdown filename to look for inside every first-level folder. Enter the name without .md.')
			.addText((text) => text
				.setValue(this.scopeTabs.settings.configFileBaseName)
				.setPlaceholder('index')
				.onChange(async (value: string) => {
					this.scopeTabs.settings.configFileBaseName = sanitizeConfigBaseName(value);
					await this.scopeTabs.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Color frontmatter property')
			.setDesc('The property value must be a #RRGGBB color. Missing or invalid values are added automatically.')
			.addText((text) => text
				.setValue(this.scopeTabs.settings.colorFrontmatterProperty)
				.setPlaceholder('color')
				.onChange(async (value: string) => {
					this.scopeTabs.settings.colorFrontmatterProperty = sanitizeFrontmatterProperty(value);
					await this.scopeTabs.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Notify about missing config notes')
			.setDesc('Disable this to never receive startup notifications about missing per-book config notes.')
			.addToggle((toggle) => toggle
				.setValue(this.scopeTabs.settings.notifyMissingConfigFiles)
				.onChange(async (value: boolean) => {
					this.scopeTabs.settings.notifyMissingConfigFiles = value;
					await this.scopeTabs.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Manage missing config notes')
			.setDesc('Choose individual books or create all missing config notes at once.')
			.addButton((button) => button.setButtonText('Open manager').onClick(() => this.scopeTabs.openMissingConfigManager()));
	}

	private renderDecorations(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Decorations').setHeading();
		new Setting(containerEl)
			.setName('Show book name above notes')
			.setDesc('Shows the first-level folder name as subtle colored text before note content.')
			.addToggle((toggle) => toggle.setValue(this.scopeTabs.settings.showBookLabel).onChange(async (value: boolean) => {
				this.scopeTabs.settings.showBookLabel = value;
				await this.scopeTabs.saveSettings();
				this.scopeTabs.decorations.refresh();
			}));

		new Setting(containerEl)
			.setName('Color tabs')
			.addToggle((toggle) => toggle.setValue(this.scopeTabs.settings.colorTabs).onChange(async (value: boolean) => {
				this.scopeTabs.settings.colorTabs = value;
				await this.scopeTabs.saveSettings();
				this.scopeTabs.decorations.refresh();
			}));
		if (this.scopeTabs.settings.colorTabs) {
			new Setting(containerEl)
				.setName('Tab color style')
				.addDropdown((dropdown) => dropdown
					.addOptions({ underline: 'Underline', background: 'Background', dot: 'Colored dot', custom: 'Custom CSS' })
					.setValue(this.scopeTabs.settings.tabDecorationStyle)
					.onChange(async (value: string) => {
						this.scopeTabs.settings.tabDecorationStyle = value as typeof this.scopeTabs.settings.tabDecorationStyle;
						await this.scopeTabs.saveSettings();
						this.display();
						this.scopeTabs.decorations.refresh();
					}));
			if (this.scopeTabs.settings.tabDecorationStyle === 'custom') this.renderCssField(containerEl, 'Custom tab CSS', 'tabCustomCss');
		}

		new Setting(containerEl)
			.setName('Color file explorer book')
			.setDesc('Only the first-level folder containing the currently selected note is decorated.')
			.addToggle((toggle) => toggle.setValue(this.scopeTabs.settings.colorExplorer).onChange(async (value: boolean) => {
				this.scopeTabs.settings.colorExplorer = value;
				await this.scopeTabs.saveSettings();
				this.scopeTabs.decorations.refresh();
			}));
		if (this.scopeTabs.settings.colorExplorer) {
			new Setting(containerEl)
				.setName('Explorer color style')
				.addDropdown((dropdown) => dropdown
					.addOptions({ edge: 'Left edge', underline: 'Underline folder', bar: 'Full folder vertical bar', custom: 'Custom CSS' })
					.setValue(this.scopeTabs.settings.explorerDecorationStyle)
					.onChange(async (value: string) => {
						this.scopeTabs.settings.explorerDecorationStyle = value as typeof this.scopeTabs.settings.explorerDecorationStyle;
						await this.scopeTabs.saveSettings();
						this.display();
						this.scopeTabs.decorations.refresh();
					}));
			if (this.scopeTabs.settings.explorerDecorationStyle === 'custom') this.renderCssField(containerEl, 'Custom explorer CSS', 'explorerCustomCss');
		}
	}

	private renderCssField(containerEl: HTMLElement, name: string, key: 'tabCustomCss' | 'explorerCustomCss'): void {
		new Setting(containerEl)
			.setName(name)
			.setDesc('Use --scope-tabs-book-color and [data-scope-tabs-book] in your rules. CSS is stored in plugin settings and injected locally into Obsidian windows.')
			.addTextArea((area) => {
				area.setValue(this.scopeTabs.settings[key]);
				area.inputEl.rows = 8;
				area.inputEl.addClass('scope-tabs-css-field');
				area.onChange(async (value: string) => {
					this.scopeTabs.settings[key] = value;
					await this.scopeTabs.saveSettings();
					this.scopeTabs.decorations.refresh();
				});
			});
	}

	private renderMaintenance(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Maintenance').setHeading();
		new Setting(containerEl)
			.setName('Reset settings')
			.setDesc('Restore all Scope Tabs settings to their defaults. Detected folder colors are regenerated afterward.')
			.addButton((button) => button.setWarning().setButtonText('Reset to defaults').onClick(async () => {
				this.scopeTabs.settings = structuredClone(DEFAULT_SETTINGS);
				await this.scopeTabs.saveSettings();
				await this.scopeTabs.refreshColorConfiguration(false);
				this.display();
			}));
	}
}

export class MissingConfigModal extends Modal {
	private selected = new Set<string>();

	constructor(app: App, private readonly plugin: ScopeTabsPlugin, private readonly books: BookScope[]) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.empty();
		this.contentEl.createEl('h2', { text: 'Missing Scope Tabs book config notes' });
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
		const selectedButton = buttons.createEl('button', { text: 'Create selected' });
		selectedButton.addEventListener('click', async () => {
			const selectedBooks = this.books.filter((book) => this.selected.has(book.id));
			if (selectedBooks.length === 0) return;
			await this.plugin.colors.createConfigFiles(selectedBooks);
			await this.plugin.refreshColorConfiguration(false);
			this.close();
		});
		const allButton = buttons.createEl('button', { text: 'Create all' });
		allButton.addEventListener('click', async () => {
			await this.plugin.colors.createConfigFiles(this.books);
			await this.plugin.refreshColorConfiguration(false);
			this.close();
		});
		const neverButton = buttons.createEl('button', { text: 'Never notify me' });
		neverButton.addEventListener('click', async () => {
			this.plugin.settings.notifyMissingConfigFiles = false;
			await this.plugin.saveSettings();
			this.close();
		});
	}
}
