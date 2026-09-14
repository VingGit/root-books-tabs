import { ensurePluginFrontmatter, prefixedConfigKey, readPluginFrontmatter, updateConfigFrontmatter, writePluginFrontmatter, type ConfigFrontmatterContext } from './config-frontmatter';
import { TFile, TFolder, parseYaml, getFrontMatterInfo } from 'obsidian';
import type ScopeTabsPlugin from './main';
import { DEFAULT_SETTINGS, migrateSettings } from './settings-model';
import type { ScopeTabsSettings } from './types';

const LOCAL_KEYS = new Set(['manualColors', 'manualTabTextColors', 'colorMode', 'selectedBookId', 'defaultStartupBookId', 'defaultStartupNotePath', 'bookNoteOpenModeOverrides', 'tabCustomCss', 'indexMoveDecision']);
const ROOT_ONLY_KEYS = ['isFreshClone', 'freshCloneOpeningPath', 'createBookIndex', 'hideNewBookIndex'] as const;
const OBSOLETE_ROOT_KEYS = ['showGridBoundaries', 'gridBoundaryThickness'] as const;
const LEGACY_TEMPLATE_ROOT_KEYS = ['template-file-prefix', 'template-file-date', 'template-file-path', 'template-file-applied-To', 'template-file-applied-to'] as const;
const LEGACY_TEMPLATE_SETTING_ALIASES: Record<string, readonly string[]> = {
	templateFilePrefix: ['template-file-prefix'],
	templateFileDate: ['template-file-date'],
	templateFilePath: ['template-file-path'],
	templateFileAppliedTo: ['template-file-applied-To', 'template-file-applied-to'],
};
const ROOT_KEY_ALIASES: Record<string, readonly string[]> = {
	templateFolder: ['template-folder'],
	templateMd: ['template-md'],
	templateCanvas: ['template-canvas'],
	templateBase: ['template-base'],
};
const sameValue = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

export class VaultConfigService {
	values: Record<string, unknown> = {};
	private queue: Promise<void> = Promise.resolve();
	private savedSettings: ScopeTabsSettings | null = null;
	private pending = new Map<string, { value: unknown }>();
	constructor(private readonly plugin: ScopeTabsPlugin) {}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queue.then(operation);
		this.queue = result.then(() => undefined, () => undefined);
		return result;
	}

	ensureRoot(): Promise<TFile> {
		return this.enqueue(() => this.ensureRootNow());
	}

	private async ensureRootNow(): Promise<TFile> {
		const vault = this.plugin.app.vault;
		const existing = vault.getAbstractFileByPath('index.md');
		if (existing && !(existing instanceof TFile)) throw new Error('Root index.md is a folder.');
		const file = existing ?? await vault.create('index.md', '');
		const settings = this.plugin.settings;
		await this.write(file, (fm, context) => {
			for (const key of OBSOLETE_ROOT_KEYS) {
				delete fm[prefixedConfigKey(key)];
				if (context.ownedPlainKeys.has(key)) delete fm[key];
			}
			const defaults = {
				isFreshClone: true,
				freshCloneOpeningPath: settings.defaultStartupNotePath || settings.defaultStartupBookId || '',
				tabInsertDirection: settings.tabInsertDirection,
				openBooksInExternalWindows: settings.openBooksInExternalWindows,
				createBookIndex: true,
				hideNewBookIndex: false,
			};
			for (const [key, value] of Object.entries(settings)) {
				if (!LOCAL_KEYS.has(key)) ensurePluginFrontmatter(fm, storageKey(key), value, context.ownedPlainKeys);
			}
			for (const key of LEGACY_TEMPLATE_ROOT_KEYS) {
				delete fm[prefixedConfigKey(key)];
				if (context.ownedPlainKeys.has(key)) delete fm[key];
			}
			for (const [key, value] of Object.entries(defaults)) ensurePluginFrontmatter(fm, key, value, context.ownedPlainKeys);
		});
		return file;
	}

	load(): Promise<void> {
		return this.enqueue(async () => {
			const file = this.plugin.app.vault.getFileByPath('index.md');
			if (!file) return;
			const info = getFrontMatterInfo(await this.plugin.app.vault.read(file));
			const parsed: unknown = info.exists ? parseYaml(info.frontmatter) : {};
			if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) throw new Error('Root configuration frontmatter must contain settings properties.');
			this.values = logicalRootValues(parsed as Record<string, unknown> ?? {});
			this.applySettings();
		});
	}

	private applySettings(): void {
		// A metadata event can arrive while a control has changed but its save is pending.
		// Keep those edits in memory; only the actual file values become the saved baseline.
		const edits = this.savedSettings ? Object.entries(this.plugin.settings).filter(([key, value]) => !LOCAL_KEYS.has(key) && (this.pending.has(key) || !sameValue(value, this.savedSettings?.[key as keyof ScopeTabsSettings]))) : [];
		const portable = Object.fromEntries(Object.entries(this.values).filter(([key]) => !LOCAL_KEYS.has(key)));
		const saved = migrateSettings({ ...this.plugin.settings, ...portable });
		this.savedSettings = structuredClone(saved);
		this.plugin.settings = migrateSettings({ ...saved, ...Object.fromEntries(edits) });
	}

	private async write(file: TFile, change: (fm: Record<string, unknown>, context: ConfigFrontmatterContext) => void): Promise<void> {
		let nextValues: Record<string, unknown> | undefined;
		await updateConfigFrontmatter(this.plugin.app, file, (fm, context) => { change(fm, context); nextValues = structuredClone(fm); });
		if (nextValues) {
			this.values = logicalRootValues(nextValues);
			this.applySettings();
		}
	}

	saveSettings(): Promise<void> {
		if (!this.savedSettings) return Promise.resolve();
		const changes = Object.entries(this.plugin.settings).filter(([key, value]) => {
			const baseline = this.pending.get(key);
			return !LOCAL_KEYS.has(key) && !sameValue(value, baseline ? baseline.value : this.savedSettings?.[key as keyof ScopeTabsSettings]);
		});
		if (!changes.length) return Promise.resolve();
		const entries = changes.map(([key, value]) => [key, { value: structuredClone(value as unknown) }] as const);
		for (const [key, entry] of entries) this.pending.set(key, entry);
		return this.enqueue(async () => {
			try {
				const file = this.plugin.app.vault.getFileByPath('index.md') ?? await this.ensureRootNow();
				await this.write(file, (fm, context) => {
					for (const [key, entry] of entries) writePluginFrontmatter(fm, storageKey(key), entry.value, context.ownedPlainKeys);
				});
			} finally {
				for (const [key, entry] of entries) if (this.pending.get(key) === entry) this.pending.delete(key);
			}
		});
	}

	set(key: string, value: unknown): Promise<void> {
		const entry = { value: structuredClone(value) };
		if (key in this.plugin.settings && !LOCAL_KEYS.has(key)) {
			this.plugin.settings = migrateSettings({ ...this.plugin.settings, [key]: entry.value });
			this.pending.set(key, entry);
		}
		return this.enqueue(async () => {
			try {
				const file = this.plugin.app.vault.getFileByPath('index.md') ?? await this.ensureRootNow();
				await this.write(file, (fm, context) => { writePluginFrontmatter(fm, storageKey(key), entry.value, context.ownedPlainKeys); });
			} finally {
				if (this.pending.get(key) === entry) this.pending.delete(key);
			}
		});
	}

	async startupFile(restored: boolean): Promise<TFile | null> {
		await this.queue;
		if (this.values.isFreshClone !== true) return null;
		const path = typeof this.values.freshCloneOpeningPath === 'string' ? this.values.freshCloneOpeningPath.replace(/^\.\//, '').replace(/\/$/, '') : '';
		const entry = this.plugin.app.vault.getAbstractFileByPath(path);
		if (entry instanceof TFile && entry.extension === 'md') return entry;
		if (entry instanceof TFolder && entry.parent?.isRoot()) {
			const index = this.plugin.app.vault.getFileByPath(`${entry.path}/${this.plugin.settings.configFileBaseName}.md`);
			if (index) return index;
			const note = this.latest(entry.path);
			const isBook = this.plugin.scopeResolver.listBooks().some(book => book.id === entry.path);
			return note ?? (isBook ? this.plugin.bookOrder.ensureConfig(entry) : null);
		}
		return restored ? null : this.latest();
	}

	private latest(folder?: string): TFile | null {
		return this.plugin.app.vault.getMarkdownFiles().filter((file) => folder ? file.path.startsWith(`${folder}/`) : file.path !== 'index.md')
			.sort((a, b) => b.stat.mtime - a.stat.mtime || a.path.localeCompare(b.path))[0] ?? null;
	}
}

function logicalRootValues(raw: Record<string, unknown>): Record<string, unknown> {
	const values = { ...raw };
	for (const key of OBSOLETE_ROOT_KEYS) {
		delete values[key];
		delete values[prefixedConfigKey(key)];
	}
	let hasLegacyTemplateSettings = false;
	for (const [setting, candidates] of Object.entries(LEGACY_TEMPLATE_SETTING_ALIASES)) {
		let found = false;
		for (const candidate of candidates) {
			const prefixed = prefixedConfigKey(candidate);
			if (Object.prototype.hasOwnProperty.call(raw, prefixed)) {
				values[setting] = raw[prefixed]; found = true; hasLegacyTemplateSettings = true; break;
			}
		}
		if (!found) for (const candidate of candidates) if (Object.prototype.hasOwnProperty.call(raw, candidate)) {
			values[setting] = raw[candidate]; hasLegacyTemplateSettings = true; break;
		}
		for (const candidate of candidates) {
			delete values[candidate];
			delete values[prefixedConfigKey(candidate)];
		}
	}
	const hasNewTemplateMd = ['templateMd', 'template-md', prefixedConfigKey('templateMd'), prefixedConfigKey('template-md')]
		.some(key => Object.prototype.hasOwnProperty.call(raw, key));
	if (hasLegacyTemplateSettings && !hasNewTemplateMd) values.templateMd = legacyRootTemplateRule(values);
	const logicalKeys = new Set([...Object.keys(DEFAULT_SETTINGS).filter(key => !LOCAL_KEYS.has(key)), ...ROOT_ONLY_KEYS]);
	for (const key of logicalKeys) {
		const candidates = ROOT_KEY_ALIASES[key] ?? [key];
		let found = false;
		for (const candidate of candidates) {
			const prefixed = prefixedConfigKey(candidate);
			if (Object.prototype.hasOwnProperty.call(raw, prefixed)) {
				values[key] = raw[prefixed]; found = true; break;
			}
		}
		if (!found) for (const candidate of candidates) if (Object.prototype.hasOwnProperty.call(raw, candidate)) {
			values[key] = readPluginFrontmatter(raw, candidate); found = true; break;
		}
		for (const candidate of candidates) {
			if (candidate !== key) delete values[candidate];
			delete values[prefixedConfigKey(candidate)];
		}
	}
	return values;
}

function legacyRootTemplateRule(values: Record<string, unknown>): ScopeTabsSettings['templateMd'] {
	const applied = typeof values.templateFileAppliedTo === 'string' ? values.templateFileAppliedTo : 'md';
	const extensions = applied.split(/[\s,]+/).map(value => value.replace(/^\./, '').toLowerCase());
	if (!extensions.some(value => value === 'md' || value === '*')) return {};
	const rawPath = typeof values.templateFilePath === 'string' ? values.templateFilePath : 'templates/example.md';
	const path = rawPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '').trim();
	if (!path.toLowerCase().endsWith('.md')) return {};
	const date = typeof values.templateFileDate === 'string' ? values.templateFileDate.trim() : 'DD.MM.YYYY';
	const prefix = typeof values.templateFilePrefix === 'string' ? values.templateFilePrefix : '{{date}}_';
	return { [path]: [date, prefix, true] };
}

function storageKey(key: string): string {
	return ROOT_KEY_ALIASES[key]?.[0] ?? key;
}
