import { normalizePath, TFile, TFolder, type App } from 'obsidian';
import { updateConfigFrontmatter } from './config-frontmatter';
import { formatDatePattern, hasTimeTokens } from './date-pattern';
import type { TemplateFileType, TemplateRule } from './types';

export interface FolderTemplateConfig {
	templateFolder: string;
	templateDateFormat: string;
	templateMd: TemplateRule;
	templateCanvas: TemplateRule;
	templateBase: TemplateRule;
}

export interface FolderTemplateOverrides {
	templatePathsUnderGlobalFolder?: boolean;
	templateDateFormat?: string;
	templateExcludedSubfolders?: string[];
	templateMd?: TemplateRule;
	templateCanvas?: TemplateRule;
	templateBase?: TemplateRule;
}

export interface TemplateRuleValues {
	templatePath: string;
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
const DATE_FORMAT_FIELD = 'template-date-format';
const EXCLUDED_SUBFOLDERS_FIELD = 'template-excluded-subfolders';
const LEGACY_FIELDS = ['template-file-prefix', 'template-file-date', 'template-file-path', 'template-file-applied-To', 'template-file-applied-to'] as const;
const INVALID_FILENAME_CHARACTERS = /[\\/:*?"<>|]/g;

/** Resolves portable per-type template rules and applies them to newly created vault files. */
export class FolderTemplateService {
	private readonly writtenFrontmatter = new Map<string, Record<string, unknown>>();
	private readonly skipCreatedPaths = new Set<string>();

	constructor(
		private readonly plugin: FolderTemplatePlugin,
		private readonly now: () => Date = () => new Date(),
	) {}

	resolveForFolder(folder: TFolder): FolderTemplateConfig {
		return {
			templateFolder: this.globalTemplateFolder(),
			templateDateFormat: this.resolveDateFormat(folder),
			...Object.fromEntries(TEMPLATE_FIELDS.map(field => [field.setting, this.resolveRule(folder, field).rule])),
		} as FolderTemplateConfig;
	}

	readFolderOverrides(folder: TFolder): FolderTemplateOverrides {
		const values = this.folderValues(folder);
		const overrides: FolderTemplateOverrides = {};
		const pathMode = readManagedBoolean(values, PATH_MODE_FIELD);
		if (pathMode !== undefined) overrides.templatePathsUnderGlobalFolder = pathMode;
		const dateFormat = readManagedString(values, DATE_FORMAT_FIELD);
		const legacyDate = legacyDateFromRules(values);
		if (dateFormat?.trim() || legacyDate) overrides.templateDateFormat = dateFormat?.trim() || legacyDate;
		const excluded = readManagedStringArray(values, EXCLUDED_SUBFOLDERS_FIELD);
		if (excluded !== undefined) overrides.templateExcludedSubfolders = excluded;
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
			.filter(({ overrides }) => TEMPLATE_FIELDS.some(field => overrides[field.setting] !== undefined)
				|| overrides.templateDateFormat !== undefined || overrides.templateExcludedSubfolders !== undefined)
			.sort((left, right) => left.folder.path.localeCompare(right.folder.path))
			.map(({ folder, overrides }) => ({ folder, overrides, effective: this.resolveForFolder(folder) }));
	}

	async writeFolderOverrides(folder: TFolder, overrides: FolderTemplateOverrides): Promise<TFile> {
		const templateFiles: { path: string; type: TemplateFileType; legacyPath?: string }[] = [];
		for (const field of TEMPLATE_FIELDS) {
			const rule = overrides[field.setting];
			if (rule === undefined) continue;
			validateRule(rule, field.type);
			const values = ruleValues(rule);
			if (!values) continue;
			const error = this.validateTemplatePath(values.templatePath, field.type, folder, overrides.templatePathsUnderGlobalFolder ?? true);
			if (error) throw new Error(error);
			const bookRelative = overrides.templatePathsUnderGlobalFolder ?? true;
			templateFiles.push({
				path: this.previewTemplatePath(values.templatePath, folder, bookRelative),
				type: field.type,
				legacyPath: bookRelative ? this.legacyOverrideTemplatePath(values.templatePath) : undefined,
			});
		}
		for (const template of templateFiles) await this.ensureTemplateFile(template.path, template.type, template.legacyPath);
		const file = await this.plugin.bookOrder.ensureConfig(folder);
		await updateConfigFrontmatter(this.plugin.app, file, (frontmatter, context) => {
			for (const field of TEMPLATE_FIELDS) {
				const value = overrides[field.setting];
				removeManagedValue(frontmatter, field, context.ownedPlainKeys, value === undefined);
				if (value !== undefined) frontmatter[`book-tabs-${field.frontmatter}`] = structuredClone(value);
			}
			removeManagedBoolean(frontmatter, PATH_MODE_FIELD, context.ownedPlainKeys);
			frontmatter[`book-tabs-${PATH_MODE_FIELD}`] = overrides.templatePathsUnderGlobalFolder ?? true;
			removeManagedBoolean(frontmatter, DATE_FORMAT_FIELD, context.ownedPlainKeys);
			if (overrides.templateDateFormat?.trim()) frontmatter[`book-tabs-${DATE_FORMAT_FIELD}`] = overrides.templateDateFormat.trim();
			removeManagedBoolean(frontmatter, EXCLUDED_SUBFOLDERS_FIELD, context.ownedPlainKeys);
			if (overrides.templateExcludedSubfolders !== undefined) frontmatter[`book-tabs-${EXCLUDED_SUBFOLDERS_FIELD}`] = sanitizeExcludedSubfolders(overrides.templateExcludedSubfolders);
			for (const legacy of LEGACY_FIELDS) removeManagedBoolean(frontmatter, legacy, context.ownedPlainKeys);
			this.writtenFrontmatter.set(file.path, { ...frontmatter });
		});
		return file;
	}

	previewTemplatePath(path: string, folder: TFolder | null, pathsUnderGlobalFolder = true): string {
		return this.resolveTemplatePath(path, folder ? pathsUnderGlobalFolder : null, folder?.path.split('/')[0]);
	}

	validateTemplatePath(path: string, type: TemplateFileType, folder: TFolder | null, pathsUnderGlobalFolder = true): string | null {
		const clean = sanitizeVaultPath(path);
		if (!clean || !clean.toLowerCase().endsWith(`.${type}`)) return `Enter a valid .${type} template path without . or .. segments.`;
		if (clean.split('/').some(segment => /[\\:*?"<>|]/.test(segment) || !segment)) return 'Rename the template to remove invalid filename characters.';
		const configName = `${this.plugin.settings.configFileBaseName}.md`;
		if (clean.split('/').some(segment => segment.toLowerCase() === configName.toLowerCase())) return `Rename the template file or folder: ${configName} is reserved for book config notes.`;
		const resolved = this.previewTemplatePath(clean, folder, pathsUnderGlobalFolder);
		const segments = resolved.split('/');
		if (segments.some(segment => segment.toLowerCase() === configName.toLowerCase())) return `Rename the template file or folder: ${configName} is reserved for book config notes.`;
		for (let index = 1; index <= segments.length; index++) {
			const candidate = segments.slice(0, index).join('/');
			const existing = this.plugin.app.vault.getAbstractFileByPath(candidate);
			if (index < segments.length && existing instanceof TFile) return `Rename the template or its parent path: ${candidate} is already a file.`;
			if (index < segments.length && /\.(?:md|canvas|base)$/i.test(segments[index - 1] ?? '')) return `Rename the parent folder: ${candidate} looks like a template file.`;
			if (index === segments.length && existing instanceof TFolder) return `Rename the template: ${candidate} is already a folder.`;
		}
		return null;
	}

	validateTemplateFolder(path: string): string | null {
		if (!path.trim()) return null;
		const clean = sanitizeVaultPath(path);
		if (!clean) return 'Choose a vault-relative template folder without . or .. segments.';
		const segments = clean.split('/');
		if (segments.some(segment => /[\\:*?"<>|]/.test(segment) || !segment)) return 'Rename the template folder to remove invalid filename characters.';
		if (segments.some(segment => segment.toLowerCase() === `${this.plugin.settings.configFileBaseName}.md`.toLowerCase()
			|| /\.(?:md|canvas|base)$/i.test(segment))) return 'Choose a folder path, not a Markdown, Canvas, Base, or book config-note filename.';
		for (let index = 1; index <= segments.length; index++) {
			const candidate = segments.slice(0, index).join('/');
			if (this.plugin.app.vault.getAbstractFileByPath(candidate) instanceof TFile) return `Choose another template folder: ${candidate} is already a file.`;
		}
		return null;
	}

	suggestShorterOverridePath(path: string, folder: TFolder): string | null {
		const clean = sanitizeVaultPath(path);
		const folderName = folder.path.split('/')[0];
		const base = this.globalTemplateFolder();
		const prefix = base && folderName ? `${base}/${folderName}/` : '';
		return prefix && clean.toLowerCase().startsWith(prefix.toLowerCase()) ? clean.slice(prefix.length) : null;
	}

	refresh(file: TFile): void { this.writtenFrontmatter.delete(file.path); }

	async handleCreate(file: TFile): Promise<boolean> {
		if (this.skipCreatedPaths.delete(file.path)) return false;
		if (!file.parent || !this.plugin.scopeResolver.resolveFile(file) || this.isConfigNote(file)) return false;
		if (this.isTemplateExcluded(file.parent)) return false;
		const field = TEMPLATE_FIELDS.find(candidate => candidate.type === file.extension.toLowerCase());
		if (!field) return false;
		const resolved = this.resolveRule(file.parent, field);
		const values = ruleValues(resolved.rule);
		if (!values) return false;
		const ruleFolder = resolved.folderOverrideMode === null ? null : file.parent;
		if (this.validateTemplatePath(values.templatePath, field.type, ruleFolder, resolved.folderOverrideMode ?? true)) return false;
		let templatePath = this.resolveTemplatePath(values.templatePath, resolved.folderOverrideMode, file.parent.path.split('/')[0]);
		if (resolved.folderOverrideMode === true && !this.plugin.app.vault.getFileByPath(templatePath)) {
			const legacyPath = this.legacyOverrideTemplatePath(values.templatePath);
			if (this.plugin.app.vault.getFileByPath(legacyPath)) templatePath = legacyPath;
		}
		if (!templatePath || file.path === templatePath) return false;

		let changed = false;
		if (values.applyFilenameConvention && values.prefix) {
			const prefixedPath = this.prefixedPath(file, values, this.resolveDateFormat(file.parent));
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

	previewSuggestedMarkdownPath(folder: TFolder, requestedName: string): string {
		const base = sanitizeFilenamePart(requestedName.trim().replace(/\.md$/i, '')) || 'Untitled';
		let name = `${base}.md`;
		if (!this.isTemplateExcluded(folder)) {
			const values = ruleValues(this.resolveRule(folder, TEMPLATE_FIELDS[0]!).rule);
			if (values?.applyFilenameConvention && values.prefix) {
				const dateFormat = this.resolveDateFormat(folder);
				const initialToken = formatDatePattern(this.now(), dateFormat, false);
				const initialPrefix = sanitizeFilenamePart(values.prefix.replaceAll('{{date}}', initialToken));
				const collision = values.prefix.includes('{{date}}') && !hasTimeTokens(dateFormat)
					&& folder.children.some(child => child.name.startsWith(initialPrefix));
				const token = collision ? formatDatePattern(this.now(), dateFormat, true) : initialToken;
				name = `${sanitizeFilenamePart(values.prefix.replaceAll('{{date}}', token))}${name}`;
			}
		}
		let path = normalizePath(`${folder.path}/${name}`), suffix = 2;
		while (this.plugin.app.vault.getAbstractFileByPath(path)) path = normalizePath(`${folder.path}/${appendFilenameSuffix(name, `-${suffix++}`)}`);
		return path;
	}

	async createSuggestedMarkdown(folder: TFolder, requestedName: string): Promise<TFile> {
		const path = this.previewSuggestedMarkdownPath(folder, requestedName);
		this.skipCreatedPaths.add(path);
		let file: TFile;
		try { file = await this.plugin.app.vault.create(path, ''); }
		catch (error) { this.skipCreatedPaths.delete(path); throw error; }
		if (this.isTemplateExcluded(folder)) return file;
		const resolved = this.resolveRule(folder, TEMPLATE_FIELDS[0]!);
		const values = ruleValues(resolved.rule);
		if (!values) return file;
		let templatePath = this.resolveTemplatePath(values.templatePath, resolved.folderOverrideMode, folder.path.split('/')[0]);
		if (resolved.folderOverrideMode === true && !this.plugin.app.vault.getFileByPath(templatePath)) {
			const legacy = this.legacyOverrideTemplatePath(values.templatePath);
			if (this.plugin.app.vault.getFileByPath(legacy)) templatePath = legacy;
		}
		const template = this.plugin.app.vault.getFileByPath(templatePath);
		if (template) await this.plugin.app.vault.modifyBinary(file, await this.plugin.app.vault.readBinary(template));
		return file;
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

	dateFormatForFolder(folder: TFolder | null): string {
		return folder ? this.resolveDateFormat(folder) : this.globalDateFormat();
	}

	private resolveDateFormat(folder: TFolder): string {
		const values = this.folderValues(folder);
		const own = readManagedString(values, DATE_FORMAT_FIELD)?.trim() || legacyDateFromRules(values);
		if (own) return own;
		return folder.parent && !folder.parent.isRoot() ? this.resolveDateFormat(folder.parent) : this.globalDateFormat();
	}

	private globalDateFormat(): string {
		const values = this.plugin.vaultConfig?.values ?? {};
		return readManagedString(values, DATE_FORMAT_FIELD)?.trim() || legacyDateFromRules(values)
			|| this.plugin.settings.templateDateFormat || 'DD.MM.YYYY';
	}

	private isTemplateExcluded(folder: TFolder): boolean {
		let current: TFolder | null = folder;
		while (current && !current.isRoot()) {
			const excluded = readManagedStringArray(this.folderValues(current), EXCLUDED_SUBFOLDERS_FIELD);
			if (excluded?.length) {
				const relative = folder.path === current.path ? '' : folder.path.slice(current.path.length + 1);
				if (relative && excluded.some(path => relative === path || relative.startsWith(`${path}/`))) return true;
			}
			current = current.parent;
		}
		return false;
	}

	private resolveTemplatePath(path: string, folderOverrideMode: boolean | null, bookId?: string): string {
		const clean = sanitizeVaultPath(path);
		if (!clean) return '';
		const folder = this.globalTemplateFolder();
		if (folderOverrideMode === true && folder && bookId) return normalizePath(`${folder}/${bookId}/${clean}`);
		return normalizePath(folderOverrideMode === null && !clean.includes('/') && folder ? `${folder}/${clean}` : clean);
	}

	private legacyOverrideTemplatePath(path: string): string {
		const clean = sanitizeVaultPath(path);
		const folder = this.globalTemplateFolder();
		return clean ? normalizePath(folder ? `${folder}/${clean}` : clean) : '';
	}

	private async ensureTemplateFile(path: string, type: TemplateFileType, legacyPath?: string): Promise<void> {
		if (!path) return;
		const existing = this.plugin.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) return;
		if (existing) throw new Error(`Rename the template: ${path} is already a folder.`);
		const segments = path.split('/');
		segments.pop();
		let folder = '';
		for (const segment of segments) {
			folder = folder ? `${folder}/${segment}` : segment;
			const parent = this.plugin.app.vault.getAbstractFileByPath(folder);
			if (parent instanceof TFile) throw new Error(`Rename the template or its parent path: ${folder} is already a file.`);
			if (!parent) await this.plugin.app.vault.createFolder(folder);
		}
		const legacy = legacyPath && legacyPath !== path ? this.plugin.app.vault.getFileByPath(legacyPath) : null;
		const contents = legacy
			? await this.plugin.app.vault.read(legacy)
			: type === 'canvas' ? '{"nodes":[],"edges":[]}\n' : type === 'base' ? 'views: []\n' : '';
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

	private prefixedPath(file: TFile, values: TemplateRuleValues, dateFormat: string): string {
		const date = this.now();
		const dateToken = formatDatePattern(date, dateFormat, false);
		const firstPrefix = sanitizeFilenamePart(values.prefix.replaceAll('{{date}}', dateToken));
		const firstPath = siblingPath(file, `${firstPrefix}${file.name}`);
		const dateOnlyCollision = values.prefix.includes('{{date}}') && dateFormat !== ''
			&& !hasTimeTokens(dateFormat)
			&& file.parent?.children.some(child => child !== file && child.name.startsWith(firstPrefix));
		if (!dateOnlyCollision && isAvailablePath(this.plugin.app, file, firstPath)) return firstPath;

		const timedToken = formatDatePattern(date, dateFormat, true);
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

function readManagedStringArray(values: Record<string, unknown>, key: string): string[] | undefined {
	for (const candidate of [`book-tabs-${key}`, key]) {
		if (!Object.prototype.hasOwnProperty.call(values, candidate)) continue;
		return Array.isArray(values[candidate]) ? sanitizeExcludedSubfolders(values[candidate] as unknown[]) : [];
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
	const prefix = readManagedString(values, 'template-file-prefix');
	const applied = readManagedString(values, 'template-file-applied-To') ?? readManagedString(values, 'template-file-applied-to');
	if (applied !== undefined && !applied.split(/[\s,]+/).map(value => value.replace(/^\./, '').toLowerCase()).some(value => value === 'md' || value === '*')) {
		return { rule: {}, folderOverrideMode: path !== undefined ? false : inherited.folderOverrideMode };
	}
	const base = ruleValues(inherited.rule);
	const templatePath = path ?? base?.templatePath ?? '';
	if (!templatePath.toLowerCase().endsWith('.md')) return { rule: {}, folderOverrideMode: path !== undefined ? false : inherited.folderOverrideMode };
	return {
		rule: { [templatePath]: [prefix ?? base?.prefix ?? '', true] },
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
	if (!path || !path.toLowerCase().endsWith(`.${type}`) || !Array.isArray(tuple)) return {};
	if (typeof tuple[0] === 'string' && typeof tuple[1] === 'string' && typeof tuple[2] === 'boolean') return { [path]: [tuple[1], tuple[2]] };
	if (typeof tuple[0] !== 'string' || typeof tuple[1] !== 'boolean') return {};
	return { [path]: [tuple[0], tuple[1]] };
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
	if (!path && !values.prefix) return {};
	if (!path || !path.toLowerCase().endsWith(`.${type}`)) throw new Error(`The ${type} template path must end in .${type}.`);
	return { [path]: [values.prefix, values.applyFilenameConvention] };
}

export function ruleValues(rule: TemplateRule): TemplateRuleValues | null {
	const entry = Object.entries(rule)[0];
	if (!entry) return null;
	const tuple = entry[1] as unknown as unknown[];
	if (typeof tuple[1] === 'string') return { templatePath: entry[0], prefix: tuple[1], applyFilenameConvention: Boolean(tuple[2]) };
	return { templatePath: entry[0], prefix: typeof tuple[0] === 'string' ? tuple[0] : '', applyFilenameConvention: tuple[1] === true };
}

function sanitizeVaultPath(value: string): string {
	const normalized = value.replace(/\\/g, '/').trim();
	if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return '';
	const clean = normalized.replace(/^\.\//, '').replace(/\/+$/g, '');
	return clean && !clean.split('/').some(segment => segment === '..' || segment === '.') ? clean : '';
}

function legacyDateFromRules(values: Record<string, unknown>): string | undefined {
	for (const key of ['book-tabs-template-md', 'template-md', 'templateMd', 'book-tabs-template-canvas', 'template-canvas', 'templateCanvas', 'book-tabs-template-base', 'template-base', 'templateBase']) {
		const rule = values[key];
		if (!rule || typeof rule !== 'object' || Array.isArray(rule)) continue;
		const tuple = Object.values(rule as Record<string, unknown>)[0];
		if (Array.isArray(tuple) && typeof tuple[0] === 'string' && typeof tuple[1] === 'string' && tuple[0].trim()) return tuple[0].trim();
	}
	return readManagedString(values, 'template-file-date')?.trim() || undefined;
}

function sanitizeExcludedSubfolders(values: unknown[]): string[] {
	return [...new Set(values.filter((value): value is string => typeof value === 'string')
		.map(value => sanitizeVaultPath(value).replace(/^\/+|\/+$/g, ''))
		.filter(value => value.length > 0))];
}
function sanitizeFilenamePart(value: string): string { return value.replace(INVALID_FILENAME_CHARACTERS, '-'); }
function siblingPath(file: TFile, name: string): string { return normalizePath(file.parent?.isRoot() ? name : `${file.parent?.path ?? ''}/${name}`); }
function isAvailablePath(app: App, file: TFile, path: string): boolean { const existing = app.vault.getAbstractFileByPath(path); return existing === null || existing === file; }
function appendFilenameSuffix(name: string, suffix: string): string { const dot = name.lastIndexOf('.'); return dot > 0 ? `${name.slice(0, dot)}${suffix}${name.slice(dot)}` : `${name}${suffix}`; }
