import { normalizePath, TFile, TFolder, type App } from 'obsidian';
import { updateConfigFrontmatter } from './config-frontmatter';

export interface FolderTemplateConfig {
	templateFilePrefix: string;
	templateFileDate: string;
	templateFilePath: string;
	templateFileAppliedTo: string;
}

export type FolderTemplateOverrides = Partial<FolderTemplateConfig>;

export interface DiscoveredFolderTemplate {
	folder: TFolder;
	overrides: FolderTemplateOverrides;
	effective: FolderTemplateConfig;
}

interface FolderTemplatePlugin {
	app: App;
	settings: FolderTemplateConfig & { configFileBaseName: string };
	vaultConfig?: { values: Record<string, unknown> };
	bookOrder: { ensureConfig(folder: TFolder): Promise<TFile> };
	scopeResolver: { resolveFile(file: TFile): { id: string } | null };
}

interface TemplateField {
	setting: keyof FolderTemplateConfig;
	frontmatter: string;
	aliases?: readonly string[];
}

const TEMPLATE_FIELDS: readonly TemplateField[] = [
	{ setting: 'templateFilePrefix', frontmatter: 'template-file-prefix' },
	{ setting: 'templateFileDate', frontmatter: 'template-file-date' },
	{ setting: 'templateFilePath', frontmatter: 'template-file-path' },
	{ setting: 'templateFileAppliedTo', frontmatter: 'template-file-applied-To', aliases: ['template-file-applied-to'] },
];

const INVALID_FILENAME_CHARACTERS = /[\\/:*?"<>|]/g;

/** Resolves portable template policy and applies it to newly-created vault files. */
export class FolderTemplateService {
	private readonly writtenFrontmatter = new Map<string, Record<string, unknown>>();

	constructor(
		private readonly plugin: FolderTemplatePlugin,
		private readonly now: () => Date = () => new Date(),
	) {}

	resolveForFolder(folder: TFolder): FolderTemplateConfig {
		const rootValues = this.plugin.vaultConfig?.values ?? {};
		return Object.fromEntries(TEMPLATE_FIELDS.map((field) => {
			let current: TFolder | null = folder;
			while (current && !current.isRoot()) {
				const value = readManagedString(this.folderValues(current), field);
				if (value !== undefined) return [field.setting, value];
				current = current.parent;
			}
			return [
				field.setting,
				readManagedString(rootValues, field) ?? this.plugin.settings[field.setting],
			];
		})) as unknown as FolderTemplateConfig;
	}

	readFolderOverrides(folder: TFolder): FolderTemplateOverrides {
		const values = this.folderValues(folder);
		const overrides: FolderTemplateOverrides = {};
		for (const field of TEMPLATE_FIELDS) {
			const value = readManagedString(values, field);
			if (value !== undefined) overrides[field.setting] = value;
		}
		return overrides;
	}

	discoverFolderOverrides(): DiscoveredFolderTemplate[] {
		const configName = `${this.plugin.settings.configFileBaseName}.md`;
		return this.plugin.app.vault.getMarkdownFiles()
			.filter((file) => file.name === configName
				&& file.parent !== null
				&& !file.parent.isRoot()
				&& this.plugin.scopeResolver.resolveFile(file) !== null)
			.map((file) => ({ file, folder: file.parent!, overrides: this.readFolderOverrides(file.parent!) }))
			.filter(({ overrides }) => Object.keys(overrides).length > 0)
			.sort((left, right) => left.folder.path.localeCompare(right.folder.path))
			.map(({ folder, overrides }) => ({ folder, overrides, effective: this.resolveForFolder(folder) }));
	}

	async writeFolderOverrides(folder: TFolder, overrides: FolderTemplateOverrides): Promise<TFile> {
		const file = await this.plugin.bookOrder.ensureConfig(folder);
		await updateConfigFrontmatter(this.plugin.app, file, (frontmatter, context) => {
			for (const field of TEMPLATE_FIELDS) {
				const value = overrides[field.setting];
				for (const key of managedKeys(field)) {
					if (key.startsWith('book-tabs-')) delete frontmatter[key];
					else if (context.ownedPlainKeys.has(key)) delete frontmatter[key];
				}
				if (value !== undefined && value !== '') writeManagedString(frontmatter, field, value);
			}
			this.writtenFrontmatter.set(file.path, { ...frontmatter });
		});
		return file;
	}

	refresh(file: TFile): void {
		this.writtenFrontmatter.delete(file.path);
	}

	async handleCreate(file: TFile): Promise<boolean> {
		if (!file.parent || !this.plugin.scopeResolver.resolveFile(file) || this.isConfigNote(file)) return false;
		const config = this.resolveForFolder(file.parent);
		const templatePath = normalizePath(config.templateFilePath);
		if (!matchesExtension(file.extension, config.templateFileAppliedTo) || file.path === templatePath) return false;

		let changed = false;
		const prefixedPath = this.prefixedPath(file, config);
		if (prefixedPath !== file.path) {
			await this.plugin.app.fileManager.renameFile(file, prefixedPath);
			changed = true;
		}

		if (!templatePath || file.path === templatePath) return changed;
		const template = this.plugin.app.vault.getFileByPath(templatePath);
		if (!template) return changed;
		const contents = await this.plugin.app.vault.readBinary(template);
		await this.plugin.app.vault.modifyBinary(file, contents);
		return true;
	}

	private folderValues(folder: TFolder): Record<string, unknown> {
		const path = `${folder.path}/${this.plugin.settings.configFileBaseName}.md`;
		const cached = this.writtenFrontmatter.get(path);
		if (cached) return cached;
		const file = this.plugin.app.vault.getFileByPath(path);
		return file ? this.plugin.app.metadataCache.getFileCache(file)?.frontmatter ?? {} : {};
	}

	private isConfigNote(file: TFile): boolean {
		return file.extension === 'md' && file.basename === this.plugin.settings.configFileBaseName;
	}

	private prefixedPath(file: TFile, config: FolderTemplateConfig): string {
		if (!config.templateFilePrefix) return file.path;
		const date = this.now();
		const dateToken = formatDate(date, config.templateFileDate, false);
		const firstPrefix = sanitizeFilenamePart(config.templateFilePrefix.replaceAll('{{date}}', dateToken));
		const firstPath = siblingPath(file, `${firstPrefix}${file.name}`);
		const dateOnlyCollision = config.templateFilePrefix.includes('{{date}}')
			&& !hasTimeTokens(config.templateFileDate)
			&& file.parent?.children.some(child => child !== file && child.name.startsWith(firstPrefix));
		if (!dateOnlyCollision && isAvailablePath(this.plugin.app, file, firstPath)) return firstPath;

		const timedToken = formatDate(date, config.templateFileDate, true);
		const timedPrefix = sanitizeFilenamePart(config.templateFilePrefix.replaceAll('{{date}}', timedToken));
		const timedName = `${timedPrefix}${file.name}`;
		let candidate = siblingPath(file, timedName);
		if (isAvailablePath(this.plugin.app, file, candidate)) return candidate;
		for (let index = 2; ; index++) {
			candidate = siblingPath(file, appendFilenameSuffix(timedName, `-${index}`));
			if (isAvailablePath(this.plugin.app, file, candidate)) return candidate;
		}
	}
}

function managedKeys(field: TemplateField): string[] {
	const plain = [field.frontmatter, ...(field.aliases ?? []), field.setting];
	return [...plain.map((key) => `book-tabs-${key}`), ...plain];
}

/** Prefixed values win, while camelCase supports portable root-setting storage. */
export function readManagedString(values: Record<string, unknown>, field: TemplateField): string | undefined {
	for (const key of managedKeys(field)) {
		const value = values[key];
		if (typeof value === 'string') return value;
	}
	return undefined;
}

/** UI writes use the plugin namespace so an unrelated plain key is never overwritten. */
export function writeManagedString(values: Record<string, unknown>, field: TemplateField, value: string): void {
	values[`book-tabs-${field.frontmatter}`] = value;
}

function matchesExtension(extension: string, configured: string): boolean {
	const expected = configured.split(/[\s,]+/).map(value => value.trim().replace(/^\./, '').toLowerCase()).filter(Boolean);
	return expected.includes('*') || expected.includes(extension.toLowerCase());
}

function formatDate(date: Date, pattern: string, includeTime: boolean): string {
	const basePattern = pattern.trim() || 'DD.MM.YYYY';
	const rendered = replaceDateTokens(basePattern, date);
	if (!includeTime || hasTimeTokens(basePattern)) return rendered;
	return `${rendered}_at_${replaceDateTokens('HH-mm', date)}`;
}

function hasTimeTokens(pattern: string): boolean {
	return /H{1,2}|h{1,2}|m{1,2}|s{1,2}/.test(pattern);
}

function replaceDateTokens(pattern: string, date: Date): string {
	const values: Record<string, string> = {
		YYYY: String(date.getFullYear()),
		YY: String(date.getFullYear()).slice(-2),
		MM: String(date.getMonth() + 1).padStart(2, '0'),
		DD: String(date.getDate()).padStart(2, '0'),
		HH: String(date.getHours()).padStart(2, '0'),
		mm: String(date.getMinutes()).padStart(2, '0'),
		ss: String(date.getSeconds()).padStart(2, '0'),
	};
	return pattern.replace(/YYYY|YY|MM|DD|HH|mm|ss/g, (token) => values[token] ?? token);
}

function sanitizeFilenamePart(value: string): string {
	return value.replace(INVALID_FILENAME_CHARACTERS, '-');
}

function siblingPath(file: TFile, name: string): string {
	return normalizePath(file.parent?.isRoot() ? name : `${file.parent?.path ?? ''}/${name}`);
}

function isAvailablePath(app: App, file: TFile, path: string): boolean {
	const existing = app.vault.getAbstractFileByPath(path);
	return existing === null || existing === file;
}

function appendFilenameSuffix(name: string, suffix: string): string {
	const dot = name.lastIndexOf('.');
	return dot > 0 ? `${name.slice(0, dot)}${suffix}${name.slice(dot)}` : `${name}${suffix}`;
}
