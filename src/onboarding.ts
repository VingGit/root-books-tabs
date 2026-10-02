import { App, Modal, Notice, Setting } from "obsidian";
import {
	applyRecommendedIntegrations,
	auditIntegrations,
	isCoreUniqueNoteCreatorEnabled,
	openCommunityPluginSettings,
} from "./integrations";

export class IntegrationOnboardingModal extends Modal {
	constructor(
		app: App,
		private readonly onDismissForSession: () => void,
		private readonly onConfigured: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		void this.render();
	}

	private async render(): Promise<void> {
		this.contentEl.empty();
		this.setTitle("Set up Root Books Workspace");
		this.contentEl.createEl("p", {
			text: "Root Books Workspace coordinates four independent community plugins. Review what each one contributes before applying the recommended settings.",
		});

		const audits = await auditIntegrations(this.app);
		for (const audit of audits) {
			const card = this.contentEl.createDiv({
				cls: "root-books-integration-card",
			});
			card.createEl("h3", { text: audit.name });
			card.createEl("p", { text: audit.purpose });
			const state = !audit.installed
				? "Missing — install it from Community plugins"
				: !audit.enabled
					? "Installed but disabled"
					: audit.configured
						? "Ready"
						: "Installed with recommended-setting differences";
			card.createEl("strong", { text: state });
			if (audit.issues.length > 0) {
				const list = card.createEl("ul");
				for (const issue of audit.issues)
					list.createEl("li", { text: issue });
			}
		}

		if (isCoreUniqueNoteCreatorEnabled(this.app)) {
			this.contentEl.createEl("p", {
				cls: "root-books-core-conflict",
				text: "Accept all also disables Obsidian's core Unique Note Creator so the workspace command and ribbon button have one owner.",
			});
		}

		const actions = new Setting(this.contentEl);
		actions.addButton((button) =>
			button
				.setButtonText("Accept all")
				.setCta()
				.onClick(async () => {
					try {
						const missing = await applyRecommendedIntegrations(
							this.app,
						);
						this.onConfigured();
						if (missing.length > 0) {
							new Notice(
								`Install the missing plugins, then reopen setup: ${missing.join(", ")}`,
								10_000,
							);
							openCommunityPluginSettings(this.app);
							await this.render();
							return;
						}
						new Notice(
							"Root Books Workspace integrations are ready.",
						);
						this.close();
					} catch (error) {
						new Notice(
							`Could not apply every recommendation: ${String(error)}`,
							10_000,
						);
					}
				}),
		);
		actions.addButton((button) =>
			button
				.setButtonText("Open Community plugins")
				.onClick(() => openCommunityPluginSettings(this.app)),
		);
		actions.addButton((button) =>
			button
				.setButtonText("Do not show again this session")
				.onClick(() => {
					this.onDismissForSession();
					this.close();
				}),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
