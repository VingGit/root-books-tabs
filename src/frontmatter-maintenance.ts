import type { TFile } from 'obsidian';
import type ScopeTabsPlugin from './main';
import { dateStamp } from './book-order';
import { updateConfigFrontmatter } from './config-frontmatter';
import { BOOK_TABS_SECTION, frontmatterSections } from './frontmatter-section';
import { DEFAULT_SETTINGS } from './settings-model';

/** Drop only a leading, closed YAML frontmatter block; preserve all note-body bytes. */
export function stripFrontmatter(content: string): string {
	const match = /^(\uFEFF?)---[ \t]*\r?\n[\s\S]*?^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(content);
	return match?.index === 0 ? `${match[1] ?? ''}${content.slice(match[0].length)}` : content;
}

export class FrontmatterMaintenanceService {
	paused = false;
	constructor(private readonly plugin: ScopeTabsPlugin) {}

	async setPaused(paused: boolean): Promise<void> {
		this.paused = paused;
		if (paused) await this.plugin.settleFrontmatterWrites();
		await this.plugin.saveRuntimeState();
	}

	async previewDelete(): Promise<{ files: TFile[]; count: number }> {
		const files: TFile[] = [];
		for (const file of this.plugin.app.vault.getMarkdownFiles()) {
			const content = await this.plugin.app.vault.read(file);
			if (stripFrontmatter(content) !== content) files.push(file);
		}
		return { files, count: files.length };
	}

	/** The caller displays an explicit destructive review first. Back up before any deletion. */
	async deleteAll(): Promise<{ count: number; backupPath: string }> {
		await this.setPaused(true);
		const vault = this.plugin.app.vault;
		const snapshots: { path: string; content: string }[] = [];
		for (const file of vault.getMarkdownFiles()) {
			const content = await vault.read(file);
			if (stripFrontmatter(content) !== content) snapshots.push({ path: file.path, content });
		}
		const directory = `${vault.configDir}/plugins/${this.plugin.manifest.id}/frontmatter-backups`;
		if (!await vault.adapter.exists(directory)) await vault.adapter.mkdir(directory);
		const backupPath = `${directory}/${Date.now()}.json`;
		await vault.adapter.write(backupPath, JSON.stringify(snapshots, null, 2));
		let count = 0;
		for (const snapshot of snapshots) {
			const file = vault.getFileByPath(snapshot.path);
			if (!file) continue;
			await vault.process(file, current => {
				if (current !== snapshot.content) throw new Error(`${file.path} changed during the reset. Its frontmatter was preserved.`);
				count++; return stripFrontmatter(current);
			});
		}
		return { count, backupPath };
	}

	async regenerate(field: string): Promise<number> {
		const vault = this.plugin.app.vault;
		if (field === 'creation-date') {
			let count = 0;
			for (const file of vault.getMarkdownFiles()) {
				await updateConfigFrontmatter(this.plugin.app, file, fm => { fm['creation-date'] = dateStamp(file.stat.ctime); delete fm['book-tabs-creation-date']; });
				count++;
			}
			return count;
		}
		if (field === 'aliases' || field === 'display-title') {
			let count = 0;
			for (const file of vault.getMarkdownFiles()) {
				if (!this.plugin.configNoteTitles.isManagedConfigNote(file)) continue;
				const name = this.plugin.configNoteTitles.expectedTitle(file);
				await updateConfigFrontmatter(this.plugin.app, file, fm => { fm[field === 'aliases' ? 'aliases' : this.plugin.settings.indexTitleProperty] = field === 'aliases' ? [name] : name; });
				count++;
			}
			return count;
		}
		if (field === BOOK_TABS_SECTION) {
			for (const file of vault.getMarkdownFiles()) await updateConfigFrontmatter(this.plugin.app, file, fm => { frontmatterSections.normalize(fm); });
			return vault.getMarkdownFiles().length;
		}
		if (!(field in DEFAULT_SETTINGS)) throw new Error('Choose a setting to regenerate.');
		await this.plugin.vaultConfig.set(field, structuredClone(DEFAULT_SETTINGS[field as keyof typeof DEFAULT_SETTINGS]));
		return 1;
	}
}
