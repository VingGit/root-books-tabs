export type ColorMode = 'manual' | 'frontmatter';
export type CardinalDirection = 'right' | 'left' | 'down' | 'up';
export type BookSplitDirection = CardinalDirection | 'grid';
export type TabInsertDirection = 'right' | 'left';
export type TabDecorationStyle = 'underline' | 'background' | 'dot' | 'custom';
export type CreationLocation = 'current-folder' | 'book-root';
export type ManualTabTextColor = '#000000' | '#ffffff';

export interface ScopeTabsSettings {
	colorMode: ColorMode;
	manualColors: Record<string, string>;
	manualTabTextColors: Record<string, ManualTabTextColor>;
	configFileBaseName: string;
	colorFrontmatterProperty: string;
	tabTextFrontmatterProperty: string;
	notifyMissingConfigFiles: boolean;
	showBookLabel: boolean;
	colorTabs: boolean;
	tabDecorationStyle: TabDecorationStyle;
	tabCustomCss: string;
	bookModeEnabled: boolean;
	selectedBookId: string | null;
	colorBookSwitcher: boolean;
	newNoteLocation: CreationLocation;
	newFolderLocation: CreationLocation;
	bookSplitDirection: BookSplitDirection;
	gridOverflowDirection: CardinalDirection;
	gridRows: number;
	gridColumns: number;
	tabInsertDirection: TabInsertDirection;
	focusNewTabs: boolean;
	openBooksInExternalWindows: boolean;
}

export interface BookScope {
	id: string;
	name: string;
	folderPath: string;
}

export type ManagedGroupLocation = 'main' | 'popout';

export interface PersistedGroupRecord {
	kind: 'managed' | 'free';
	bookId?: string;
	location: ManagedGroupLocation;
}

export interface ScopeTabsRuntimeStateV1 {
	version: 1;
	groups: Record<string, PersistedGroupRecord>;
	bookOrder: string[];
	gridBaseBookIds: string[];
}
