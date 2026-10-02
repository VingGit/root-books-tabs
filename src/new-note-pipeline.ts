import { Notice, Plugin, TFile, normalizePath } from "obsidian";
import {
	applyMarkdownTemplate,
	canonicalTemplateLink,
	effectiveNoteRules,
	ensureDateFields,
	ensureRootWorkflowProperties,
	prefixedBasename,
	resolveDateManagerConfiguration,
} from "./note-rules";
import type { SortingCoordinator } from "./sorting";

interface ProcessOptions {
	skipPrefix?: boolean;
	openRenameEditor?: boolean;
}

function uniquePath(plugin: Plugin, file: TFile, basename: string): string {
	const folder = file.parent?.isRoot() ? "" : (file.parent?.path ?? "");
	for (let suffix = 0; suffix < 10_000; suffix += 1) {
		const candidateName =
			suffix === 0 ? basename : `${basename}-${suffix + 1}`;
		const path = normalizePath(
			`${folder ? `${folder}/` : ""}${candidateName}.${file.extension}`,
		);
		const existing = plugin.app.vault.getAbstractFileByPath(path);
		if (!existing || existing === file) return path;
	}
	throw new Error("Could not find an unused filename");
}

function selectFilenameSuffix(prefixLength: number): void {
	window.setTimeout(() => {
		const active = document.activeElement;
		if (
			active instanceof HTMLInputElement ||
			active instanceof HTMLTextAreaElement
		) {
			active.setSelectionRange(prefixLength, active.value.length);
			return;
		}
		if (active instanceof HTMLElement && active.isContentEditable) {
			const selection = window.getSelection();
			const text = active.firstChild;
			if (!selection || !text) return;
			const range = document.createRange();
			range.setStart(
				text,
				Math.min(prefixLength, text.textContent?.length ?? 0),
			);
			range.setEnd(text, text.textContent?.length ?? 0);
			selection.removeAllRanges();
			selection.addRange(range);
		}
	}, 50);
}

interface CommandManager {
	executeCommandById?: (id: string) => boolean;
}

export class NewNotePipeline {
	private jobs = new WeakMap<TFile, Promise<TFile>>();
	private rootBooleanTimer: number | null = null;
	private lastValidRootPrefix = false;

	constructor(
		private readonly plugin: Plugin,
		private readonly sorting: SortingCoordinator,
	) {}

	async start(): Promise<void> {
		await ensureRootWorkflowProperties(this.plugin.app);
		this.readRootBoolean();
		await this.normalizeTemplateLinks();
		this.plugin.registerEvent(
			this.plugin.app.vault.on("create", (item) => {
				if (item instanceof TFile && item.extension === "md") {
					window.setTimeout(() => void this.process(item), 100);
				}
			}),
		);
		this.plugin.registerEvent(
			this.plugin.app.metadataCache.on("changed", (file) => {
				if (file.path === "index.md") this.guardRootBoolean();
				if (file.name === "index.md")
					void this.normalizeTemplateLink(file);
			}),
		);
	}

	process(file: TFile, options: ProcessOptions = {}): Promise<TFile> {
		const existing = this.jobs.get(file);
		if (existing) return existing;
		const job = this.run(file, options).finally(() =>
			this.jobs.delete(file),
		);
		this.jobs.set(file, job);
		return job;
	}

	private async run(file: TFile, options: ProcessOptions): Promise<TFile> {
		if (
			file.extension !== "md" ||
			file.path === "index.md" ||
			file.path.startsWith("templates/")
		) {
			return file;
		}

		const rules = effectiveNoteRules(this.plugin.app, file);
		let current = file;
		if (!options.skipPrefix) {
			const basename = prefixedBasename(current, rules);
			if (basename) {
				const prefixLength = basename.length - current.basename.length;
				await this.plugin.app.fileManager.renameFile(
					current,
					uniquePath(this.plugin, current, basename),
				);
				if (options.openRenameEditor !== false) {
					const commands = (
						this.plugin.app as typeof this.plugin.app & {
							commands?: CommandManager;
						}
					).commands;
					commands?.executeCommandById?.("workspace:edit-file-title");
					selectFilenameSuffix(prefixLength);
				}
			}
		}

		const dateManager = resolveDateManagerConfiguration(this.plugin.app);
		await ensureDateFields(this.plugin.app, current, dateManager);
		if (rules.templateLink) {
			await applyMarkdownTemplate(
				this.plugin.app,
				current,
				rules.templateLink,
				dateManager,
			);
		}
		this.sorting.request(`new note: ${current.path}`);
		return current;
	}

	private readRootBoolean(): void {
		const root = this.plugin.app.vault.getAbstractFileByPath("index.md");
		if (!(root instanceof TFile)) return;
		const value =
			this.plugin.app.metadataCache.getFileCache(root)?.frontmatter?.[
				"add-date-to-new-notes"
			];
		if (typeof value === "boolean") this.lastValidRootPrefix = value;
	}

	private guardRootBoolean(): void {
		const root = this.plugin.app.vault.getAbstractFileByPath("index.md");
		if (!(root instanceof TFile)) return;
		const value =
			this.plugin.app.metadataCache.getFileCache(root)?.frontmatter?.[
				"add-date-to-new-notes"
			];
		if (typeof value === "boolean") {
			this.lastValidRootPrefix = value;
			if (this.rootBooleanTimer !== null)
				window.clearTimeout(this.rootBooleanTimer);
			this.rootBooleanTimer = null;
			return;
		}
		if (this.rootBooleanTimer !== null) return;
		this.rootBooleanTimer = window.setTimeout(() => {
			this.rootBooleanTimer = null;
			void this.restoreRootBoolean();
		}, 15_000);
	}

	private async restoreRootBoolean(): Promise<void> {
		const root = this.plugin.app.vault.getAbstractFileByPath("index.md");
		if (!(root instanceof TFile)) return;
		await this.plugin.app.fileManager.processFrontMatter(
			root,
			(metadata) => {
				if (typeof metadata["add-date-to-new-notes"] !== "boolean") {
					metadata["add-date-to-new-notes"] =
						this.lastValidRootPrefix;
				}
			},
		);
		new Notice(
			"Restored add-date-to-new-notes to its last valid Boolean value.",
		);
	}

	private async normalizeTemplateLinks(): Promise<void> {
		for (const file of this.plugin.app.vault.getMarkdownFiles()) {
			if (file.name === "index.md")
				await this.normalizeTemplateLink(file);
		}
	}

	private async normalizeTemplateLink(file: TFile): Promise<void> {
		const value =
			this.plugin.app.metadataCache.getFileCache(file)?.frontmatter?.[
				"new-note-template"
			];
		if (typeof value !== "string" || !value.trim()) return;
		const canonical = canonicalTemplateLink(value);
		if (!canonical || canonical === value) return;
		await this.plugin.app.fileManager.processFrontMatter(
			file,
			(metadata) => {
				if (metadata["new-note-template"] === value)
					metadata["new-note-template"] = canonical;
			},
		);
	}

	dispose(): void {
		if (this.rootBooleanTimer !== null)
			window.clearTimeout(this.rootBooleanTimer);
		this.rootBooleanTimer = null;
	}
}
