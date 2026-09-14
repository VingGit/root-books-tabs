export type ColorMode = 'manual' | 'frontmatter';
export type CardinalDirection = 'right' | 'left' | 'down' | 'up';
export type BookSplitDirection = CardinalDirection | 'grid';
export type TabInsertDirection = 'right' | 'end';
export type TabDecorationStyle = 'underline' | 'background' | 'dot' | 'custom';
export type CreationLocation = 'current-folder' | 'book-root';
export type ManualTabTextColor = '#000000' | '#ffffff';
export type MainBookSwitchBehavior = 'close-previous' | 'keep-open';
export type BookNoteOpenMode = 'same-tab' | 'background-tab' | 'focused-tab';
export type FileExplorerOpenBehavior = 'book-instance' | 'current-group';
export type ExcludedFileGroupLocation = 'next-to-current' | 'popout';
export type OrderingDirection = 'ascending' | 'descending';
export type ConfigNotePosition = 'top' | 'bottom';
export type IndexMoveDecision = 'ask' | 'block' | 'merge-frontmatter' | 'append-body' | 'replace-frontmatter' | 'replace-content' | 'swap';

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
	mainBookSwitchBehavior: MainBookSwitchBehavior;
	defaultStartupBookId: string | null;
	defaultStartupNotePath: string | null;
	fileExplorerOpenBehavior: FileExplorerOpenBehavior;
	colorBookSwitcher: boolean;
	newNoteLocation: CreationLocation;
	newFolderLocation: CreationLocation;
	bookSplitDirection: BookSplitDirection;
	gridOverflowDirection: CardinalDirection;
	gridRows: number;
	gridColumns: number;
	orderingDirection: OrderingDirection;
	configNotePosition: ConfigNotePosition;
	indexMoveDecision: IndexMoveDecision;
	excludedBookFolders: string[];
	excludedFileGroupLocation: ExcludedFileGroupLocation;
	templateFilePrefix: string;
	templateFileDate: string;
	templateFilePath: string;
	templateFileAppliedTo: string;
	forceUpdateLinks: boolean;
	tabInsertDirection: TabInsertDirection;
	bookNoteOpenMode: BookNoteOpenMode;
	bookNoteOpenModeOverrides: Record<string, BookNoteOpenMode>;
	openBooksInExternalWindows: boolean;
}

export interface BookScope {
	id: string;
	name: string;
	folderPath: string;
}

export type ManagedGroupLocation = 'main' | 'popout';

export interface PersistedGroupRecord {
	kind: 'managed' | 'free' | 'excluded';
	bookId?: string;
	location: ManagedGroupLocation;
}

export interface ScopeTabsRuntimeStateV1 {
	version: 1;
	groups: Record<string, PersistedGroupRecord>;
	bookOrder: string[];
	gridBaseBookIds: string[];
}
