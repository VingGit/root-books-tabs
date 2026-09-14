import { TFile, TFolder, Vault } from 'obsidian';
import type { BookScope } from './types';

export class FirstLevelFolderScopeResolver {
	constructor(
		private readonly vault: Vault,
		private readonly getExcludedFirstLevelNames: () => readonly string[] | undefined = () => [],
	) {}

	listBooks(): BookScope[] {
		return this.listRootFolders()
			.filter(folder => !this.isExcluded(folder))
			.map((folder) => ({
				id: folder.path,
				name: folder.name,
				folderPath: folder.path,
			}))
			.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
	}

	listExcludedFolders(): BookScope[] {
		return this.listRootFolders()
			.filter(folder => this.isExcluded(folder))
			.map(folder => ({ id: folder.path, name: folder.name, folderPath: folder.path }))
			.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
	}

	resolveFile(file: TFile | null | undefined): BookScope | null {
		if (!file) return null;
		const [first] = file.path.split('/');
		if (!first || first === file.path) return null;
		const rootEntry = this.vault.getAbstractFileByPath(first);
		if (!(rootEntry instanceof TFolder) || this.isExcluded(rootEntry)) return null;
		return { id: rootEntry.path, name: rootEntry.name, folderPath: rootEntry.path };
	}

	hasMultipleBooks(): boolean {
		return this.listBooks().length > 1;
	}

	resolveExcludedFile(file: TFile | null | undefined): BookScope | null {
		if (!file) return null;
		const [first] = file.path.split('/');
		if (!first || first === file.path) return null;
		const rootEntry = this.vault.getAbstractFileByPath(first);
		if (!(rootEntry instanceof TFolder) || !this.isExcluded(rootEntry)) return null;
		return { id: rootEntry.path, name: rootEntry.name, folderPath: rootEntry.path };
	}

	private listRootFolders(): TFolder[] {
		return this.vault.getRoot().children.filter((entry): entry is TFolder => entry instanceof TFolder);
	}

	private isExcluded(folder: TFolder): boolean {
		const excluded = new Set((this.getExcludedFirstLevelNames() ?? []).map(normalizeFirstLevelName).filter((name): name is string => name !== null));
		return excluded.has(folder.path);
	}
}

function normalizeFirstLevelName(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const normalized = value.trim().replace(/^\.\//, '').replace(/\/$/, '');
	return normalized && !normalized.includes('/') && !normalized.includes('\\') ? normalized : null;
}
