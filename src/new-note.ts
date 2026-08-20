import { TFile, TFolder, type FileManager } from 'obsidian';
import { getLeafFile } from './leaf-file';
import type ScopeTabsPlugin from './main';

type GetNewFileParent = FileManager['getNewFileParent'];
type CreateNewFolder = (parent: TFolder | null) => Promise<TFolder | null>;

interface FolderCreationCompatibility {
	createNewFolder?: CreateNewFolder;
}

export class NewNoteLocationController {
	private original: GetNewFileParent | null = null;
	private patch: GetNewFileParent | null = null;
	private hadOwnMethod = false;
	private originalCreateFolder: CreateNewFolder | null = null;
	private createFolderPatch: CreateNewFolder | null = null;
	private hadOwnCreateFolder = false;

	constructor(private readonly plugin: ScopeTabsPlugin) {}

	install(): void {
		if (this.patch) return;
		const manager = this.plugin.app.fileManager;
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Exact function identity is required for ownership-safe restoration.
		const original = manager.getNewFileParent;
		if (typeof original !== 'function') return;
		this.original = original;
		this.hadOwnMethod = Object.prototype.hasOwnProperty.call(manager, 'getNewFileParent');
		const resolveParent = this.resolveParent.bind(this);
		this.patch = function (this: FileManager, sourcePath: string, newFilePath?: string): TFolder {
			const parent = resolveParent(sourcePath, newFilePath);
			return parent ?? original.call(this, sourcePath, newFilePath);
		};
		manager.getNewFileParent = this.patch;
		this.installFolderPatch(manager);
	}

	uninstall(): void {
		const manager = this.plugin.app.fileManager;
		if (this.patch && manager.getNewFileParent === this.patch && this.original) {
			if (this.hadOwnMethod) manager.getNewFileParent = this.original;
			else delete (manager as Partial<FileManager>).getNewFileParent;
		}
		this.original = null;
		this.patch = null;
		const compatibility = manager as unknown as FolderCreationCompatibility;
		if (this.createFolderPatch && compatibility.createNewFolder === this.createFolderPatch && this.originalCreateFolder) {
			if (this.hadOwnCreateFolder) compatibility.createNewFolder = this.originalCreateFolder;
			else delete compatibility.createNewFolder;
		}
		this.originalCreateFolder = null;
		this.createFolderPatch = null;
	}

	private resolveParent(sourcePath: string, newFilePath?: string): TFolder | null {
		if (!this.plugin.scopeResolver.hasMultipleBooks() || !isMarkdownCreation(newFilePath)) return null;
		const recentLeaf = this.plugin.app.workspace.getMostRecentLeaf();
		const activeFile = recentLeaf ? getLeafFile(recentLeaf, this.plugin.app.vault) : null;
		const sourceFile = activeFile ?? this.resolveSourceFile(sourcePath);
		const book = this.plugin.scopeResolver.resolveFile(sourceFile);
		if (!sourceFile) return this.getSelectedBookRoot();
		if (!book) return null;
		if (this.plugin.settings.newNoteLocation === 'current-folder') return sourceFile.parent;
		return this.plugin.app.vault.getFolderByPath(book.folderPath);
	}

	private installFolderPatch(manager: FileManager): void {
		const compatibility = manager as unknown as FolderCreationCompatibility;
		// Obsidian's explorer toolbar calls this feature-detected internal method with null.
		// Explicit context-menu parents pass through unchanged.
		const original = compatibility.createNewFolder;
		if (typeof original !== 'function') return;
		this.originalCreateFolder = original;
		this.hadOwnCreateFolder = Object.prototype.hasOwnProperty.call(compatibility, 'createNewFolder');
		const resolveParent = this.resolveFolderParent.bind(this);
		this.createFolderPatch = function (this: FolderCreationCompatibility, parent: TFolder | null): Promise<TFolder | null> {
			return original.call(this, parent ?? resolveParent());
		};
		compatibility.createNewFolder = this.createFolderPatch;
	}

	private resolveFolderParent(): TFolder | null {
		if (!this.plugin.scopeResolver.hasMultipleBooks()) return null;
		const recentLeaf = this.plugin.app.workspace.getMostRecentLeaf();
		const activeFile = recentLeaf ? getLeafFile(recentLeaf, this.plugin.app.vault) : null;
		if (!activeFile) return this.getSelectedBookRoot();
		const book = this.plugin.scopeResolver.resolveFile(activeFile);
		if (!book) return null;
		if (this.plugin.settings.newFolderLocation === 'current-folder') return activeFile.parent;
		return this.plugin.app.vault.getFolderByPath(book.folderPath);
	}

	private getSelectedBookRoot(): TFolder | null {
		const selectedId = this.plugin.settings.selectedBookId;
		if (!selectedId) return null;
		const selected = this.plugin.scopeResolver.listBooks().find((book) => book.id === selectedId);
		return selected ? this.plugin.app.vault.getFolderByPath(selected.folderPath) : null;
	}

	private resolveSourceFile(sourcePath: string): TFile | null {
		const file = this.plugin.app.vault.getAbstractFileByPath(sourcePath);
		return file instanceof TFile ? file : null;
	}
}

function isMarkdownCreation(newFilePath?: string): boolean {
	if (!newFilePath) return true;
	const filename = newFilePath.split('/').pop() ?? '';
	const extension = filename.includes('.') ? filename.split('.').pop()?.toLowerCase() : '';
	return extension === '' || extension === 'md';
}
