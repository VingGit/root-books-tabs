import { TFile, TFolder, Vault } from 'obsidian';
import type { BookScope } from './types';

export class FirstLevelFolderScopeResolver {
	constructor(private readonly vault: Vault) {}

	listBooks(): BookScope[] {
		return this.vault
			.getRoot()
			.children.filter((entry): entry is TFolder => entry instanceof TFolder)
			.map((folder) => ({
				id: folder.path,
				name: folder.name,
				folderPath: folder.path,
			}))
			.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
	}

	resolveFile(file: TFile | null | undefined): BookScope | null {
		if (!file) return null;
		const [first] = file.path.split('/');
		if (!first || first === file.path) return null;
		const rootEntry = this.vault.getAbstractFileByPath(first);
		if (!(rootEntry instanceof TFolder)) return null;
		return { id: rootEntry.path, name: rootEntry.name, folderPath: rootEntry.path };
	}

	hasMultipleBooks(): boolean {
		return this.listBooks().length > 1;
	}
}
