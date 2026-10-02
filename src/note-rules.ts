import { App, TFile, TFolder, normalizePath } from "obsidian";
import {
	extractDateFromFilename,
	formatDateManagerValue,
	formatMomentDate,
	validateDateFormat,
} from "./date-format";

export interface EffectiveNoteRules {
	dateFormat: string;
	prefixDates: boolean;
	templateLink: string;
}

export interface DateManagerConfiguration {
	createdKey: string;
	updatedKey: string;
	outputFormat: string;
}

function frontmatter(app: App, file: TFile): Record<string, unknown> {
	return app.metadataCache.getFileCache(file)?.frontmatter ?? {};
}

function ancestorFolders(file: TFile): TFolder[] {
	const folders: TFolder[] = [];
	let current = file.parent;
	while (current && !current.isRoot()) {
		folders.push(current);
		current = current.parent;
	}
	return folders;
}

function boolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function linkValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return value.trim();
}

export function effectiveNoteRules(app: App, file: TFile): EffectiveNoteRules {
	const root = app.vault.getAbstractFileByPath("index.md");
	const rootFrontmatter = root instanceof TFile ? frontmatter(app, root) : {};
	let prefixDates: boolean | undefined;
	let templateLink: string | undefined;

	for (const folder of ancestorFolders(file)) {
		const index = app.vault.getAbstractFileByPath(
			normalizePath(`${folder.path}/index.md`),
		);
		if (!(index instanceof TFile)) continue;
		const metadata = frontmatter(app, index);
		prefixDates ??= boolean(metadata["prefix-new-dates"]);
		templateLink ??= linkValue(metadata["new-note-template"]);
	}

	const rootFormat = rootFrontmatter["template-date-format"];
	return {
		dateFormat:
			(typeof rootFormat === "string" &&
				validateDateFormat(rootFormat)) ||
			"DD.MM.YYYY",
		prefixDates:
			prefixDates ??
			boolean(rootFrontmatter["add-date-to-new-notes"]) ??
			false,
		templateLink:
			templateLink ??
			linkValue(rootFrontmatter["new-note-template"]) ??
			"",
	};
}

export function canonicalTemplateLink(value: string): string {
	const trimmed = value.trim().replace(/^['"]|['"]$/g, "");
	const match = /^\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]$/.exec(
		trimmed,
	);
	const path = (match?.[1] ?? trimmed).trim();
	return path ? `[[${path}]]` : "";
}

export function templatePathFromLink(value: string): string {
	const canonical = canonicalTemplateLink(value);
	return canonical.slice(2, -2);
}

export function splitFrontmatter(content: string): {
	head: string;
	body: string;
} {
	if (!content.startsWith("---")) return { head: "", body: content };
	const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(content);
	return match
		? { head: match[0], body: content.slice(match[0].length) }
		: { head: "", body: content };
}

export function resolveDateManagerConfiguration(
	app: App,
): DateManagerConfiguration {
	const manager = (
		app as App & {
			plugins?: {
				plugins?: Record<
					string,
					{ settings?: Record<string, unknown> }
				>;
			};
		}
	).plugins?.plugins?.["frontmatter-date-manager"]?.settings;
	return {
		createdKey:
			typeof manager?.headerCreated === "string"
				? manager.headerCreated
				: "created",
		updatedKey:
			typeof manager?.headerUpdated === "string"
				? manager.headerUpdated
				: "updated",
		outputFormat:
			typeof manager?.dateFormat === "string"
				? manager.dateFormat
				: "yyyy-MM-dd'T'HH:mm:ss",
	};
}

export async function ensureRootWorkflowProperties(app: App): Promise<void> {
	const root = app.vault.getAbstractFileByPath("index.md");
	if (!(root instanceof TFile)) return;
	await app.fileManager.processFrontMatter(root, (metadata) => {
		if (
			!validateDateFormat(String(metadata["template-date-format"] ?? ""))
		) {
			metadata["template-date-format"] = "DD.MM.YYYY";
		}
		if (typeof metadata["add-date-to-new-notes"] !== "boolean") {
			metadata["add-date-to-new-notes"] = false;
		}
	});
}

export async function ensureDateFields(
	app: App,
	file: TFile,
	configuration: DateManagerConfiguration,
	now = new Date(),
): Promise<void> {
	const value = formatDateManagerValue(now, configuration.outputFormat);
	await app.fileManager.processFrontMatter(file, (metadata) => {
		if (!(configuration.createdKey in metadata))
			metadata[configuration.createdKey] = value;
		if (!(configuration.updatedKey in metadata))
			metadata[configuration.updatedKey] = value;
	});
}

export async function applyMarkdownTemplate(
	app: App,
	file: TFile,
	templateLink: string,
	configuration: DateManagerConfiguration,
): Promise<boolean> {
	const target = templatePathFromLink(templateLink);
	if (!target) return false;
	const template = app.metadataCache.getFirstLinkpathDest(target, file.path);
	if (
		!(template instanceof TFile) ||
		template.extension !== "md" ||
		template.path === file.path
	)
		return false;

	const templateContent = await app.vault.cachedRead(template);
	const templateBody = splitFrontmatter(templateContent).body.trim();
	const templateMetadata = frontmatter(app, template);
	const excluded = new Set([
		"created",
		"updated",
		configuration.createdKey.toLowerCase(),
		configuration.updatedKey.toLowerCase(),
	]);
	await app.fileManager.processFrontMatter(file, (metadata) => {
		for (const [key, value] of Object.entries(templateMetadata)) {
			if (excluded.has(key.toLowerCase()) || key in metadata) continue;
			metadata[key] = structuredClone(value);
		}
	});

	if (!templateBody) return true;
	await app.vault.process(file, (current) => {
		const targetParts = splitFrontmatter(current);
		const body = targetParts.body.trim();
		if (body === templateBody || body.startsWith(`${templateBody}\n`))
			return current;
		const merged = body
			? `${templateBody}\n\n${body}\n`
			: `${templateBody}\n`;
		return targetParts.head + merged;
	});
	return true;
}

export function prefixedBasename(
	file: TFile,
	rules: EffectiveNoteRules,
	now = new Date(),
): string | null {
	if (
		!rules.prefixDates ||
		extractDateFromFilename(file.basename, rules.dateFormat)
	)
		return null;
	return `${formatMomentDate(now, rules.dateFormat)}_${file.basename}`;
}
