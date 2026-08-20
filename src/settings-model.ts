import type { ScopeTabsRuntimeStateV1, ScopeTabsSettings } from './types';

export const DEFAULT_SETTINGS: ScopeTabsSettings = {
	colorMode: 'manual',
	manualColors: {},
	manualTabTextColors: {},
	configFileBaseName: 'index',
	colorFrontmatterProperty: 'color',
	tabTextFrontmatterProperty: 'tab-text-bg',
	notifyMissingConfigFiles: true,
	showBookLabel: true,
	colorTabs: true,
	tabDecorationStyle: 'underline',
	tabCustomCss: '',
	bookModeEnabled: true,
	selectedBookId: null,
	colorBookSwitcher: true,
	newNoteLocation: 'current-folder',
	newFolderLocation: 'current-folder',
	bookSplitDirection: 'right',
	gridOverflowDirection: 'right',
	gridRows: 2,
	gridColumns: 2,
	tabInsertDirection: 'right',
	focusNewTabs: true,
	openBooksInExternalWindows: false,
};

export const DEFAULT_RUNTIME_STATE: ScopeTabsRuntimeStateV1 = {
	version: 1,
	groups: {},
	bookOrder: [],
	gridBaseBookIds: [],
};

export function migrateSettings(saved: unknown): ScopeTabsSettings {
	const source = isRecord(saved) ? saved : {};
	const settings = structuredClone(DEFAULT_SETTINGS);
	if (source.colorMode === 'manual' || source.colorMode === 'frontmatter') settings.colorMode = source.colorMode;
	if (isStringRecord(source.manualColors)) settings.manualColors = { ...source.manualColors };
	if (isStringRecord(source.manualTabTextColors)) {
		for (const [bookId, value] of Object.entries(source.manualTabTextColors)) {
			const normalized = normalizeManualTabTextColor(value);
			if (normalized) settings.manualTabTextColors[bookId] = normalized;
		}
	}
	if (typeof source.configFileBaseName === 'string') settings.configFileBaseName = sanitizeConfigBaseName(source.configFileBaseName);
	if (typeof source.colorFrontmatterProperty === 'string') settings.colorFrontmatterProperty = sanitizeFrontmatterProperty(source.colorFrontmatterProperty);
	if (typeof source.tabTextFrontmatterProperty === 'string') settings.tabTextFrontmatterProperty = sanitizeTabTextFrontmatterProperty(source.tabTextFrontmatterProperty);
	copyBoolean(source, settings, 'notifyMissingConfigFiles');
	copyBoolean(source, settings, 'showBookLabel');
	copyBoolean(source, settings, 'colorTabs');
	if (source.tabDecorationStyle === 'underline' || source.tabDecorationStyle === 'background' || source.tabDecorationStyle === 'dot' || source.tabDecorationStyle === 'custom') {
		settings.tabDecorationStyle = source.tabDecorationStyle;
	}
	if (typeof source.tabCustomCss === 'string') settings.tabCustomCss = source.tabCustomCss;
	copyBoolean(source, settings, 'bookModeEnabled');
	settings.selectedBookId = typeof source.selectedBookId === 'string' ? source.selectedBookId : null;
	if (typeof source.colorBookSwitcher === 'boolean') settings.colorBookSwitcher = source.colorBookSwitcher;
	else if (typeof source.colorExplorer === 'boolean') settings.colorBookSwitcher = source.colorExplorer;
	if (source.newNoteLocation === 'current-folder' || source.newNoteLocation === 'book-root') settings.newNoteLocation = source.newNoteLocation;
	if (source.newFolderLocation === 'current-folder' || source.newFolderLocation === 'book-root') settings.newFolderLocation = source.newFolderLocation;
	if (source.bookSplitDirection === 'right' || source.bookSplitDirection === 'left' || source.bookSplitDirection === 'down' || source.bookSplitDirection === 'up' || source.bookSplitDirection === 'grid') {
		settings.bookSplitDirection = source.bookSplitDirection;
	} else if (source.bookSplitDirection === 'grid-4x4') {
		settings.bookSplitDirection = 'grid';
	}
	const savedGridOverflow = source.gridOverflowDirection ?? source.fourByFourOverflowDirection;
	if (savedGridOverflow === 'right' || savedGridOverflow === 'left' || savedGridOverflow === 'down' || savedGridOverflow === 'up') {
		settings.gridOverflowDirection = savedGridOverflow;
	}
	settings.gridRows = clampGridDimension(source.gridRows);
	settings.gridColumns = clampGridDimension(source.gridColumns);
	if (source.tabInsertDirection === 'right' || source.tabInsertDirection === 'left') settings.tabInsertDirection = source.tabInsertDirection;
	copyBoolean(source, settings, 'focusNewTabs');
	copyBoolean(source, settings, 'openBooksInExternalWindows');
	return settings;
}

export function migrateRuntimeState(saved: unknown): ScopeTabsRuntimeStateV1 {
	if (!isRecord(saved) || saved.version !== 1 || !isRecord(saved.groups)) return structuredClone(DEFAULT_RUNTIME_STATE);
	const groups: ScopeTabsRuntimeStateV1['groups'] = {};
	for (const [id, value] of Object.entries(saved.groups)) {
		if (!isRecord(value) || (value.kind !== 'managed' && value.kind !== 'free')) continue;
		if (value.location !== 'main' && value.location !== 'popout') continue;
		if (value.kind === 'managed' && typeof value.bookId !== 'string') continue;
		groups[id] = {
			kind: value.kind,
			location: value.location,
			...(typeof value.bookId === 'string' ? { bookId: value.bookId } : {}),
		};
	}
	const bookOrder = Array.isArray(saved.bookOrder)
		? saved.bookOrder.filter((value): value is string => typeof value === 'string')
		: [];
	const savedGridBaseBookIds = saved.gridBaseBookIds ?? saved.fourByFourBaseBookIds;
	const gridBaseBookIds = Array.isArray(savedGridBaseBookIds)
		? savedGridBaseBookIds.filter((value): value is string => typeof value === 'string')
		: [];
	return {
		version: 1,
		groups,
		bookOrder: [...new Set(bookOrder)],
		gridBaseBookIds: [...new Set(gridBaseBookIds)].slice(0, 256),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function copyBoolean<Key extends keyof ScopeTabsSettings>(source: Record<string, unknown>, target: ScopeTabsSettings, key: Key): void {
	const value = source[key];
	if (typeof value === 'boolean') target[key] = value as ScopeTabsSettings[Key];
}

export function sanitizeConfigBaseName(value: string): string {
	const trimmed = value.trim().replace(/\.md$/i, '');
	const segment = trimmed.split(/[\\/]/).pop()?.trim() ?? '';
	return segment || DEFAULT_SETTINGS.configFileBaseName;
}

export function sanitizeFrontmatterProperty(value: string): string {
	return value.trim() || DEFAULT_SETTINGS.colorFrontmatterProperty;
}

export function sanitizeTabTextFrontmatterProperty(value: string): string {
	return value.trim() || DEFAULT_SETTINGS.tabTextFrontmatterProperty;
}

function normalizeManualTabTextColor(value: string): '#000000' | '#ffffff' | null {
	const normalized = value.trim().toLowerCase();
	if (normalized === 'black' || normalized === '#000000') return '#000000';
	if (normalized === 'white' || normalized === '#ffffff') return '#ffffff';
	return null;
}

function clampGridDimension(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return 2;
	return Math.min(16, Math.max(2, Math.round(value)));
}
