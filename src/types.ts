export const ECOSYSTEM_VERSION = "0.9.0";

export const REQUIRED_PLUGIN_IDS = [
	"folder-notes",
	"custom-sort",
	"obsidian-front-matter-title-plugin",
	"frontmatter-date-manager",
] as const;

export type RequiredPluginId = (typeof REQUIRED_PLUGIN_IDS)[number];

export interface RootBooksWorkspaceSettings {
	schemaVersion: 1;
	metadataMigrationVersion: number;
	lastValidDateFormat: string;
	optionalFilenameTimeFormat: string;
	colorTabs: boolean;
	showBookLabel: boolean;
}

export const DEFAULT_SETTINGS: RootBooksWorkspaceSettings = {
	schemaVersion: 1,
	metadataMigrationVersion: 0,
	lastValidDateFormat: "DD.MM.YYYY",
	optionalFilenameTimeFormat: "",
	colorTabs: true,
	showBookLabel: true,
};

export interface BookPanelMetadata {
	icon: string;
	accent: string;
}

export interface BookRecord {
	id: string;
	name: string;
	folderPath: string;
	indexPath: string;
	panel: BookPanelMetadata;
}

export interface IntegrationAudit {
	id: RequiredPluginId;
	name: string;
	purpose: string;
	installed: boolean;
	enabled: boolean;
	configured: boolean;
	issues: string[];
}
