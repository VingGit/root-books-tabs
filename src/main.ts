import { Notice, Plugin } from "obsidian";
import { migrateLegacyBookMetadata } from "./book-metadata";
import { CreatedFromFilenameSync } from "./created-from-filename";
import { BookDecorations } from "./decorations";
import { FolderNoteTitleSync } from "./folder-note-titles";
import {
	auditIntegrations,
	isCoreUniqueNoteCreatorEnabled,
} from "./integrations";
import { NewNotePipeline } from "./new-note-pipeline";
import { IntegrationOnboardingModal } from "./onboarding";
import { RootBooksWorkspaceSettingTab } from "./settings";
import { SortingCoordinator } from "./sorting";
import { DEFAULT_SETTINGS } from "./types";
import type { RootBooksWorkspaceSettings } from "./types";
import { registerUniqueNoteAction } from "./unique-note";

export default class RootBooksWorkspacePlugin extends Plugin {
	settings: RootBooksWorkspaceSettings = { ...DEFAULT_SETTINGS };
	private initialized = false;
	private onboardingDismissed = false;
	private sorting: SortingCoordinator | null = null;
	private pipeline: NewNotePipeline | null = null;
	private folderTitles: FolderNoteTitleSync | null = null;
	private decorations: BookDecorations | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new RootBooksWorkspaceSettingTab(this.app, this));
		this.app.workspace.onLayoutReady(() => void this.initialize());
	}

	private async initialize(): Promise<void> {
		if (this.initialized) return;
		this.initialized = true;

		this.sorting = new SortingCoordinator(this);
		this.pipeline = new NewNotePipeline(this, this.sorting);
		this.folderTitles = new FolderNoteTitleSync(this);
		this.decorations = new BookDecorations(this, this.settings);
		registerUniqueNoteAction(this, this.settings, this.pipeline);

		await this.pipeline.start();
		await new CreatedFromFilenameSync(
			this,
			this.settings,
			() => this.saveSettings(),
			this.sorting,
		).start();
		this.folderTitles.start();
		this.decorations.start();

		if (this.settings.metadataMigrationVersion < 1) {
			const changed = await migrateLegacyBookMetadata(this.app);
			this.settings.metadataMigrationVersion = 1;
			await this.saveSettings();
			if (changed > 0)
				new Notice(
					`Converted portable panel metadata in ${changed} book note${changed === 1 ? "" : "s"}.`,
				);
			this.decorations.refresh();
		}

		await this.openSetupWhenNeeded();
	}

	private async openSetupWhenNeeded(): Promise<void> {
		if (this.onboardingDismissed) return;
		const audits = await auditIntegrations(this.app);
		if (
			audits.every(
				(audit) => audit.installed && audit.enabled && audit.configured,
			) &&
			!isCoreUniqueNoteCreatorEnabled(this.app)
		) {
			return;
		}
		this.reopenSetup();
	}

	reopenSetup(): void {
		new IntegrationOnboardingModal(
			this.app,
			() => {
				this.onboardingDismissed = true;
			},
			() => this.decorations?.refresh(),
		).open();
	}

	refreshDecorations(): void {
		this.decorations?.refresh();
	}

	openAppearancePicker(): void {
		this.decorations?.openAppearancePicker();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private async loadSettings(): Promise<void> {
		const stored =
			(await this.loadData()) as Partial<RootBooksWorkspaceSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
	}

	onunload(): void {
		this.pipeline?.dispose();
		this.folderTitles?.dispose();
		this.sorting?.dispose();
		this.decorations?.dispose();
	}
}
