import { TFile, type App, type TFolder } from 'obsidian';
import { prefixedConfigKey, updateConfigFrontmatter } from './config-frontmatter';

export const PROPERTY_OVER_FILE_NAME_PLUGIN_ID = 'property-over-file-name';

interface ConfigNoteTitleHost {
	app: App;
	settings: { configFileBaseName: string };
	scopeResolver: { resolveFolder(folder: TFolder | null | undefined): unknown };
}

type PropertyPluginSettings = Record<string, unknown> & { propertyKey?: unknown };

interface PropertyPluginInstance {
	manifest?: { id?: unknown; version?: unknown };
	settings: PropertyPluginSettings;
	saveData(data: PropertyPluginSettings): Promise<void>;
	updateLinkSuggester?: () => unknown;
	rebuildCache?: () => unknown;
	updateQuickSwitcher?: () => unknown;
	updateGraphView?: () => unknown;
	updateTabs?: () => unknown;
	updateExplorer?: () => unknown;
	updateWindowFrame?: () => unknown;
	updateBookmarks?: () => unknown;
	updateProperties?: () => unknown;
}

export type PropertyOverFileNameStatus =
	| { state: 'not-enabled' }
	| { state: 'incompatible'; reason: string }
	| { state: 'connected'; propertyKey: string; version: string | null };

export type PropertyOverFileNameSyncResult =
	| { state: 'synced'; propertyKey: string; refreshFailures: string[] }
	| { state: 'not-enabled' }
	| { state: 'incompatible'; reason: string }
	| { state: 'failed'; reason: string };

export function isValidConfigTitleProperty(value: string): boolean {
	const key = value.trim().replace(/^book-tabs-/, '');
	return key.length > 0 && !['book-tabs', 'aliases', 'creation-date', 'fileOrder', 'orderingType', 'orderingEnabled',
		'forcedOrderingType', 'forcedOrderingDirection'].includes(key);
}

/** Maintains human-readable titles on hidden config notes and contains the optional plugin adapter. */
export class ConfigNoteTitleService {
	private queue: Promise<void> = Promise.resolve();

	constructor(private readonly plugin: ConfigNoteTitleHost) {}
	whenIdle(): Promise<void> { return this.queue; }

	isManagedConfigNote(file: TFile): boolean {
		if (file.extension !== 'md') return false;
		if (file.path === 'index.md') return true;
		const parent = file.parent;
		return !!parent
			&& !parent.isRoot()
			&& file.name === `${this.plugin.settings.configFileBaseName}.md`
			&& !!this.plugin.scopeResolver.resolveFolder(parent);
	}

	expectedTitle(file: TFile): string | null {
		if (!this.isManagedConfigNote(file)) return null;
		return file.path === 'index.md' ? this.plugin.app.vault.getName() : file.parent?.name ?? null;
	}

	syncFile(file: TFile, property: string, previousProperty?: string | null): Promise<boolean> {
		return this.enqueue(() => this.syncFileNow(file, property, previousProperty));
	}

	reconcileAll(property: string, previousProperty?: string | null): Promise<number> {
		return this.enqueue(async () => {
			let changed = 0;
			for (const file of this.plugin.app.vault.getMarkdownFiles()) {
				if (await this.syncFileNow(file, property, previousProperty)) changed++;
			}
			return changed;
		});
	}

	propertyPluginStatus(): PropertyOverFileNameStatus {
		const resolved = resolvePropertyPlugin(this.plugin.app);
		if (resolved.state !== 'connected') return resolved;
		return {
			state: 'connected',
			propertyKey: normalizeProperty(resolved.instance.settings.propertyKey) ?? 'title',
			version: typeof resolved.instance.manifest?.version === 'string' ? resolved.instance.manifest.version : null,
		};
	}

	async syncPropertyPlugin(property: string): Promise<PropertyOverFileNameSyncResult> {
		const normalized = normalizeProperty(property);
		if (!normalized) return { state: 'failed', reason: 'The display-title property cannot be empty.' };
		const resolved = resolvePropertyPlugin(this.plugin.app);
		if (resolved.state !== 'connected') return resolved;
		const instance = resolved.instance;
		const previous = instance.settings.propertyKey;
		instance.settings.propertyKey = normalized;
		try {
			await instance.saveData(instance.settings);
		} catch (error) {
			instance.settings.propertyKey = previous;
			return { state: 'failed', reason: errorMessage(error, 'Property Over File Name could not save its settings.') };
		}

		const refreshFailures: string[] = [];
		for (const method of REFRESH_METHODS) {
			const refresh = instance[method];
			if (typeof refresh !== 'function') continue;
			try { await refresh.call(instance); }
			catch (error) { refreshFailures.push(`${method}: ${errorMessage(error, 'refresh failed')}`); }
		}
		return { state: 'synced', propertyKey: normalized, refreshFailures };
	}

	private async syncFileNow(file: TFile, property: string, previousProperty?: string | null): Promise<boolean> {
		const title = this.expectedTitle(file);
		const normalized = normalizeProperty(property);
		if (title === null || !normalized) return false;
		const previous = normalizeProperty(previousProperty);
		const current = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter;
		const stalePrevious = !!previous && previous !== normalized
			&& (hasOwn(current, previous) || hasOwn(current, prefixedConfigKey(previous)));
		if (current?.[normalized] === title && !stalePrevious) return false;

		await updateConfigFrontmatter(this.plugin.app, file, (frontmatter) => {
			if (previous && previous !== normalized) {
				delete frontmatter[previous];
				const prefixedPrevious = prefixedConfigKey(previous);
				if (prefixedPrevious !== normalized) delete frontmatter[prefixedPrevious];
			}
			frontmatter[normalized] = title;
		}, previous && previous !== normalized ? { renamedKeys: { [previous]: normalized } } : undefined);
		return true;
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queue.then(operation);
		this.queue = result.then(() => undefined, () => undefined);
		return result;
	}
}

const REFRESH_METHODS = [
	'updateLinkSuggester',
	'rebuildCache',
	'updateQuickSwitcher',
	'updateGraphView',
	'updateTabs',
	'updateExplorer',
	'updateWindowFrame',
	'updateBookmarks',
	'updateProperties',
] as const satisfies readonly (keyof PropertyPluginInstance)[];

type PropertyPluginResolution =
	| { state: 'not-enabled' }
	| { state: 'incompatible'; reason: string }
	| { state: 'connected'; instance: PropertyPluginInstance };

/** Obsidian has no public community-plugin discovery API, so this adapter is optional and feature-detected. */
function resolvePropertyPlugin(app: App): PropertyPluginResolution {
	const manager = (app as App & { plugins?: unknown }).plugins;
	if (!isRecord(manager)) return { state: 'not-enabled' };
	let candidate: unknown;
	try {
		const getPlugin: unknown = manager.getPlugin;
		if (typeof getPlugin === 'function') candidate = (getPlugin as (id: string) => unknown).call(manager, PROPERTY_OVER_FILE_NAME_PLUGIN_ID);
		else if (isRecord(manager.plugins)) candidate = manager.plugins[PROPERTY_OVER_FILE_NAME_PLUGIN_ID];
	} catch (error) {
		return { state: 'incompatible', reason: errorMessage(error, 'Plugin discovery failed.') };
	}
	if (candidate === null || candidate === undefined) return { state: 'not-enabled' };
	if (!isRecord(candidate)) return { state: 'incompatible', reason: 'The enabled plugin instance has an unsupported shape.' };
	if (isRecord(candidate.manifest) && typeof candidate.manifest.id === 'string' && candidate.manifest.id !== PROPERTY_OVER_FILE_NAME_PLUGIN_ID) {
		return { state: 'incompatible', reason: 'The discovered plugin instance has an unexpected ID.' };
	}
	if (!isRecord(candidate.settings) || typeof candidate.saveData !== 'function') {
		return { state: 'incompatible', reason: 'This Property Over File Name version does not expose compatible settings.' };
	}
	if (typeof candidate.settings.propertyKey === 'string' && !isValidConfigTitleProperty(candidate.settings.propertyKey)) {
		return { state: 'incompatible', reason: 'The display-title key is reserved for folder configuration. Rename that property in the display plugin.' };
	}
	return { state: 'connected', instance: candidate as unknown as PropertyPluginInstance };
}

function normalizeProperty(value: unknown): string | null {
	return typeof value === 'string' && isValidConfigTitleProperty(value) ? value.trim() : null;
}

function hasOwn(value: unknown, key: string): boolean {
	return isRecord(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}
