import { Plugin, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import {
	BookAppearanceModal,
	BookPickerModal,
	bookIdForPath,
	collectBooks,
} from "./book-metadata";
import type { BookRecord, RootBooksWorkspaceSettings } from "./types";

interface FileBackedView {
	file?: TFile | null;
}

interface DecoratableLeaf extends WorkspaceLeaf {
	tabHeaderEl?: HTMLElement;
}

function fileForLeaf(leaf: WorkspaceLeaf): TFile | null {
	const file = (leaf.view as typeof leaf.view & FileBackedView).file;
	return file instanceof TFile ? file : null;
}

function bookForPath(books: BookRecord[], path: string): BookRecord | null {
	const id = bookIdForPath(path);
	return id ? (books.find((book) => book.id === id) ?? null) : null;
}

export class BookDecorations {
	private readonly status: HTMLElement;

	constructor(
		private readonly plugin: Plugin,
		private readonly settings: RootBooksWorkspaceSettings,
	) {
		this.status = plugin.addStatusBarItem();
		this.status.addClass("root-books-status");
		this.status.setAttribute("aria-label", "Choose a book");
		this.status.addEventListener("click", () => this.openBookPicker());
	}

	start(): void {
		this.plugin.registerEvent(
			this.plugin.app.workspace.on("active-leaf-change", () =>
				this.refresh(),
			),
		);
		this.plugin.registerEvent(
			this.plugin.app.workspace.on("layout-change", () => this.refresh()),
		);
		this.plugin.registerEvent(
			this.plugin.app.workspace.on("file-open", () => this.refresh()),
		);
		this.plugin.registerEvent(
			this.plugin.app.metadataCache.on("changed", (file) => {
				if (file.name === "index.md") this.refresh();
			}),
		);
		this.refresh();
	}

	refresh(): void {
		const books = collectBooks(this.plugin.app);
		this.plugin.app.workspace.iterateAllLeaves((leaf) =>
			this.decorateLeaf(leaf, books),
		);
		this.renderStatus(books);
	}

	openAppearancePicker(): void {
		const books = collectBooks(this.plugin.app);
		if (books.length === 0) return;
		new BookPickerModal(this.plugin.app, books, (book) =>
			this.openAppearance(book),
		).open();
	}

	private decorateLeaf(leaf: WorkspaceLeaf, books: BookRecord[]): void {
		const header = (leaf as DecoratableLeaf).tabHeaderEl;
		if (!header) return;
		header
			.querySelectorAll(".root-books-tab-label")
			.forEach((element) => element.remove());
		header.classList.remove("root-books-tab");
		header.style.removeProperty("--root-books-accent");
		header.removeAttribute("data-root-book");

		const file = fileForLeaf(leaf);
		const book = file ? bookForPath(books, file.path) : null;
		if (!book) return;
		header.dataset.rootBook = book.id;
		header.style.setProperty("--root-books-accent", book.panel.accent);
		if (this.settings.colorTabs) header.classList.add("root-books-tab");
		if (!this.settings.showBookLabel) return;

		const label = header.createSpan({ cls: "root-books-tab-label" });
		const icon = label.createSpan({ cls: "root-books-tab-label-icon" });
		setIcon(icon, book.panel.icon.replace(/^lucide:/, ""));
		label.createSpan({ text: book.name });
		label.setAttribute("aria-label", `Edit appearance for ${book.name}`);
		label.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.openAppearance(book);
		});
	}

	private renderStatus(books: BookRecord[]): void {
		this.status.empty();
		const active = this.plugin.app.workspace.getActiveFile();
		const book = active ? bookForPath(books, active.path) : null;
		const icon = this.status.createSpan({ cls: "root-books-status-icon" });
		setIcon(
			icon,
			(book?.panel.icon ?? "lucide:library").replace(/^lucide:/, ""),
		);
		this.status.createSpan({ text: book?.name ?? "Books" });
		this.status.style.setProperty(
			"--root-books-accent",
			book?.panel.accent ?? "#64748b",
		);
	}

	private openBookPicker(): void {
		const books = collectBooks(this.plugin.app);
		if (books.length === 0) return;
		new BookPickerModal(this.plugin.app, books, (book) => {
			const file = this.plugin.app.vault.getAbstractFileByPath(
				book.indexPath,
			);
			if (file instanceof TFile)
				void this.plugin.app.workspace.getLeaf(false).openFile(file);
		}).open();
	}

	private openAppearance(book: BookRecord): void {
		new BookAppearanceModal(this.plugin.app, book, () =>
			this.refresh(),
		).open();
	}

	dispose(): void {
		this.plugin.app.workspace.iterateAllLeaves((leaf) => {
			const header = (leaf as DecoratableLeaf).tabHeaderEl;
			if (!header) return;
			header
				.querySelectorAll(".root-books-tab-label")
				.forEach((element) => element.remove());
			header.classList.remove("root-books-tab");
			header.style.removeProperty("--root-books-accent");
			header.removeAttribute("data-root-book");
		});
		this.status.remove();
	}
}
