/** The only YAML namespace owned by Root Books Tabs. Shared note metadata stays outside it. */
export const BOOK_TABS_SECTION = 'book-tabs';
export const RETIRED_SECTION_KEYS = new Set(['fileOrder', 'orderingEnabled', 'configNotePosition', 'createBookIndex', 'hideNewBookIndex', 'showGridBoundaries', 'gridBoundaryThickness']);

const KEY_ORDER = [
	'isFreshClone', 'freshCloneOpeningPath', 'configFileBaseName',
	'bookModeEnabled', 'mainBookSwitchBehavior', 'fileExplorerOpenBehavior',
	'bookNoteOpenMode', 'tabInsertDirection', 'openBooksInExternalWindows',
	'newNoteLocation', 'newFolderLocation', 'bookSplitDirection', 'gridRows', 'gridColumns', 'gridOverflowDirection',
	'excludedBookFolders', 'excludedFileGroupLocation', 'forceUpdateLinks',
	'orderingType', 'forcedOrderingType', 'orderingDirection', 'forcedOrderingDirection',
	'colorFrontmatterProperty', 'tabTextFrontmatterProperty', 'color', 'tab-text-bg',
	'notifyMissingConfigFiles', 'showBookLabel', 'colorTabs', 'tabDecorationStyle', 'colorBookSwitcher',
	'indexTitleSync', 'indexTitleFollowPlugin', 'indexTitleProperty',
	'template-folder', 'template-date-format', 'template-paths-under-global-folder',
	'template-md', 'template-canvas', 'template-base', 'template-excluded-subfolders',
	'articleNavigatorPreviousProperty', 'articleNavigatorNextProperty', 'articleNavigatorSeeAlsoProperty',
	'articleNavigatorFollowPluginKeys', 'articleNavigatorBlacklist', 'articleNavigatorPreferFilenameDates',
	'article-placeholder-hidden-previous', 'article-placeholder-hidden-next',
];

export function isSection(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Centralized section ownership, migration and deterministic property order. */
export class FrontmatterSectionManager {
	read(frontmatter: Record<string, unknown>): Record<string, unknown> | null {
		const section = frontmatter[BOOK_TABS_SECTION];
		return isSection(section) ? section : null;
	}

	ensure(frontmatter: Record<string, unknown>): Record<string, unknown> {
		const existing = frontmatter[BOOK_TABS_SECTION];
		if (existing !== undefined && !isSection(existing)) throw new Error('The book-tabs YAML section must be a mapping. Repair or remove that section before saving settings.');
		return (frontmatter[BOOK_TABS_SECTION] ??= {}) as Record<string, unknown>;
	}

	migrate(frontmatter: Record<string, unknown>, ownedPlainKeys: ReadonlySet<string>, knownKeys: Iterable<string>): void {
		if (Object.prototype.hasOwnProperty.call(frontmatter, BOOK_TABS_SECTION)) this.ensure(frontmatter);
		let section = this.read(frontmatter);
		for (const key of new Set([...knownKeys, ...ownedPlainKeys])) {
			if (key === 'creation-date' || key === BOOK_TABS_SECTION) continue;
			const prefixed = `book-tabs-${key}`;
			const owned = ownedPlainKeys.has(key);
			if (RETIRED_SECTION_KEYS.has(key)) {
				if (section) delete section[key];
				delete frontmatter[prefixed];
				if (owned) delete frontmatter[key];
				continue;
			}
			const hasPrefixed = Object.prototype.hasOwnProperty.call(frontmatter, prefixed);
			if (hasPrefixed || owned && Object.prototype.hasOwnProperty.call(frontmatter, key)) {
				section ??= this.ensure(frontmatter);
				if (!Object.prototype.hasOwnProperty.call(section, key)) section[key] = hasPrefixed ? frontmatter[prefixed] : frontmatter[key];
				delete frontmatter[prefixed];
				if (owned) delete frontmatter[key];
			}
		}
		if (section) this.normalize(frontmatter);
	}

	normalize(frontmatter: Record<string, unknown>): void {
		const section = this.read(frontmatter);
		if (!section) return;
		for (const key of RETIRED_SECTION_KEYS) delete section[key];
		for (const [old, canonical] of Object.entries({ templateFolder: 'template-folder', templateDateFormat: 'template-date-format', templateMd: 'template-md', templateCanvas: 'template-canvas', templateBase: 'template-base' })) {
			if (!Object.prototype.hasOwnProperty.call(section, old)) continue;
			if (!Object.prototype.hasOwnProperty.call(section, canonical)) section[canonical] = section[old];
			delete section[old];
		}
		if (section.orderingType === 'manual') section.orderingType = 'alphabetical';
		if (section.forcedOrderingType === 'manual') section.forcedOrderingType = false;
		const rank = (key: string): number => { const index = KEY_ORDER.indexOf(key); return index < 0 ? KEY_ORDER.length : index; };
		frontmatter[BOOK_TABS_SECTION] = Object.fromEntries(Object.keys(section).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).map(key => [key, section[key]]));
	}

	delete(frontmatter: Record<string, unknown>): void { delete frontmatter[BOOK_TABS_SECTION]; }
}

export const frontmatterSections = new FrontmatterSectionManager();
