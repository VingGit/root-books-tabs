import { App, normalizePath } from "obsidian";
import type { IntegrationAudit, RequiredPluginId } from "./types";

interface Recommendation {
	path: string;
	label: string;
	value: unknown;
}

interface IntegrationDescriptor {
	id: RequiredPluginId;
	name: string;
	purpose: string;
	recommendations: Recommendation[];
}

interface LoadedCompanion {
	settings?: Record<string, unknown>;
	saveSettings?: () => Promise<void>;
}

interface CommunityPluginManager {
	plugins?: Record<string, LoadedCompanion>;
	enabledPlugins?: Set<string>;
	enablePlugin?: (id: string) => Promise<void>;
}

interface CorePluginManager {
	disablePlugin?: (id: string) => Promise<void> | void;
	getPluginById?: (id: string) => { enabled?: boolean } | undefined;
}

interface SettingsManager {
	open?: () => void;
	openTabById?: (id: string) => void;
}

function communityManager(app: App): CommunityPluginManager | undefined {
	return (app as App & { plugins?: CommunityPluginManager }).plugins;
}

function coreManager(app: App): CorePluginManager | undefined {
	return (app as App & { internalPlugins?: CorePluginManager })
		.internalPlugins;
}

function settingsManager(app: App): SettingsManager | undefined {
	return (app as App & { setting?: SettingsManager }).setting;
}

function getPath(record: Record<string, unknown>, path: string): unknown {
	let current: unknown = record;
	for (const part of path.split(".")) {
		if (
			typeof current !== "object" ||
			current === null ||
			Array.isArray(current)
		)
			return undefined;
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

function setPath(
	record: Record<string, unknown>,
	path: string,
	value: unknown,
): void {
	const parts = path.split(".");
	let current = record;
	for (const part of parts.slice(0, -1)) {
		const existing = current[part];
		if (
			typeof existing === "object" &&
			existing !== null &&
			!Array.isArray(existing)
		) {
			current = existing as Record<string, unknown>;
		} else {
			const next: Record<string, unknown> = {};
			current[part] = next;
			current = next;
		}
	}
	const final = parts.at(-1);
	if (final) current[final] = structuredClone(value);
}

function equal(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

export const INTEGRATIONS: readonly IntegrationDescriptor[] = [
	{
		id: "folder-notes",
		name: "Folder Notes",
		purpose: "Creates and opens index.md folder notes inside each folder.",
		recommendations: [
			{
				path: "folderNoteName",
				label: "Folder-note name is index",
				value: "index",
			},
			{
				path: "folderNoteType",
				label: "Folder notes use Markdown",
				value: ".md",
			},
			{
				path: "storageLocation",
				label: "Folder notes stay inside folders",
				value: "insideFolder",
			},
			{
				path: "templatePath",
				label: "Folder-note template is templates/index-template.md",
				value: "templates/index-template.md",
			},
			{
				path: "autoCreate",
				label: "Folder notes are created automatically",
				value: true,
			},
			{
				path: "hideFolderNote",
				label: "Folder-note files stay hidden in Explorer",
				value: true,
			},
			{
				path: "frontMatterTitle.enabled",
				label: "Front Matter Title integration is enabled",
				value: true,
			},
			{
				path: "frontMatterTitle.explorer",
				label: "Explorer uses folder-note titles",
				value: true,
			},
			{
				path: "frontMatterTitle.path",
				label: "Paths use folder-note titles",
				value: true,
			},
		],
	},
	{
		id: "custom-sort",
		name: "Custom File Explorer Sorting",
		purpose:
			"Applies inherited sorting-spec rules in Obsidian's File Explorer.",
		recommendations: [
			{
				path: "indexNoteNameForFolderNotes",
				label: "Folder-note name is index",
				value: "index",
			},
			{
				path: "suspended",
				label: "Custom sorting is active",
				value: false,
			},
			{
				path: "automaticBookmarksIntegration",
				label: "Bookmark integration is enabled",
				value: true,
			},
		],
	},
	{
		id: "obsidian-front-matter-title-plugin",
		name: "Front Matter Title",
		purpose:
			"Uses each index.md title as the visible folder and link name.",
		recommendations: [
			{
				path: "templates.common.main",
				label: "The common title property is title",
				value: "title",
			},
			{
				path: "features.alias.enabled",
				label: "Alias injection is disabled to avoid duplicate index suggestions",
				value: false,
			},
			{
				path: "features.explorer.enabled",
				label: "Explorer titles are enabled",
				value: true,
			},
			{
				path: "features.suggest.enabled",
				label: "Suggestion titles are enabled",
				value: true,
			},
			{
				path: "features.noteLink.enabled",
				label: "Note-link titles are enabled",
				value: true,
			},
			{
				path: "features.noteLink.strategy",
				label: "Only empty link aliases are filled",
				value: "onlyEmpty",
			},
		],
	},
	{
		id: "frontmatter-date-manager",
		name: "Frontmatter Date Manager",
		purpose:
			"Maintains reliable created and updated fields used by ordering.",
		recommendations: [
			{
				path: "dateFormat",
				label: "Date and time use the portable ISO-like format",
				value: "yyyy-MM-dd'T'HH:mm:ss",
			},
			{
				path: "headerCreated",
				label: "The creation field is created",
				value: "created",
			},
			{
				path: "headerUpdated",
				label: "The update field is updated",
				value: "updated",
			},
			{
				path: "enableCreateTime",
				label: "Creation dates are enabled",
				value: true,
			},
			{
				path: "enableAutoUpdate",
				label: "Update dates are enabled",
				value: true,
			},
			{
				path: "filterRules",
				label: "Templates and root notes are skipped",
				value: "templates/\n./*",
			},
			{
				path: "enableAutoPopulateCache",
				label: "The date cache populates at startup",
				value: true,
			},
			{
				path: "inversionFixStrategy",
				label: "Out-of-order dates are preserved",
				value: "disabled",
			},
			{
				path: "postUpdateCommand",
				label: "Broad post-update sorting is disabled",
				value: "",
			},
		],
	},
] as const;

async function pluginSettings(
	app: App,
	id: string,
): Promise<Record<string, unknown>> {
	const loaded = communityManager(app)?.plugins?.[id]?.settings;
	if (loaded) return structuredClone(loaded);
	const path = normalizePath(
		`${app.vault.configDir}/plugins/${id}/data.json`,
	);
	try {
		const raw = await app.vault.adapter.read(path);
		const value: unknown = JSON.parse(raw);
		return typeof value === "object" &&
			value !== null &&
			!Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

async function pluginInstalled(app: App, id: string): Promise<boolean> {
	return app.vault.adapter.exists(
		normalizePath(`${app.vault.configDir}/plugins/${id}/manifest.json`),
	);
}

function pluginEnabled(app: App, id: string): boolean {
	const manager = communityManager(app);
	return Boolean(manager?.enabledPlugins?.has(id) || manager?.plugins?.[id]);
}

export async function auditIntegrations(app: App): Promise<IntegrationAudit[]> {
	return Promise.all(
		INTEGRATIONS.map(async (descriptor) => {
			const installed = await pluginInstalled(app, descriptor.id);
			const enabled = installed && pluginEnabled(app, descriptor.id);
			const settings = installed
				? await pluginSettings(app, descriptor.id)
				: {};
			const issues = descriptor.recommendations
				.filter(
					(recommendation) =>
						!equal(
							getPath(settings, recommendation.path),
							recommendation.value,
						),
				)
				.map((recommendation) => recommendation.label);
			return {
				id: descriptor.id,
				name: descriptor.name,
				purpose: descriptor.purpose,
				installed,
				enabled,
				configured: installed && issues.length === 0,
				issues,
			};
		}),
	);
}

async function savePluginSettings(
	app: App,
	descriptor: IntegrationDescriptor,
): Promise<void> {
	const manager = communityManager(app);
	const loaded = manager?.plugins?.[descriptor.id];
	const settings = await pluginSettings(app, descriptor.id);
	for (const recommendation of descriptor.recommendations) {
		setPath(settings, recommendation.path, recommendation.value);
	}

	if (loaded?.settings && loaded.saveSettings) {
		for (const key of Object.keys(loaded.settings))
			delete loaded.settings[key];
		Object.assign(loaded.settings, settings);
		await loaded.saveSettings();
		return;
	}

	const path = normalizePath(
		`${app.vault.configDir}/plugins/${descriptor.id}/data.json`,
	);
	await app.vault.adapter.write(
		path,
		`${JSON.stringify(settings, null, 2)}\n`,
	);
}

export async function applyRecommendedIntegrations(
	app: App,
): Promise<string[]> {
	const missing: string[] = [];
	const manager = communityManager(app);
	for (const descriptor of INTEGRATIONS) {
		if (!(await pluginInstalled(app, descriptor.id))) {
			missing.push(descriptor.name);
			continue;
		}
		if (!pluginEnabled(app, descriptor.id) && manager?.enablePlugin) {
			await manager.enablePlugin(descriptor.id);
		}
		await savePluginSettings(app, descriptor);
	}
	await disableCoreUniqueNoteCreator(app);
	return missing;
}

export function isCoreUniqueNoteCreatorEnabled(app: App): boolean {
	return coreManager(app)?.getPluginById?.("zk-prefixer")?.enabled === true;
}

export async function disableCoreUniqueNoteCreator(app: App): Promise<void> {
	const manager = coreManager(app);
	if (
		manager?.getPluginById?.("zk-prefixer")?.enabled &&
		manager.disablePlugin
	) {
		await manager.disablePlugin("zk-prefixer");
	}
}

export function openCommunityPluginSettings(app: App): void {
	const manager = settingsManager(app);
	manager?.open?.();
	manager?.openTabById?.("community-plugins");
}

export function integrationDescriptor(
	id: RequiredPluginId,
): IntegrationDescriptor {
	const descriptor = INTEGRATIONS.find((candidate) => candidate.id === id);
	if (!descriptor) throw new Error(`Unknown integration: ${id}`);
	return descriptor;
}
