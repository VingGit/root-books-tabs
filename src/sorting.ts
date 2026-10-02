import { App, Plugin } from "obsidian";

const CUSTOM_SORT_COMMAND = "custom-sort:enable-custom-sorting";

interface CommandManager {
	executeCommandById?: (id: string) => boolean;
}

function commandManager(app: App): CommandManager | undefined {
	return (app as App & { commands?: CommandManager }).commands;
}

function inlineRenameActive(): boolean {
	const active = document.activeElement;
	if (
		active instanceof HTMLInputElement ||
		active instanceof HTMLTextAreaElement ||
		(active instanceof HTMLElement && active.isContentEditable)
	) {
		return Boolean(
			active.closest(
				".nav-files-container, .workspace-leaf-content[data-type='file-explorer']",
			),
		);
	}
	return Boolean(
		document.querySelector(
			".nav-file-title.is-being-renamed, .nav-folder-title.is-being-renamed, .nav-file-title-content[contenteditable='true'], .nav-folder-title-content[contenteditable='true']",
		),
	);
}

export class SortingCoordinator {
	private timer: number | null = null;
	private disposed = false;
	private pendingReasons = new Set<string>();

	constructor(private readonly plugin: Plugin) {}

	request(reason: string): void {
		if (this.disposed) return;
		this.pendingReasons.add(reason);
		this.schedule(250);
	}

	private schedule(delay: number): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => this.flush(), delay);
	}

	private flush(): void {
		this.timer = null;
		if (this.disposed || this.pendingReasons.size === 0) return;
		if (inlineRenameActive()) {
			this.schedule(150);
			return;
		}
		const executed = commandManager(this.plugin.app)?.executeCommandById?.(
			CUSTOM_SORT_COMMAND,
		);
		if (executed) this.pendingReasons.clear();
		else this.schedule(1_000);
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
		this.pendingReasons.clear();
	}
}
