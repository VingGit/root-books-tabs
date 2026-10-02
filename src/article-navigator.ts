import type { App, TFile } from 'obsidian';

export const DEFAULT_ARTICLE_NAVIGATOR_KEYS: ArticleNavigatorKeys = {
	previousKey: 'PreviousArticle',
	nextKey: 'NextArticle',
	seeAlsoKey: 'SeeAlso',
};

export interface ArticleNavigatorKeys {
	previousKey: string;
	nextKey: string;
	seeAlsoKey: string;
}

export interface ResolvedArticleNavigatorKeys {
	keys: ArticleNavigatorKeys;
	source: 'stored' | 'article-navigator';
}

export interface ArticleBlacklist {
	exactPaths: ReadonlySet<string>;
	patterns: readonly RegExp[];
	invalidPatterns: readonly string[];
	matches(path: string): boolean;
}

export type ArticlePropertyKind = 'previous' | 'next' | 'see-also';
export type ArticleMutationMode = 'if-missing' | 'replace';

export interface ArticlePropertyMutation {
	kind: ArticlePropertyKind;
	key: string;
	before: unknown;
	after: unknown;
	mode: ArticleMutationMode;
}

export interface ArticleFileMutation {
	file: TFile;
	changes: ArticlePropertyMutation[];
}

export interface ArticlePropertyConflict {
	file: TFile;
	kind: 'previous' | 'next';
	key: string;
	before: unknown;
	after: string;
}

export interface ArticleMutationPlan {
	kind: 'generate-missing' | 'populate-navigation';
	files: ArticleFileMutation[];
	conflicts: ArticlePropertyConflict[];
	skippedBlacklisted: TFile[];
}

export interface GenerateMissingOptions {
	folderPath?: string | null;
	blacklist?: ArticleBlacklist;
}

export interface PopulateNavigationOptions {
	blacklist?: ArticleBlacklist;
}

export interface ApplyArticlePlanResult {
	filesUpdated: number;
	propertiesWritten: number;
	staleChangesSkipped: ArticlePropertyMutation[];
}

type FrontmatterReader = (file: TFile) => Readonly<Record<string, unknown>> | null | undefined;
type ArticleLinkBuilder = (from: TFile, target: TFile) => string;

/**
 * Read Article Navigator's live key settings without taking a runtime dependency
 * on the plugin or mutating its state. Obsidian does not expose its plugin
 * registry as public API, so every level is feature-detected and failure is a
 * normal "not available" result.
 */
export function readLiveArticleNavigatorKeys(app: App): ArticleNavigatorKeys | null {
	const internal = app as unknown as {
		plugins?: { plugins?: Record<string, unknown> };
	};
	const candidate = internal.plugins?.plugins?.['article-navigator'];
	if (!isRecord(candidate) || !isRecord(candidate.settings)) return null;
	return normalizeCompleteKeys(candidate.settings);
}

/** Resolve an atomic, distinct key triplet. Partial or invalid live settings never leak into stored configuration. */
export function resolveArticleNavigatorKeys(
	stored: Partial<ArticleNavigatorKeys> | null | undefined,
	live: ArticleNavigatorKeys | null = null,
	preferLive = false,
): ResolvedArticleNavigatorKeys {
	const storedKeys = normalizeStoredKeys(stored);
	const liveKeys = preferLive ? normalizeCompleteKeys(live) : null;
	return liveKeys
		? { keys: liveKeys, source: 'article-navigator' }
		: { keys: storedKeys, source: 'stored' };
}

/**
 * Compile one rule per line. Plain lines are exact vault paths; an exact folder
 * path also excludes its descendants. Regex rules use `/pattern/flags` or
 * `regex:pattern`. Invalid regex rules are reported and never match.
 */
export function compileArticleBlacklist(input: string | readonly string[]): ArticleBlacklist {
	const lines = typeof input === 'string' ? input.split(/\r?\n/) : input;
	const exactPaths = new Set<string>();
	const patterns: RegExp[] = [];
	const invalidPatterns: string[] = [];

	for (const raw of lines) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const regex = parseRegexRule(line);
		if (regex.kind === 'valid') patterns.push(regex.pattern);
		else if (regex.kind === 'invalid') invalidPatterns.push(line);
		else {
			const path = normalizeVaultPath(line);
			if (path) exactPaths.add(path);
		}
	}

	return {
		exactPaths,
		patterns,
		invalidPatterns,
		matches(path: string): boolean {
			const normalized = normalizeVaultPath(path);
			for (const exact of exactPaths) {
				if (normalized === exact || normalized.startsWith(`${exact}/`)) return true;
			}
			for (const pattern of patterns) {
				pattern.lastIndex = 0;
				if (pattern.test(normalized)) return true;
			}
			return false;
		},
	};
}

/** Create an idempotent plan that adds only absent keys. Existing SeeAlso values are never replaced. */
export function planMissingArticleProperties(
	files: readonly TFile[],
	readFrontmatter: FrontmatterReader,
	keys: ArticleNavigatorKeys,
	options: GenerateMissingOptions = {},
): ArticleMutationPlan {
	const plan = emptyPlan('generate-missing');
	const folderPath = options.folderPath == null ? null : normalizeVaultPath(options.folderPath);
	for (const file of uniqueMarkdownFiles(files)) {
		if (folderPath !== null && !isInFolder(file.path, folderPath)) continue;
		if (options.blacklist?.matches(file.path)) {
			plan.skippedBlacklisted.push(file);
			continue;
		}
		const frontmatter = readFrontmatter(file) ?? {};
		const changes: ArticlePropertyMutation[] = [];
		addMissingMutation(changes, frontmatter, 'previous', keys.previousKey, '');
		addMissingMutation(changes, frontmatter, 'next', keys.nextKey, '');
		addMissingMutation(changes, frontmatter, 'see-also', keys.seeAlsoKey, []);
		if (changes.length > 0) plan.files.push({ file, changes });
	}
	return plan;
}

/**
 * Plan Previous/Next values for an already ordered note list. Blacklisted notes
 * are removed from the sequence, so neighboring eligible notes link across them.
 */
export function planArticleNavigation(
	orderedNotes: readonly TFile[],
	readFrontmatter: FrontmatterReader,
	keys: ArticleNavigatorKeys,
	buildLink: ArticleLinkBuilder,
	options: PopulateNavigationOptions = {},
): ArticleMutationPlan {
	const plan = emptyPlan('populate-navigation');
	const eligible: TFile[] = [];
	for (const file of uniqueMarkdownFiles(orderedNotes)) {
		if (options.blacklist?.matches(file.path)) plan.skippedBlacklisted.push(file);
		else eligible.push(file);
	}

	for (let index = 0; index < eligible.length; index++) {
		const file = eligible[index]!;
		const previous = eligible[index - 1];
		const next = eligible[index + 1];
		const desired = [
			{ kind: 'previous' as const, key: keys.previousKey, value: previous ? buildLink(file, previous) : '' },
			{ kind: 'next' as const, key: keys.nextKey, value: next ? buildLink(file, next) : '' },
		];
		const frontmatter = readFrontmatter(file) ?? {};
		const changes: ArticlePropertyMutation[] = [];
		for (const property of desired) {
			const before = frontmatter[property.key];
			if (sameValue(before, property.value)) continue;
			changes.push({
				kind: property.kind,
				key: property.key,
				before,
				after: property.value,
				mode: 'replace',
			});
			if (!isEmptyArticleValue(before)) {
				plan.conflicts.push({
					file,
					kind: property.kind,
					key: property.key,
					before,
					after: property.value,
				});
			}
		}
		if (changes.length > 0) plan.files.push({ file, changes });
	}
	return plan;
}

/** Build the same form of wikilink Article Navigator writes for reciprocal links. */
export function createArticleWikilink(app: App, from: TFile, target: TFile): string {
	const linktext = app.metadataCache.fileToLinktext(target, from.path, true);
	return `[[${linktext}]]`;
}

/** Apply a reviewed plan once per file, skipping properties that changed after planning. */
export async function applyArticleMutationPlan(app: App, plan: ArticleMutationPlan): Promise<ApplyArticlePlanResult> {
	const result: ApplyArticlePlanResult = {
		filesUpdated: 0,
		propertiesWritten: 0,
		staleChangesSkipped: [],
	};
	for (const filePlan of plan.files) {
		let writtenInFile = 0;
		await app.fileManager.processFrontMatter(filePlan.file, (raw) => {
			const frontmatter = raw as Record<string, unknown>;
			for (const change of filePlan.changes) {
				if (change.mode === 'if-missing') {
					if (hasOwn(frontmatter, change.key)) continue;
				} else if (!sameValue(frontmatter[change.key], change.before)) {
					result.staleChangesSkipped.push(change);
					continue;
				}
				frontmatter[change.key] = cloneDefaultValue(change.after);
				writtenInFile++;
			}
		});
		if (writtenInFile > 0) result.filesUpdated++;
		result.propertiesWritten += writtenInFile;
	}
	return result;
}

/** Public-API facade used by settings actions and future integration UI. */
export class ArticleNavigatorIntegration {
	constructor(private readonly app: App) {}

	resolveKeys(stored?: Partial<ArticleNavigatorKeys> | null, preferLive = false): ResolvedArticleNavigatorKeys {
		return resolveArticleNavigatorKeys(stored, readLiveArticleNavigatorKeys(this.app), preferLive);
	}

	planGenerateMissing(keys: ArticleNavigatorKeys, options: GenerateMissingOptions = {}): ArticleMutationPlan {
		return planMissingArticleProperties(
			this.app.vault.getMarkdownFiles(),
			(file) => this.readFrontmatter(file),
			keys,
			options,
		);
	}

	planPopulation(
		orderedNotes: readonly TFile[],
		keys: ArticleNavigatorKeys,
		options: PopulateNavigationOptions = {},
	): ArticleMutationPlan {
		return planArticleNavigation(
			orderedNotes,
			(file) => this.readFrontmatter(file),
			keys,
			(from, target) => createArticleWikilink(this.app, from, target),
			options,
		);
	}

	apply(plan: ArticleMutationPlan): Promise<ApplyArticlePlanResult> {
		return applyArticleMutationPlan(this.app, plan);
	}

	private readFrontmatter(file: TFile): Readonly<Record<string, unknown>> {
		return this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
	}
}

function normalizeStoredKeys(stored: Partial<ArticleNavigatorKeys> | null | undefined): ArticleNavigatorKeys {
	const keys: ArticleNavigatorKeys = {
		previousKey: normalizeKey(stored?.previousKey) ?? DEFAULT_ARTICLE_NAVIGATOR_KEYS.previousKey,
		nextKey: normalizeKey(stored?.nextKey) ?? DEFAULT_ARTICLE_NAVIGATOR_KEYS.nextKey,
		seeAlsoKey: normalizeKey(stored?.seeAlsoKey) ?? DEFAULT_ARTICLE_NAVIGATOR_KEYS.seeAlsoKey,
	};
	return keysAreDistinct(keys) ? keys : { ...DEFAULT_ARTICLE_NAVIGATOR_KEYS };
}

function normalizeCompleteKeys(candidate: unknown): ArticleNavigatorKeys | null {
	if (!isRecord(candidate)) return null;
	const previousKey = normalizeKey(candidate.previousKey);
	const nextKey = normalizeKey(candidate.nextKey);
	const seeAlsoKey = normalizeKey(candidate.seeAlsoKey);
	if (!previousKey || !nextKey || !seeAlsoKey) return null;
	const keys = { previousKey, nextKey, seeAlsoKey };
	return keysAreDistinct(keys) ? keys : null;
}

function normalizeKey(value: unknown): string | null {
	return typeof value === 'string' && value.trim() && value.trim() !== 'book-tabs' ? value.trim() : null;
}

function keysAreDistinct(keys: ArticleNavigatorKeys): boolean {
	return new Set([keys.previousKey, keys.nextKey, keys.seeAlsoKey]).size === 3;
}

function parseRegexRule(line: string):
	| { kind: 'exact' }
	| { kind: 'valid'; pattern: RegExp }
	| { kind: 'invalid' } {
	let source: string | null = null;
	let flags = '';
	if (line.startsWith('regex:')) source = line.slice('regex:'.length);
	else if (line.startsWith('/')) {
		const finalSlash = line.lastIndexOf('/');
		if (finalSlash <= 0) return { kind: 'invalid' };
		source = line.slice(1, finalSlash);
		flags = line.slice(finalSlash + 1);
	}
	if (source === null) return { kind: 'exact' };
	try {
		return { kind: 'valid', pattern: new RegExp(source, flags) };
	} catch {
		return { kind: 'invalid' };
	}
}

function normalizeVaultPath(path: string): string {
	return path.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '');
}

function isInFolder(filePath: string, folderPath: string): boolean {
	const normalized = normalizeVaultPath(filePath);
	return folderPath === '' || normalized.startsWith(`${folderPath}/`);
}

function uniqueMarkdownFiles(files: readonly TFile[]): TFile[] {
	const seen = new Set<string>();
	const result: TFile[] = [];
	for (const file of files) {
		if (file.extension.toLowerCase() !== 'md' || seen.has(file.path)) continue;
		seen.add(file.path);
		result.push(file);
	}
	return result;
}

function emptyPlan(kind: ArticleMutationPlan['kind']): ArticleMutationPlan {
	return { kind, files: [], conflicts: [], skippedBlacklisted: [] };
}

function addMissingMutation(
	changes: ArticlePropertyMutation[],
	frontmatter: Readonly<Record<string, unknown>>,
	kind: ArticlePropertyKind,
	key: string,
	after: unknown,
): void {
	if (hasOwn(frontmatter, key)) return;
	changes.push({ kind, key, before: undefined, after, mode: 'if-missing' });
}

function hasOwn(value: Readonly<Record<string, unknown>>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

function isEmptyArticleValue(value: unknown): boolean {
	return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

function sameValue(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (Array.isArray(left) && Array.isArray(right)) {
		return left.length === right.length && left.every((value, index) => sameValue(value, right[index]));
	}
	if (isRecord(left) && isRecord(right)) {
		const leftKeys = Object.keys(left), rightKeys = Object.keys(right);
		return leftKeys.length === rightKeys.length
			&& leftKeys.every((key) => hasOwn(right, key) && sameValue(left[key], right[key]));
	}
	return false;
}

function cloneDefaultValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(cloneDefaultValue);
	if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneDefaultValue(entry)]));
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
