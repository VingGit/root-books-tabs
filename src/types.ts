export type ColorMode = 'manual' | 'frontmatter';
export type BookSplitDirection = 'right' | 'left' | 'down' | 'up' | 'spiral';
export type TabInsertDirection = 'right' | 'left';
export type TabDecorationStyle = 'underline' | 'background' | 'dot' | 'custom';
export type ExplorerDecorationStyle = 'edge' | 'underline' | 'bar' | 'custom';

export interface ScopeTabsSettings {
	colorMode: ColorMode;
	manualColors: Record<string, string>;
	configFileBaseName: string;
	colorFrontmatterProperty: string;
	notifyMissingConfigFiles: boolean;
	showBookLabel: boolean;
	colorTabs: boolean;
	tabDecorationStyle: TabDecorationStyle;
	tabCustomCss: string;
	colorExplorer: boolean;
	explorerDecorationStyle: ExplorerDecorationStyle;
	explorerCustomCss: string;
	bookSplitDirection: BookSplitDirection;
	tabInsertDirection: TabInsertDirection;
	focusNewTabs: boolean;
	openBooksInExternalWindows: boolean;
}

export interface BookScope {
	id: string;
	name: string;
	folderPath: string;
}
