export class TAbstractFile {
	parent: TFolder | null = null;
	constructor(public path: string) {}
	get name(): string { return this.path.split('/').pop()!; }
}
export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];
	isRoot(): boolean { return this.path === ''; }
}
export class TFile extends TAbstractFile {
	stat = { ctime: 100000, mtime: 200000, size: 1 };
	get basename(): string { return this.name.replace(/\.[^.]+$/, ""); }
    get extension(): string { return this.path.split('.').pop()!; }
}

// Tests serialize frontmatter as JSON, which is also valid YAML.
export const parseYaml = (text: string): unknown => text.trim() ? JSON.parse(text) : null;
export function getFrontMatterInfo(text: string): { exists: boolean; frontmatter: string; contentStart: number } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
	return { exists: Boolean(match), frontmatter: match?.[1] ?? '', contentStart: match?.[0].length ?? 0 };
}
export class Notice { constructor(_message: string) {} }
export class FileView { file: TFile | null = null; }
export class WorkspaceLeaf {}
export class WorkspaceWindow {}
export class Modal {
	contentEl!: HTMLElement;
	titleEl!: HTMLElement;
	constructor(_app: unknown) {}
	open(): void {}
	close(): void {}
}
export const normalizePath = (path: string): string => path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
