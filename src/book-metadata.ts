import {
	App,
	FuzzySuggestModal,
	Modal,
	Notice,
	Setting,
	TFile,
	TFolder,
	setIcon,
} from "obsidian";
import type { BookPanelMetadata, BookRecord } from "./types";

export const DEFAULT_PANEL: BookPanelMetadata = {
	icon: "lucide:book-open",
	accent: "#0ea5e9",
};

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const LUCIDE_ICON = /^lucide:[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function normalizeAccent(value: unknown): string | null {
	return typeof value === "string" && HEX_COLOR.test(value.trim())
		? value.trim().toLowerCase()
		: null;
}

export function normalizeIcon(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	return LUCIDE_ICON.test(normalized) ? normalized : null;
}

export function legacyIconToPortable(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim().toLowerCase();
	if (normalizeIcon(normalized)) return normalized;
	return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)
		? `lucide:${normalized}`
		: null;
}

function ownRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export function panelFromFrontmatter(frontmatter: unknown): BookPanelMetadata {
	const record = ownRecord(frontmatter);
	const panel = ownRecord(record?.panel);
	return {
		icon: normalizeIcon(panel?.icon) ?? DEFAULT_PANEL.icon,
		accent: normalizeAccent(panel?.accent) ?? DEFAULT_PANEL.accent,
	};
}

export function bookIdForPath(path: string): string | null {
	const [first, second] = path.split("/");
	return first && second ? first : null;
}

function displayTitle(app: App, index: TFile, fallback: string): string {
	const title = app.metadataCache.getFileCache(index)?.frontmatter?.title;
	return typeof title === "string" && title.trim() ? title.trim() : fallback;
}

export function collectBooks(app: App): BookRecord[] {
	return app.vault
		.getRoot()
		.children.filter(
			(child): child is TFolder =>
				child instanceof TFolder && child.name !== "templates",
		)
		.map((folder) => {
			const index = app.vault.getAbstractFileByPath(
				`${folder.path}/index.md`,
			);
			if (!(index instanceof TFile)) return null;
			return {
				id: folder.path,
				name: displayTitle(app, index, folder.name),
				folderPath: folder.path,
				indexPath: index.path,
				panel: panelFromFrontmatter(
					app.metadataCache.getFileCache(index)?.frontmatter,
				),
			};
		})
		.filter((book): book is BookRecord => book !== null)
		.sort((left, right) => left.name.localeCompare(right.name));
}

export async function migrateLegacyBookMetadata(app: App): Promise<number> {
	let changedFiles = 0;
	for (const book of collectBooks(app)) {
		const file = app.vault.getAbstractFileByPath(book.indexPath);
		if (!(file instanceof TFile)) continue;
		let changed = false;
		await app.fileManager.processFrontMatter(file, (frontmatter) => {
			const panel = ownRecord(frontmatter.panel) ?? {};
			const legacySection = ownRecord(frontmatter["book-tabs"]);
			const legacyAccent =
				normalizeAccent(panel.accent) ??
				normalizeAccent(legacySection?.color) ??
				normalizeAccent(frontmatter.color);
			const portableIcon = legacyIconToPortable(panel.icon);

			if (legacyAccent && panel.accent !== legacyAccent) {
				panel.accent = legacyAccent;
				changed = true;
			}
			if (portableIcon && panel.icon !== portableIcon) {
				panel.icon = portableIcon;
				changed = true;
			}
			if (!panel.icon) {
				panel.icon = DEFAULT_PANEL.icon;
				changed = true;
			}
			if (!panel.accent) {
				panel.accent = DEFAULT_PANEL.accent;
				changed = true;
			}
			frontmatter.panel = panel;

			if (legacySection && "color" in legacySection) {
				delete legacySection.color;
				changed = true;
			}
			if (legacySection && "tab-text-bg" in legacySection) {
				delete legacySection["tab-text-bg"];
				changed = true;
			}
			if (legacySection && Object.keys(legacySection).length === 0) {
				delete frontmatter["book-tabs"];
			}
			if (normalizeAccent(frontmatter.color)) {
				delete frontmatter.color;
				changed = true;
			}
			if ("tab-text-bg" in frontmatter) {
				delete frontmatter["tab-text-bg"];
				changed = true;
			}
		});
		if (changed) changedFiles += 1;
	}
	return changedFiles;
}

export async function saveBookPanel(
	app: App,
	book: BookRecord,
	panel: BookPanelMetadata,
): Promise<void> {
	const accent = normalizeAccent(panel.accent);
	const icon = normalizeIcon(panel.icon);
	if (!accent || !icon)
		throw new Error("Use a six-digit hex accent and lucide:<name> icon");
	const file = app.vault.getAbstractFileByPath(book.indexPath);
	if (!(file instanceof TFile))
		throw new Error(`Missing book index: ${book.indexPath}`);
	await app.fileManager.processFrontMatter(file, (frontmatter) => {
		frontmatter.panel = { icon, accent };
	});
}

export class BookAppearanceModal extends Modal {
	constructor(
		app: App,
		private readonly book: BookRecord,
		private readonly onSaved: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(`Book appearance — ${this.book.name}`);
		let accent = this.book.panel.accent;
		let icon = this.book.panel.icon;

		new Setting(this.contentEl)
			.setName("Accent color")
			.setDesc("Stored as a direct hexadecimal value in panel.accent.")
			.addColorPicker((picker) =>
				picker.setValue(accent).onChange((value) => (accent = value)),
			)
			.addText((text) =>
				text
					.setValue(accent)
					.onChange((value) => (accent = value.trim())),
			);

		new Setting(this.contentEl)
			.setName("Lucide icon")
			.setDesc("Use the shared form lucide:book-open.")
			.addText((text) =>
				text.setValue(icon).onChange((value) => (icon = value.trim())),
			);

		const preview = this.contentEl.createDiv({
			cls: "root-books-panel-preview",
		});
		const iconEl = preview.createSpan();
		setIcon(iconEl, icon.replace(/^lucide:/, ""));
		preview.createSpan({ text: this.book.name });
		preview.style.setProperty("--root-books-accent", accent);

		new Setting(this.contentEl).addButton((button) =>
			button
				.setButtonText("Save appearance")
				.setCta()
				.onClick(async () => {
					try {
						await saveBookPanel(this.app, this.book, {
							accent,
							icon,
						});
						this.onSaved();
						this.close();
					} catch (error) {
						new Notice(
							error instanceof Error
								? error.message
								: String(error),
						);
					}
				}),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class BookPickerModal extends FuzzySuggestModal<BookRecord> {
	constructor(
		app: App,
		private readonly books: BookRecord[],
		private readonly onChoose: (book: BookRecord) => void,
	) {
		super(app);
		this.setPlaceholder("Choose a book");
	}

	getItems(): BookRecord[] {
		return this.books;
	}

	getItemText(book: BookRecord): string {
		return book.name;
	}

	onChooseItem(book: BookRecord): void {
		this.onChoose(book);
	}
}
