import { Notice, Plugin, TFile, normalizePath } from "obsidian";
import {
	extractDateFromFilename,
	formatDateManagerValue,
	parsedToDate,
	rewriteFilenameDate,
	validateDateFormat,
} from "./date-format";
import {
	resolveDateManagerConfiguration,
	splitFrontmatter,
} from "./note-rules";
import type { SortingCoordinator } from "./sorting";
import type { RootBooksWorkspaceSettings } from "./types";

export class CreatedFromFilenameSync {
	private suppress = new WeakSet<TFile>();
	private createdValues = new Map<string, unknown>();
	private bodyState = new Map<string, boolean>();
	private migrationRunning = false;
	private rootRepairing = false;

	constructor(
		private readonly plugin: Plugin,
		private readonly settings: RootBooksWorkspaceSettings,
		private readonly saveSettings: () => Promise<void>,
		private readonly sorting: SortingCoordinator,
	) {}

	async start(): Promise<void> {
		const format = await this.ensureRootFormat();
		if (format !== this.settings.lastValidDateFormat) {
			await this.migrateFilenames(
				this.settings.lastValidDateFormat,
				format,
			);
			this.settings.lastValidDateFormat = format;
			await this.saveSettings();
		}
		await this.scan(format);

		this.plugin.registerEvent(
			this.plugin.app.vault.on("rename", (item, oldPath) => {
				if (
					item instanceof TFile &&
					item.extension === "md" &&
					!this.migrationRunning
				) {
					void this.onRename(item, oldPath);
				}
			}),
		);
		this.plugin.registerEvent(
			this.plugin.app.vault.on("modify", (item) => {
				if (item instanceof TFile && item.extension === "md")
					void this.onModify(item);
			}),
		);
		this.plugin.registerEvent(
			this.plugin.app.metadataCache.on("changed", (file) => {
				if (file.path === "index.md") void this.onRootChanged();
				else if (file.extension === "md") this.onMetadataChanged(file);
			}),
		);
	}

	private combinedFormat(dateFormat: string): string {
		const time = this.settings.optionalFilenameTimeFormat.trim();
		return time ? `${dateFormat} ${time}` : dateFormat;
	}

	private rootFile(): TFile | null {
		const root = this.plugin.app.vault.getAbstractFileByPath("index.md");
		return root instanceof TFile ? root : null;
	}

	private async ensureRootFormat(): Promise<string> {
		const root = this.rootFile();
		if (!root) return "DD.MM.YYYY";
		const raw =
			this.plugin.app.metadataCache.getFileCache(root)?.frontmatter?.[
				"template-date-format"
			];
		const valid = typeof raw === "string" ? validateDateFormat(raw) : null;
		if (valid) return valid;
		if (!this.rootRepairing) {
			this.rootRepairing = true;
			await this.plugin.app.fileManager.processFrontMatter(
				root,
				(metadata) => {
					metadata["template-date-format"] = "DD.MM.YYYY";
				},
			);
			this.rootRepairing = false;
			new Notice("Restored template-date-format to DD.MM.YYYY.");
		}
		return "DD.MM.YYYY";
	}

	private async onRootChanged(): Promise<void> {
		if (this.rootRepairing || this.migrationRunning) return;
		const format = await this.ensureRootFormat();
		if (format === this.settings.lastValidDateFormat) return;
		const old = this.settings.lastValidDateFormat;
		await this.migrateFilenames(old, format);
		this.settings.lastValidDateFormat = format;
		await this.saveSettings();
	}

	private async migrateFilenames(
		oldFormat: string,
		newFormat: string,
	): Promise<void> {
		if (
			!validateDateFormat(oldFormat) ||
			!validateDateFormat(newFormat) ||
			oldFormat === newFormat
		)
			return;
		this.migrationRunning = true;
		let changed = 0;
		try {
			for (const file of this.plugin.app.vault.getMarkdownFiles()) {
				if (
					file.path === "index.md" ||
					file.path.startsWith("templates/")
				)
					continue;
				const rewritten = rewriteFilenameDate(
					file.basename,
					oldFormat,
					newFormat,
				);
				if (!rewritten || rewritten === file.basename) continue;
				const parent = file.parent?.isRoot()
					? ""
					: (file.parent?.path ?? "");
				const target = normalizePath(
					`${parent ? `${parent}/` : ""}${rewritten}.md`,
				);
				if (this.plugin.app.vault.getAbstractFileByPath(target))
					continue;
				await this.plugin.app.fileManager.renameFile(file, target);
				changed += 1;
			}
		} finally {
			this.migrationRunning = false;
		}
		if (changed > 0) this.sorting.request("filename date-format migration");
	}

	private async scan(dateFormat: string): Promise<void> {
		let changed = false;
		for (const file of this.plugin.app.vault.getMarkdownFiles()) {
			const content = await this.plugin.app.vault.cachedRead(file);
			this.bodyState.set(
				file.path,
				splitFrontmatter(content).body.trim().length > 0,
			);
			const manager = resolveDateManagerConfiguration(this.plugin.app);
			this.createdValues.set(
				file.path,
				this.plugin.app.metadataCache.getFileCache(file)?.frontmatter?.[
					manager.createdKey
				],
			);
			changed =
				(await this.updateCreatedFromFilename(file, dateFormat)) ||
				changed;
		}
		if (changed)
			this.sorting.request("initial filename-date synchronization");
	}

	private async updateCreatedFromFilename(
		file: TFile,
		dateFormat?: string,
	): Promise<boolean> {
		if (file.path === "index.md" || file.path.startsWith("templates/"))
			return false;
		const format = dateFormat ?? (await this.ensureRootFormat());
		const parsed = extractDateFromFilename(
			file.basename,
			this.combinedFormat(format),
		);
		if (!parsed) return false;
		const manager = resolveDateManagerConfiguration(this.plugin.app);
		const metadata =
			this.plugin.app.metadataCache.getFileCache(file)?.frontmatter;
		const currentRaw = metadata?.[manager.createdKey];
		const currentDate = new Date(String(currentRaw ?? file.stat.ctime));
		const fallback = Number.isNaN(currentDate.valueOf())
			? new Date(file.stat.ctime)
			: currentDate;
		const next = formatDateManagerValue(
			parsedToDate(parsed, fallback),
			manager.outputFormat,
		);
		if (String(currentRaw ?? "") === next) return false;
		this.suppress.add(file);
		await this.plugin.app.fileManager.processFrontMatter(
			file,
			(frontmatter) => {
				frontmatter[manager.createdKey] = next;
			},
		);
		this.createdValues.set(file.path, next);
		window.setTimeout(() => this.suppress.delete(file), 500);
		return true;
	}

	private async onRename(file: TFile, oldPath: string): Promise<void> {
		const oldName = oldPath.split("/").at(-1)?.replace(/\.md$/i, "") ?? "";
		const format = await this.ensureRootFormat();
		const combined = this.combinedFormat(format);
		const oldParsed = extractDateFromFilename(oldName, combined);
		const newParsed = extractDateFromFilename(file.basename, combined);
		if (!newParsed || oldParsed?.text === newParsed.text) return;
		await this.updateCreatedFromFilename(file, format);
		this.sorting.request(`filename date changed: ${file.path}`);
	}

	private onMetadataChanged(file: TFile): void {
		if (this.suppress.has(file)) return;
		const manager = resolveDateManagerConfiguration(this.plugin.app);
		const current =
			this.plugin.app.metadataCache.getFileCache(file)?.frontmatter?.[
				manager.createdKey
			];
		const previous = this.createdValues.get(file.path);
		this.createdValues.set(file.path, current);
		if (
			previous !== undefined &&
			JSON.stringify(previous) !== JSON.stringify(current)
		) {
			this.sorting.request(`created changed: ${file.path}`);
		}
	}

	private async onModify(file: TFile): Promise<void> {
		if (this.suppress.has(file)) return;
		const content = await this.plugin.app.vault.cachedRead(file);
		const hasBody = splitFrontmatter(content).body.trim().length > 0;
		const previous = this.bodyState.get(file.path);
		this.bodyState.set(file.path, hasBody);
		if (previous === false && hasBody)
			this.sorting.request(`first body text: ${file.path}`);
	}
}
