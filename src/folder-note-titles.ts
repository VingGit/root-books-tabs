import { Plugin, TFile, TFolder } from "obsidian";

export class FolderNoteTitleSync {
	private timers = new Map<string, number>();

	constructor(private readonly plugin: Plugin) {}

	start(): void {
		this.plugin.registerEvent(
			this.plugin.app.vault.on("create", (item) => {
				if (item instanceof TFile) this.schedule(item);
			}),
		);
		this.plugin.registerEvent(
			this.plugin.app.vault.on("modify", (item) => {
				if (item instanceof TFile) this.schedule(item);
			}),
		);
		this.plugin.registerEvent(
			this.plugin.app.vault.on("rename", (item) => {
				if (item instanceof TFile) this.schedule(item);
				if (item instanceof TFolder) {
					const index = this.plugin.app.vault.getAbstractFileByPath(
						`${item.path}/index.md`,
					);
					if (index instanceof TFile) this.schedule(index);
				}
			}),
		);
		for (const file of this.plugin.app.vault.getMarkdownFiles())
			this.schedule(file);
	}

	private isFolderNote(file: TFile): boolean {
		return (
			file.name === "index.md" &&
			Boolean(file.parent && !file.parent.isRoot())
		);
	}

	private schedule(file: TFile): void {
		if (!this.isFolderNote(file)) return;
		const existing = this.timers.get(file.path);
		if (existing !== undefined) window.clearTimeout(existing);
		this.timers.set(
			file.path,
			window.setTimeout(() => {
				this.timers.delete(file.path);
				void this.synchronize(file);
			}, 250),
		);
	}

	private async synchronize(file: TFile): Promise<void> {
		if (!this.isFolderNote(file) || !file.parent) return;
		const expected = file.parent.name;
		const current =
			this.plugin.app.metadataCache.getFileCache(file)?.frontmatter
				?.title;
		if (current === expected) return;
		await this.plugin.app.fileManager.processFrontMatter(
			file,
			(frontmatter) => {
				frontmatter.title = expected;
			},
		);
	}

	dispose(): void {
		for (const timer of this.timers.values()) window.clearTimeout(timer);
		this.timers.clear();
	}
}
