import { FileView, TFile, type Vault, type WorkspaceLeaf } from 'obsidian';

export function getLeafFile(leaf: WorkspaceLeaf, vault: Vault): TFile | null {
	if (leaf.view instanceof FileView && leaf.view.file instanceof TFile) return leaf.view.file;
	const path = leaf.getViewState().state?.file;
	if (typeof path !== 'string') return null;
	const abstractFile = vault.getAbstractFileByPath(path);
	return abstractFile instanceof TFile ? abstractFile : null;
}
