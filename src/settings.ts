import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import {
	auditIntegrations,
	applyRecommendedIntegrations,
	openCommunityPluginSettings,
} from "./integrations";
import { ECOSYSTEM_VERSION } from "./types";
import type { RootBooksWorkspaceSettings } from "./types";

export interface RootBooksSettingsHost {
	settings: RootBooksWorkspaceSettings;
	saveSettings(): Promise<void>;
	reopenSetup(): void;
	refreshDecorations(): void;
	openAppearancePicker(): void;
}

export class RootBooksWorkspaceSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly host: RootBooksSettingsHost,
	) {
		super(app, host as never);
	}

	display(): void {
		void this.render();
	}

	private async render(): Promise<void> {
		this.containerEl.empty();
		this.containerEl.createEl("h2", { text: "Root Books Workspace" });
		this.containerEl.createEl("p", {
			text: `Ecosystem version ${ECOSYSTEM_VERSION}. Companion plugins remain independent and are never installed automatically.`,
		});

		this.containerEl.createEl("h3", { text: "Integrations" });
		const audits = await auditIntegrations(this.app);
		for (const audit of audits) {
			const card = this.containerEl.createDiv({
				cls: "root-books-integration-card",
			});
			card.createEl("h4", { text: audit.name });
			card.createEl("p", { text: audit.purpose });
			card.createEl("strong", {
				text: !audit.installed
					? "Missing"
					: !audit.enabled
						? "Installed but disabled"
						: audit.configured
							? "Ready"
							: `${audit.issues.length} recommended setting${audit.issues.length === 1 ? "" : "s"} differ`,
			});
			if (audit.issues.length > 0) {
				const list = card.createEl("ul");
				for (const issue of audit.issues)
					list.createEl("li", { text: issue });
			}
		}

		new Setting(this.containerEl)
			.setName("Recommended integration setup")
			.setDesc(
				"Enables installed companions, applies the listed recommendations, and disables core Unique Note Creator.",
			)
			.addButton((button) =>
				button
					.setButtonText("Review setup")
					.setCta()
					.onClick(() => this.host.reopenSetup()),
			)
			.addButton((button) =>
				button.setButtonText("Apply now").onClick(async () => {
					const missing = await applyRecommendedIntegrations(
						this.app,
					);
					new Notice(
						missing.length > 0
							? `Applied installed integrations. Still missing: ${missing.join(", ")}`
							: "Recommended integration settings applied.",
						8_000,
					);
					await this.render();
				}),
			)
			.addButton((button) =>
				button
					.setButtonText("Community plugins")
					.onClick(() => openCommunityPluginSettings(this.app)),
			);

		this.containerEl.createEl("h3", { text: "Book appearance" });
		new Setting(this.containerEl)
			.setName("Color file tabs")
			.setDesc("Use each book's panel.accent as a passive tab marker.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.host.settings.colorTabs)
					.onChange(async (value) => {
						this.host.settings.colorTabs = value;
						await this.host.saveSettings();
						this.host.refreshDecorations();
					}),
			);
		new Setting(this.containerEl)
			.setName("Show book label on tabs")
			.setDesc(
				"Adds a small icon and book name to file-backed tab headers.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.host.settings.showBookLabel)
					.onChange(async (value) => {
						this.host.settings.showBookLabel = value;
						await this.host.saveSettings();
						this.host.refreshDecorations();
					}),
			);
		new Setting(this.containerEl)
			.setName("Edit book appearance")
			.setDesc(
				"Choose a first-level folder note, then edit its portable panel metadata.",
			)
			.addButton((button) =>
				button
					.setButtonText("Choose book")
					.onClick(() => this.host.openAppearancePicker()),
			);

		this.containerEl.createEl("h3", { text: "Unique notes" });
		new Setting(this.containerEl)
			.setName("Optional filename time format")
			.setDesc(
				"Appended to the root template-date-format for unique notes. Leave blank for date-only names with collision suffixes.",
			)
			.addText((text) =>
				text
					.setPlaceholder("HH.mm.ss")
					.setValue(this.host.settings.optionalFilenameTimeFormat)
					.onChange(async (value) => {
						this.host.settings.optionalFilenameTimeFormat =
							value.trim();
						await this.host.saveSettings();
					}),
			);
	}
}
