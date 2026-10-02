import { Notice, Plugin, normalizePath } from "obsidian";
import { formatMomentDate } from "./date-format";
import { effectiveNoteRules } from "./note-rules";
import type { NewNotePipeline } from "./new-note-pipeline";
import type { RootBooksWorkspaceSettings } from "./types";

interface CommandManager {
	executeCommandById?: (id: string) => boolean;
}

function destinationFolder(plugin: Plugin): string {
	const active = plugin.app.workspace.getActiveFile();
	if (!active?.parent || active.parent.isRoot()) return "";
	return active.parent.path;
}

function unusedPath(plugin: Plugin, folder: string, basename: string): string {
	for (let suffix = 0; suffix < 10_000; suffix += 1) {
		const name = suffix === 0 ? basename : `${basename}-${suffix + 1}`;
		const path = normalizePath(`${folder ? `${folder}/` : ""}${name}.md`);
		if (!plugin.app.vault.getAbstractFileByPath(path)) return path;
	}
	throw new Error("Could not find an unused unique-note filename");
}

export function registerUniqueNoteAction(
	plugin: Plugin,
	settings: RootBooksWorkspaceSettings,
	pipeline: NewNotePipeline,
): void {
	const create = async (): Promise<void> => {
		try {
			const folder = destinationFolder(plugin);
			const reference =
				plugin.app.workspace.getActiveFile() ??
				plugin.app.vault
					.getMarkdownFiles()
					.find((file) => file.parent?.path === folder);
			const rules = reference
				? effectiveNoteRules(plugin.app, reference)
				: {
						dateFormat: settings.lastValidDateFormat,
						prefixDates: false,
						templateLink: "",
					};
			const format = [
				rules.dateFormat,
				settings.optionalFilenameTimeFormat.trim(),
			]
				.filter(Boolean)
				.join(" ");
			const basename = formatMomentDate(new Date(), format);
			const file = await plugin.app.vault.create(
				unusedPath(plugin, folder, basename),
				"",
			);
			await plugin.app.workspace.getLeaf(false).openFile(file);
			await pipeline.process(file, {
				skipPrefix: true,
				openRenameEditor: false,
			});
			const commands = (
				plugin.app as typeof plugin.app & { commands?: CommandManager }
			).commands;
			commands?.executeCommandById?.("workspace:edit-file-title");
		} catch (error) {
			new Notice(
				`Could not create the unique note: ${String(error)}`,
				8_000,
			);
		}
	};

	plugin.addRibbonIcon(
		"file-plus-2",
		"Create new unique note",
		() => void create(),
	);
	plugin.addCommand({
		id: "create-unique-note",
		name: "Create new unique note",
		callback: () => void create(),
	});
}
