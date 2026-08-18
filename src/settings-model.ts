import type { ScopeTabsSettings } from './types';

export const DEFAULT_SETTINGS: ScopeTabsSettings = {
	colorMode: 'manual',
	manualColors: {},
	configFileBaseName: 'index',
	colorFrontmatterProperty: 'color',
	notifyMissingConfigFiles: true,
	showBookLabel: true,
	colorTabs: true,
	tabDecorationStyle: 'underline',
	tabCustomCss: '',
	colorExplorer: true,
	explorerDecorationStyle: 'edge',
	explorerCustomCss: '',
	bookSplitDirection: 'right',
	tabInsertDirection: 'right',
	focusNewTabs: true,
	openBooksInExternalWindows: false,
};

export function sanitizeConfigBaseName(value: string): string {
	const trimmed = value.trim().replace(/\.md$/i, '');
	return trimmed || DEFAULT_SETTINGS.configFileBaseName;
}

export function sanitizeFrontmatterProperty(value: string): string {
	return value.trim() || DEFAULT_SETTINGS.colorFrontmatterProperty;
}
