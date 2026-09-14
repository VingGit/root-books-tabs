import { normalizePath, TFile, TFolder, type App } from 'obsidian';
import { updateConfigFrontmatter } from './config-frontmatter';
import type { TemplateFileType, TemplateRule } from './types';

export interface FolderTemplateConfig {
	templateFolder: string;
	templateMd: TemplateRule;
	templateCanvas: TemplateRule;
	templateBase: TemplateRule;
}

export interface FolderTemplateOverrides {
	templatePathsUnderGlobalFolder?: boolean;
	templateMd?: TemplateRule;
	templateCanvas?: TemplateRule;
	templateBase?: TemplateRule;
}

export interface TemplateRuleValues {
	templatePath: string;
	dateFormat: string;
	prefix: string;
	applyFilenameConvention: boolean;
}

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
	setting: 'templateMd' | 'templateCanvas' | 'templateBase';
	frontmatter: 'template-md' | 'template-canvas' | 'template-base';
	type: TemplateFileType;
}

const TEMPLATE_FIELDS: readonly TemplateField[] = [
	{ setting: 'templateMd', frontmatter: 'template-md', type: 'md' },
	{ setting: 'templateCanvas', frontmatter: 'template-canvas', type: 'canvas' },
	{ setting: 'templateBase', frontmatter: 'template-base', type: 'base' },
];
const PATH_MODE_FIELD = 'template-paths-under-global-folder';
const LEGACY_FIELDS = ['template-file-prefix', 'template-file-date', 'template-file-path', 'template-file-applied-To', 'template-file-applied-to'] as const;
const INVALID_FILENAME_CHARACTERS = /[\\/:*?"<>|]/g;

/** Resolves portable per-type template rules and applies them to newly created vault files. */
export class FolderTemplateService {
	private readonly writtenFrontmatter = new Map<string, Record<string, unknown>>();

	constructor(
		private readonly plugin: FolderTemplatePlugin,
		private readonly now: () => Date = () => new Date(),
	) {}

	resolveForFolder(folder: TFolder): FolderTemplateConfig {
		return {
			templateFolder: this.globalTemplateFolder(),
			...Object.fromEntries(TEMPLATE_FIELDS.map(field => [field.setting, this.resolveRule(folder, field).rule])),
		} as FolderTemplateConfig;
	}

	readFolderOverrides(folder: TFolder): FolderTemplateOverrides {
		const values = this.folderValues(folder);
		const overrides: FolderTemplateOverrides = {};
		const pathMode = readManagedBoolean(values, PATH_MODE_FIELD);
		if (pathMode !== undefined) overrides.templatePathsUnderGlobalFolder = pathMode;
		for (const field of TEMPLATE_FIELDS) {
			const storedRule = readManagedRule(values, field);
			const legacy = field.type === 'md' && hasLegacyMarkdownValues(values);
			const rule = storedRule ?? (legacy ? this.resolveRule(folder, field).rule : undefined);
			if (rule !== undefined) overrides[field.setting] = rule;
		}
		if (pathMode === undefined && hasLegacyMarkdownValues(values)) {
			const resolved = this.resolveRule(folder, TEMPLATE_FIELDS[0]!);
			const path = ruleValues(resolved.rule)?.templatePath ?? '';
			overrides.templatePathsUnderGlobalFolder = resolved.folderOverrideMode ?? !path.includes('/');
		}
		return overrides;
	}

	discoverFolderOverrides(): DiscoveredFolderTemplate[] {
		const configName = `${this.plugin.settings.configFileBaseName}.md`;
		return this.plugin.app.vault.getMarkdownFiles()
			.filter(file => file.name === configName && file.parent !== null && !file.parent.isRoot()
				&& this.plugin.scopeResolver.resolveFile(file) !== null)
			.map(file => ({ folder: file.parent!, overrides: this.readFolderOverrides(file.parent!) }))
			.filter(({ overrides }) => TEMPLATE_FIELDS.some(field => overrides[field.setting] !== undefined))
			.sort((left, right) => left.folder.path.localeCompare(right.folder.path))
			.map(({ folder, overrides }) => ({ folder, overrides, effective: this.resolveForFolder(folder) }));
	}

	async writeFolderOverrides(folder: TFolder, overrides: FolderTemplateOverrides): Promise<TFile> {
		for (const field of TEMPLATE_FIELDS) {
			const rule = overrides[field.setting];
			if (rule !== undefined) validateRule(rule, field.type);
		}
		const file = await this.plugin.bookOrder.ensureConfig(folder);
		await updateConfigFrontmatter(this.plugin.app, file, (frontmatter, context) => {
			for (const field of TEMPLATE_FIELDS) {
				const value = overrides[field.setting];
				removeManagedValue(frontmatter, field, context.ownedPlainKeys, value === undefined);
				if (value !== undefined) frontmatter[`book-tabs-${field.frontmatter}`] = structuredClone(value);
			}
			removeManagedBoolean(frontmatter, PATH_MODE_FIELD, context.ownedPlainKeys);
			frontmatter[`book-tabs-${PATH_MODE_FIELD}`] = overrides.templatePathsUnderGlobalFolder ?? true;
			for (const legacy of LEGACY_FIELDS) removeManagedBoolean(frontmatter, legacy, context.ownedPlainKeys);
			this.writtenFrontmatter.set(file.path, { ...frontmatter });
		});
		for (const field of TEMPLATE_FIELDS) {
			const rule = overrides[field.setting];
			const values = rule ? ruleValues(rule) : null;
			if (!values) continue;
			const path = this.resolveTemplatePath(values.templatePath, overrides.templatePathsUnderGlobalFolder ?? true);
			await this.ensureTemplateFile(path, field.type);
		}
		return file;
	}

	refresh(file: TFile): void { this.writtenFrontmatter.delete(file.path); }

	async handleCreate(file: TFile): Promise<boolean> {
		if (!file.parent || !this.plugin.scopeResolver.resolveFile(file) || this.isConfigNote(file)) return false;
		const field = TEMPLATE_FIELDS.find(candidate => candidate.type === file.extension.toLowerCase());
		if (!field) return false;
		const resolved = this.resolveRule(file.parent, field);
		const values = ruleValues(resolved.rule);
		if (!values) return false;
		const templatePath = this.resolveTemplatePath(values.templatePath, resolved.folderOverrideMode);
		if (!templatePath || file.path === templatePath) return false;

		let changed = false;
		if (values.applyFilenameConvention && values.prefix) {
			const prefixedPath = this.prefixedPath(file, values);
			if (prefixedPath !== file.path) {
				await this.plugin.app.fileManager.renameFile(file, prefixedPath);
				changed = true;
			}
		}
		const template = this.plugin.app.vault.getFileByPath(templatePath);
		if (!template) return changed;
		const contents = await this.plugin.app.vault.readBinary(template);
		await this.plugin.app.vault.modifyBinary(file, contents);
		return true;
	}

	private resolveRule(folder: TFolder, field: TemplateField): { rule: TemplateRule; folderOverrideMode: boolean | null } {
		const values = this.folderValues(folder);
		const rule = readManagedRule(values, field);
		if (rule !== undefined) return { rule, folderOverrideMode: readManagedBoolean(values, PATH_MODE_FIELD) ?? true };
		const parentRule = folder.parent && !folder.parent.isRoot()
			? this.resolveRule(folder.parent, field)
			: this.globalRule(field);
		if (field.type === 'md' && hasLegacyMarkdownValues(values)) return mergeLegacyMarkdownRule(parentRule, values);
		return parentRule;
	}

	private globalRule(field: TemplateField): { rule: TemplateRule; folderOverrideMode: null } {
		const rootRule = readManagedRule(this.plugin.vaultConfig?.values ?? {}, field);
		return { rule: rootRule ?? this.plugin.settings[field.setting], folderOverrideMode: null };
	}

	private globalTemplateFolder(): string {
		const values = this.plugin.vaultConfig?.values ?? {};
		return sanitizeVaultPath(readManagedString(values, 'template-folder') ?? this.plugin.settings.templateFolder);
	}

	private resolveTemplatePath(path: string, folderOverrideMode: boolean | null): string {
		const clean = sanitizeVaultPath(path);
		if (!clean) return '';
		const folder = this.globalTemplateFolder();
		const shouldAnchor = folderOverrideMode === true || (folderOverrideMode === null && !clean.includes('/'));
		return normalizePath(shouldAnchor && folder ? `${folder}/${clean}` : clean);
	}

	private async ensureTemplateFile(path: string, type: TemplateFileType): Promise<void> {
		if (!path || this.plugin.app.vault.getAbstractFileByPath(path)) return;
		const segments = path.split('/');
		segments.pop();
		let folder = '';
		for (const segment of segments) {
			folder = folder ? `${folder}/${segment}` : segment;
			if (!this.plugin.app.vault.getAbstractFileByPath(folder)) await this.plugin.app.vault.createFolder(folder);
		}
		const contents = type === 'canvas' ? '{"nodes":[],"edges":[]}\n' : type === 'base' ? 'views: []\n' : '';
		await this.plugin.app.vault.create(path, contents);
	}

	private folderValues(folder: TFolder): Record<string, unknown> {
		const path = `${folder.path}/${this.plugin.settings.configFileBaseName}.md`;
		const cached = this.writtenFrontmatter.get(path);
		if (cached) return cached;
		const file = this.plugin.app.vault.getFileByPath(path);
		return file ? this.plugin.app.metadataCache.getFileCache(file)?.frontmatter ?? {} : {};
	}

	private isConfigNote(file: TFile): boolean { return file.extension === 'md' && file.basename === this.plugin.settings.configFileBaseName; }

	private prefixedPath(file: TFile, values: TemplateRuleValues): string {
		const date = this.now();
		const dateToken = formatDate(date, values.dateFormat, false);
		const firstPrefix = sanitizeFilenamePart(values.prefix.replaceAll('{{date}}', dateToken));
		const firstPath = siblingPath(file, `${firstPrefix}${file.name}`);
		const dateOnlyCollision = values.prefix.includes('{{date}}') && values.dateFormat !== ''
			&& !hasTimeTokens(values.dateFormat)
			&& file.parent?.children.some(child => child !== file && child.name.startsWith(firstPrefix));
		if (!dateOnlyCollision && isAvailablePath(this.plugin.app, file, firstPath)) return firstPath;

		const timedToken = formatDate(date, values.dateFormat, true);
		const timedPrefix = sanitizeFilenamePart(values.prefix.replaceAll('{{date}}', timedToken));
		const timedName = `${timedPrefix}${file.name}`;
		let candidate = siblingPath(file, timedName);
		if (isAvailablePath(this.plugin.app, file, candidate)) return candidate;
		for (let index = 2; ; index++) {
			candidate = siblingPath(file, appendFilenameSuffix(timedName, `-${index}`));
			if (isAvailablePath(this.plugin.app, file, candidate)) return candidate;
		}
	}
}

function readManagedRule(values: Record<string, unknown>, field: TemplateField): TemplateRule | undefined {
	const prefixed = `book-tabs-${field.frontmatter}`;
	if (Object.prototype.hasOwnProperty.call(values, prefixed)) return values[prefixed] === null ? undefined : normalizeRule(values[prefixed], field.type);
	if (Object.prototype.hasOwnProperty.call(values, field.frontmatter)) return normalizeRule(values[field.frontmatter], field.type);
	if (Object.prototype.hasOwnProperty.call(values, field.setting)) return normalizeRule(values[field.setting], field.type);
	return undefined;
}

function readManagedString(values: Record<string, unknown>, key: string): string | undefined {
	const prefixed = `book-tabs-${key}`;
	if (Object.prototype.hasOwnProperty.call(values, prefixed)) return typeof values[prefixed] === 'string' ? values[prefixed] : undefined;
	return typeof values[key] === 'string' ? values[key] : undefined;
}

function readManagedBoolean(values: Record<string, unknown>, key: string): boolean | undefined {
	for (const candidate of [`book-tabs-${key}`, key]) {
		const value = values[candidate];
		if (typeof value === 'boolean') return value;
	}
	return undefined;
}

function hasLegacyMarkdownValues(values: Record<string, unknown>): boolean {
	return LEGACY_FIELDS.some(key => readManagedString(values, key) !== undefined);
}

function mergeLegacyMarkdownRule(
	inherited: { rule: TemplateRule; folderOverrideMode: boolean | null },
	values: Record<string, unknown>,
): { rule: TemplateRule; folderOverrideMode: boolean | null } {
	const path = readManagedString(values, 'template-file-path');
	const date = readManagedString(values, 'template-file-date');
	const prefix = readManagedString(values, 'template-file-prefix');
	const applied = readManagedString(values, 'template-file-applied-To') ?? readManagedString(values, 'template-file-applied-to');
	if (applied !== undefined && !applied.split(/[\s,]+/).map(value => value.replace(/^\./, '').toLowerCase()).some(value => value === 'md' || value === '*')) {
		return { rule: {}, folderOverrideMode: path !== undefined ? false : inherited.folderOverrideMode };
	}
	const base = ruleValues(inherited.rule);
	const templatePath = path ?? base?.templatePath ?? '';
	if (!templatePath.toLowerCase().endsWith('.md')) return { rule: {}, folderOverrideMode: path !== undefined ? false : inherited.folderOverrideMode };
	return {
		rule: { [templatePath]: [date ?? base?.dateFormat ?? '', prefix ?? base?.prefix ?? '', true] },
		folderOverrideMode: path !== undefined ? false : inherited.folderOverrideMode,
	};
}

function removeManagedValue(values: Record<string, unknown>, field: TemplateField, ownedPlainKeys: ReadonlySet<string>, suppressPlainFallback: boolean): void {
	const prefixed = `book-tabs-${field.frontmatter}`;
	delete values[prefixed];
	if (ownedPlainKeys.has(field.frontmatter)) delete values[field.frontmatter];
	else if (suppressPlainFallback && Object.prototype.hasOwnProperty.call(values, field.frontmatter)) values[prefixed] = null;
	if (ownedPlainKeys.has(field.setting)) delete values[field.setting];
}

function removeManagedBoolean(values: Record<string, unknown>, key: string, ownedPlainKeys: ReadonlySet<string>): void {
	const prefixed = `book-tabs-${key}`;
	delete values[prefixed];
	if (ownedPlainKeys.has(key)) delete values[key];
	else if (Object.prototype.hasOwnProperty.call(values, key)) values[prefixed] = null;
}

function normalizeRule(value: unknown, type: TemplateFileType): TemplateRule {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
	const entry = Object.entries(value as Record<string, unknown>)[0];
	if (!entry) return {};
	const path = sanitizeVaultPath(entry[0]);
	const tuple = entry[1];
	if (!path || !path.toLowerCase().endsWith(`.${type}`) || !Array.isArray(tuple)
		|| typeof tuple[0] !== 'string' || typeof tuple[1] !== 'string' || typeof tuple[2] !== 'boolean') return {};
	return { [path]: [tuple[0].trim(), tuple[1], tuple[2]] };
}

function validateRule(rule: TemplateRule, type: TemplateFileType): void {
	const entries = Object.entries(rule);
	if (!entries.length) return;
	if (entries.length !== 1 || !Object.keys(normalizeRule(rule, type)).length) {
		throw new Error(`Enter one vault-relative .${type} template path without .. segments.`);
	}
}

export function makeTemplateRule(values: TemplateRuleValues, type: TemplateFileType): TemplateRule {
	const path = sanitizeVaultPath(values.templatePath);
	if (!path && !values.dateFormat && !values.prefix) return {};
	if (!path || !path.toLowerCase().endsWith(`.${type}`)) throw new Error(`The ${type} template path must end in .${type}.`);
	return { [path]: [values.dateFormat.trim(), values.prefix, values.applyFilenameConvention] };
}

export function ruleValues(rule: TemplateRule): TemplateRuleValues | null {
	const entry = Object.entries(rule)[0];
	if (!entry) return null;
	const tuple = entry[1];
	return { templatePath: entry[0], dateFormat: tuple[0], prefix: tuple[1], applyFilenameConvention: tuple[2] };
}

function sanitizeVaultPath(value: string): string {
	const normalized = value.replace(/\\/g, '/').trim();
	if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return '';
	const clean = normalized.replace(/^\.\//, '').replace(/\/+$/g, '');
	return clean && !clean.split('/').some(segment => segment === '..' || segment === '.') ? clean : '';
}

function formatDate(date: Date, pattern: string, includeTime: boolean): string {
	if (!pattern.trim()) return '';
	const rendered = replaceDateTokens(pattern.trim(), date);
	if (!includeTime || hasTimeTokens(pattern)) return rendered;
	return `${rendered}_at_${replaceDateTokens('HH-mm', date)}`;
}

function hasTimeTokens(pattern: string): boolean { return /H{1,2}|h{1,2}|m{1,2}|s{1,2}/.test(pattern); }
function replaceDateTokens(pattern: string, date: Date): string {
	const values: Record<string, string> = {
		YYYY: String(date.getFullYear()), YY: String(date.getFullYear()).slice(-2),
		MM: String(date.getMonth() + 1).padStart(2, '0'), DD: String(date.getDate()).padStart(2, '0'),
		HH: String(date.getHours()).padStart(2, '0'), mm: String(date.getMinutes()).padStart(2, '0'), ss: String(date.getSeconds()).padStart(2, '0'),
	};
	return pattern.replace(/YYYY|YY|MM|DD|HH|mm|ss/g, token => values[token] ?? token);
}
function sanitizeFilenamePart(value: string): string { return value.replace(INVALID_FILENAME_CHARACTERS, '-'); }
function siblingPath(file: TFile, name: string): string { return normalizePath(file.parent?.isRoot() ? name : `${file.parent?.path ?? ''}/${name}`); }
function isAvailablePath(app: App, file: TFile, path: string): boolean { const existing = app.vault.getAbstractFileByPath(path); return existing === null || existing === file; }
function appendFilenameSuffix(name: string, suffix: string): string { const dot = name.lastIndexOf('.'); return dot > 0 ? `${name.slice(0, dot)}${suffix}${name.slice(dot)}` : `${name}${suffix}`; }
