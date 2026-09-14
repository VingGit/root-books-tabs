import type { App, TFile } from 'obsidian';

export const BOOK_TABS_FRONTMATTER_PREFIX = 'book-tabs-';

export interface ConfigFrontmatterContext {
	/** Plain keys carrying Root Books Tabs' generated help comment are safe to update in place. */
	ownedPlainKeys: ReadonlySet<string>;
}

const HELP: Record<string, string> = {
	isFreshClone: 'Open freshCloneOpeningPath once on next startup, then set this to false.',
	freshCloneOpeningPath: 'Vault-relative Markdown path or first-level book folder. Invalid paths preserve saved workspace; otherwise use the newest note.',
	fileOrder: 'Immediate child names in manual display order. The folder config note is omitted and pinned separately.',
	'creation-date': 'Creation timestamp for Markdown notes; other file types use their filesystem creation time. Format YY-MM-DD HH:mm:ss.SSS.',
	orderingEnabled: 'True after this book has been prepared for portable ordering.',
	orderingType: 'Book default sort: manual, alphabetical, or creation-date. The ordering button cycles these values.',
	forcedOrderingType: 'False inherits the book/parent order; manual, alphabetical, or creation-date forces this folder order.',
	tabInsertDirection: 'right opens beside the current tab; end appends. In a book config, false inherits the vault.',
	bookNoteOpenMode: 'same-tab, background-tab, or focused-tab. In a book config, false inherits the vault.',
	openBooksInExternalWindows: 'True opens new book groups in pop-outs; false uses the main window.',
	createBookIndex: 'True creates a config note when a first-level book folder is created.',
	hideNewBookIndex: 'True adds new book config notes to .obsidianignore. Requires the Ignore plugin for vault-wide hiding.',
	configFileBaseName: 'Per-book config filename without .md. Use settings to safely rename existing config notes.',
	colorFrontmatterProperty: 'Book color property name. Use settings to migrate existing color fields.',
	tabTextFrontmatterProperty: 'Background-style tab foreground property name; default tab-text-bg.',
	color: 'Optional #RRGGBB book color override. Remove to use the local automatic color.',
	'tab-text-bg': 'Background-style tab foreground: black, white, or CSS hex. Default white.',
	notifyMissingConfigFiles: 'True enables missing book config notifications.',
	showBookLabel: 'True shows a subtle book label above supported Obsidian file views.',
	colorTabs: 'True decorates tabs with their book color.',
	tabDecorationStyle: 'underline, background, dot, or custom. Foreground overrides apply only to background.',
	bookModeEnabled: 'True focuses the explorer on the selected book and other open books.',
	mainBookSwitchBehavior: 'close-previous closes the former main book; keep-open retains it below.',
	fileExplorerOpenBehavior: 'book-instance uses the matching book instance; current-group uses the focused group.',
	colorBookSwitcher: 'True colors book selector and temporary book bars.',
	newNoteLocation: 'current-folder or book-root; explicitly chosen destinations remain respected.',
	newFolderLocation: 'current-folder or book-root; explicitly chosen destinations remain respected.',
	bookSplitDirection: 'right, down, left, up, or grid for new book groups.',
	gridOverflowDirection: 'right, down, left, or up; later books halve each stable base cell in this direction.',
	gridRows: 'Number of grid rows, from 2 to 16. Fill rows before cycling all base cells.',
	gridColumns: 'Number of grid columns, from 2 to 16. Fill each row from left to right.',
	excludedBookFolders: 'First-level folder names excluded from book routing and automatic book config generation.',
	excludedFileGroupLocation: 'next-to-current opens one shared excluded-files group beside the active group; popout uses a separate window.',
	orderingDirection: 'descending shows newest date-sorted items first; ascending reverses the ordinary item order.',
	configNotePosition: 'top or bottom pins every folder config note outside fileOrder.',
	forceUpdateLinks: 'True keeps Obsidian automatic internal-link updates enabled.',
	'template-folder': 'Default vault folder for bare global template filenames and, by default, every folder override template.',
	'template-md': 'Markdown template mapping: template.md: [date format, prefix, apply filename convention]. Empty disables Markdown templating.',
	'template-canvas': 'Canvas template mapping: template.canvas: [date format, prefix, apply filename convention]. Empty disables Canvas templating.',
	'template-base': 'Base template mapping: template.base: [date format, prefix, apply filename convention]. Empty disables Base templating.',
	'template-paths-under-global-folder': 'True resolves this folder config\'s template paths under the vault default template folder; false uses exact vault-relative paths.',
};

const LEGACY_HELP: Record<string, readonly string[]> = {
	showBookLabel: ['True shows a subtle book label above Markdown notes.'],
	fileOrder: ['Immediate child names in manual display order. Missing names are added; stale names are removed.'],
	'creation-date': [
		'Creation date for Markdown notes; other file types use their filesystem creation time. Format YY-MM-DD.',
		'Filesystem creation date, refreshed at startup; format YY-MM-DD.',
	],
	orderingEnabled: ['True after this book has been prepared for metadata ordering.'],
	showGridBoundaries: ['True shows theme-aware base-cell boundaries while a full Grid contains overflow books.'],
	gridBoundaryThickness: ['Grid overflow boundary thickness in pixels, from 1 to 8.'],
	'template-file-prefix': ['Prefix for newly created matching files. Use {{date}} to insert the formatted date.'],
	'template-file-date': ['Moment-style creation-date format. Name collisions add a time suffix.'],
	'template-file-path': ['Vault-relative template file copied into newly created matching files.'],
	'template-file-applied-To': [
		'Inclusion list for new files: matching extensions receive the template filename and contents; unlisted types are unchanged. Comma-separated without dots, or * for all. Default md.',
		'Comma-separated file extensions, or * for all supported file types.',
	],
	'template-file-applied-to': [
		'Inclusion list for new files: matching extensions receive the template filename and contents; unlisted types are unchanged. Comma-separated without dots, or * for all. Default md.',
		'Comma-separated file extensions, or * for all supported file types.',
	],
};

const hasOwn = (value: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

export function prefixedConfigKey(key: string): string {
	return `${BOOK_TABS_FRONTMATTER_PREFIX}${key}`;
}

/** A prefixed value always wins, including false, null, or another deliberately invalid sentinel. */
export function readPluginFrontmatter(fm: Record<string, unknown>, key: string): unknown {
	const prefixed = prefixedConfigKey(key);
	return hasOwn(fm, prefixed) ? fm[prefixed] : fm[key];
}

export function hasPluginFrontmatter(fm: Record<string, unknown>, key: string): boolean {
	return hasOwn(fm, prefixedConfigKey(key)) || hasOwn(fm, key);
}

/** Preserve an unowned plain collision and establish/update the prefixed plugin-owned alias. */
export function writePluginFrontmatter(
	fm: Record<string, unknown>,
	key: string,
	value: unknown,
	ownedPlainKeys: ReadonlySet<string> = new Set(),
): string {
	const prefixed = prefixedConfigKey(key);
	const destination = hasOwn(fm, prefixed) || (hasOwn(fm, key) && !ownedPlainKeys.has(key)) ? prefixed : key;
	fm[destination] = value;
	return destination;
}

/** Add a default without replacing an existing user property with the same plain key. */
export function ensurePluginFrontmatter(
	fm: Record<string, unknown>,
	key: string,
	value: unknown,
	ownedPlainKeys: ReadonlySet<string> = new Set(),
): string | null {
	const prefixed = prefixedConfigKey(key);
	if (hasOwn(fm, prefixed) || (hasOwn(fm, key) && ownedPlainKeys.has(key))) return null;
	if (hasOwn(fm, key)) {
		fm[prefixed] = value;
		return prefixed;
	}
	fm[key] = value;
	return key;
}

/** Remove plugin-owned data without exposing a colliding user property as a fallback. */
export function removePluginFrontmatter(
	fm: Record<string, unknown>,
	key: string,
	ownedPlainKeys: ReadonlySet<string> = new Set(),
): void {
	const prefixed = prefixedConfigKey(key);
	const plainCollision = hasOwn(fm, key) && !ownedPlainKeys.has(key);
	if (ownedPlainKeys.has(key)) delete fm[key];
	if (plainCollision) fm[prefixed] = null;
	else delete fm[prefixed];
}

/** Public frontmatter writes may reserialize YAML, so restore plugin help after each write. */
export async function updateConfigFrontmatter(app: App, file: TFile, change: (fm: Record<string, unknown>, context: ConfigFrontmatterContext) => void, options: { aliases?: Record<string, string>; renamedKeys?: Record<string, string> } = {}): Promise<void> {
	const before = await app.vault.read(file);
	const obsoleteKeys = findObsoleteGeneratedKeys(before);
	const context: ConfigFrontmatterContext = { ownedPlainKeys: findCommentOwnedPlainKeys(before, options.aliases) };
	const applyChange = (fm: Record<string, unknown>): void => {
		for (const key of obsoleteKeys) if (typeof fm[key] === 'number') delete fm[key];
		for (const key of context.ownedPlainKeys) if (hasOwn(fm, prefixedConfigKey(key))) delete fm[key];
		change(fm, context);
	};
	const cached = app.metadataCache?.getFileCache?.(file)?.frontmatter;
	let prepared: Record<string, unknown> | null = null;
	if (cached) {
		prepared = cloneFrontmatter(cached);
		applyChange(prepared);
		const normalizedBefore = addConfigComments(removeObsoleteGeneratedHelp(before), options.aliases);
		if (sameFrontmatter(cloneFrontmatter(cached), prepared) && normalizedBefore === before) return;
	}
	await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
		if (!prepared) {
			applyChange(fm);
			return;
		}
		for (const key of Object.keys(fm)) delete fm[key];
		Object.assign(fm, prepared);
	});
	const cleanBefore = removeObsoleteGeneratedHelp(before);
	await app.vault.process(file, content => addConfigComments(restoreConfigComments(cleanBefore, removeObsoleteGeneratedHelp(content), options.renamedKeys), options.aliases));
}

/** Cached frontmatter contains an Obsidian source-position record that is not a YAML property. */
function cloneFrontmatter(value: Record<string, unknown>): Record<string, unknown> {
	const clone = structuredClone(value);
	delete clone.position;
	return clone;
}

function sameFrontmatter(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (Array.isArray(left) || Array.isArray(right)) {
		return Array.isArray(left) && Array.isArray(right) && left.length === right.length
			&& left.every((value, index) => sameFrontmatter(value, right[index]));
	}
	if (!isRecord(left) || !isRecord(right)) return false;
	const leftKeys = Object.keys(left).sort(), rightKeys = Object.keys(right).sort();
	return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index]
		&& sameFrontmatter(left[key], right[key]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/** Remove instructions and fields generated by superseded ordering formats. */
export function removeObsoleteGeneratedHelp(content: string): string {
	const newline = content.includes('\r\n') ? '\r\n' : '\n';
	const output: string[] = [];
	let inFrontmatter = false, frontmatterClosed = false, dropGeneratedNumericKey = false;
	for (const [index, line] of content.split(/\r?\n/).entries()) {
		if (index === 0 && line.replace(/^\uFEFF/, '').trim() === '---') inFrontmatter = true;
		else if (inFrontmatter && /^(---|\.\.\.)\s*$/.test(line)) { inFrontmatter = false; frontmatterClosed = true; }
		if (inFrontmatter && isObsoleteHelp(line)) {
			dropGeneratedNumericKey = line.startsWith('# Integer order among siblings.');
			continue;
		}
		if (inFrontmatter && dropGeneratedNumericKey) {
			if (/^[\w-]+\s*:\s*-?\d+\s*$/.test(line)) continue;
			dropGeneratedNumericKey = false;
		}
		if (frontmatterClosed && /^<!-- Ordering:.*forcedOrderingType.*tabInsertDirection.*-->\s*$/.test(line)) continue;
		output.push(line);
	}
	return output.join(newline);
}

function findObsoleteGeneratedKeys(content: string): string[] {
	const lines = content.split(/\r?\n/);
	if (lines[0]?.replace(/^\uFEFF/, '').trim() !== '---') return [];
	const keys: string[] = [];
	for (let index = 1; index < lines.length; index++) {
		const line = lines[index]!;
		if (/^(---|\.\.\.)\s*$/.test(line)) break;
		if (!line.startsWith('# Integer order among siblings.')) continue;
		const key = /^([\w-]+)\s*:\s*-?\d+\s*$/.exec(lines[index + 1] ?? '')?.[1];
		if (key) keys.push(key);
	}
	return keys;
}

function isObsoleteHelp(line: string): boolean {
	return Object.values(LEGACY_HELP).some(comments => comments.some(comment => line === `# ${comment}`))
		|| line.startsWith('# Integer order among siblings.')
		|| (line.startsWith('# False inherits the book/parent order; ') && line !== `# ${HELP.forcedOrderingType}`)
		|| (line.startsWith('# Book default sort: ') && line !== `# ${HELP.orderingType}`);
}

/** Preserve leading YAML comments attached to surviving top-level properties. */
export function restoreConfigComments(before: string, after: string, renamedKeys: Record<string, string> = {}): string {
	const comments = new Map<string, string[]>();
	const lines = before.split(/\r?\n/);
	if (lines[0]?.trim() !== '---') return after;
	let pending: string[] = [];
	for (const line of lines.slice(1)) {
		if (/^(---|\.\.\.)\s*$/.test(line)) break;
		if (line.startsWith('#')) { pending.push(line); continue; }
		const key = /^([\w-]+|"[^"\n]+"|'[^'\n]+')\s*:/.exec(line)?.[1];
		if (key && pending.length) comments.set(renamedKeys[key.replace(/^["']|["']$/g, '')] ?? key.replace(/^["']|["']$/g, ''), pending);
		if (line.trim()) pending = [];
	}
	let yaml = false, closed = false;
	const output: string[] = [];
	for (const [index, line] of after.split(/\r?\n/).entries()) {
		if (index === 0 && line.trim() === '---') yaml = true;
		else if (yaml && /^(---|\.\.\.)\s*$/.test(line)) { yaml = false; closed = true; }
		if (yaml && !closed) {
			const key = /^([\w-]+|"[^"\n]+"|'[^'\n]+')\s*:/.exec(line)?.[1]?.replace(/^["']|["']$/g, '');
			for (const comment of key ? comments.get(key) ?? [] : []) if (!output.slice(-((comments.get(key!)?.length ?? 0) + 1)).includes(comment)) output.push(comment);
		}
		output.push(line);
	}
	return output.join(after.includes('\r\n') ? '\r\n' : '\n');
}

export function addConfigComments(content: string, aliases: Record<string, string> = {}): string {
	const lines = content.split(/\r?\n/), newline = content.includes('\r\n') ? '\r\n' : '\n';
	if (lines[0]?.replace(/^\uFEFF/, '').trim() !== '---') return content;
	const end = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line));
	if (end < 0) return content;
	const keys = new Set(lines.slice(1, end).map(frontmatterLineKey).filter((key): key is string => key !== null));
	const output: string[] = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		if (index > 0 && index < end) {
			const key = frontmatterLineKey(line) ?? undefined;
			const plainKey = key ? removePluginPrefix(key) : undefined;
			const help = key && plainKey ? HELP[aliases[key] ?? aliases[plainKey] ?? plainKey] : undefined;
			const collidingPlain = !!key && !key.startsWith(BOOK_TABS_FRONTMATTER_PREFIX) && keys.has(prefixedConfigKey(key));
			if (help && collidingPlain && output[output.length - 1] === `# ${help}`) output.pop();
			if (help && !collidingPlain && output[output.length - 1] !== `# ${help}`) output.push(`# ${help}`);
		}
		output.push(line);
	}
	return output.join(newline);
}

function removePluginPrefix(key: string): string {
	return key.startsWith(BOOK_TABS_FRONTMATTER_PREFIX) ? key.slice(BOOK_TABS_FRONTMATTER_PREFIX.length) : key;
}

function findCommentOwnedPlainKeys(content: string, aliases: Record<string, string> = {}): Set<string> {
	const lines = content.split(/\r?\n/);
	const owned = new Set<string>();
	if (lines[0]?.replace(/^\uFEFF/, '').trim() !== '---') return owned;
	let comments: string[] = [];
	for (const line of lines.slice(1)) {
		if (/^(---|\.\.\.)\s*$/.test(line)) break;
		if (line.startsWith('#')) { comments.push(line); continue; }
		const rawKey = frontmatterLineKey(line) ?? undefined;
		if (rawKey && !rawKey.startsWith(BOOK_TABS_FRONTMATTER_PREFIX)) {
			const helpKey = aliases[rawKey] ?? rawKey;
			if (comments.some(comment => isGeneratedHelpForKey(comment, helpKey))) owned.add(rawKey);
		}
		if (line.trim()) comments = [];
	}
	return owned;
}

function isGeneratedHelpForKey(line: string, key: string): boolean {
	if (HELP[key] && line === `# ${HELP[key]}`) return true;
	if (LEGACY_HELP[key]?.some(comment => line === `# ${comment}`)) return true;
	if (key === 'forcedOrderingType') return line.startsWith('# False inherits the book/parent order; ');
	if (key === 'orderingType') return line.startsWith('# Book default sort: ');
	return false;
}

function frontmatterLineKey(line: string): string | null {
	return /^([\w-]+|"[^"\n]+"|'[^'\n]+')\s*:/.exec(line)?.[1]?.replace(/^["']|["']$/g, '') ?? null;
}
