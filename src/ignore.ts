import ignore from 'ignore';
import { TAbstractFile, TFolder } from 'obsidian';
import type ScopeTabsPlugin from './main';

/** Edits only literal anchored entries; other user rules and comments are retained. */
export class BookIgnoreService {
	private matcher = ignore();
	private source = '';
	private queue: Promise<void> = Promise.resolve();
	readonly revealedBooks = new Set<string>();
	constructor(private readonly plugin: ScopeTabsPlugin) {}

	async load(): Promise<boolean> {
		const adapter = this.plugin.app.vault.adapter;
		const source = await adapter.exists('.obsidianignore') ? await adapter.read('.obsidianignore') : '';
		if (source === this.source) return false;
		this.source = source;
		this.matcher = ignore().add(this.source.replace(/^\.\//gm, '/'));
		return true;
	}

	isHidden(item: TAbstractFile): boolean {
		return !!item.path && this.matcher.ignores(item.path + (item instanceof TFolder ? '/' : ''));
	}

	entries(): string[] {
		return this.source.split(/\r?\n/).filter((line) => line.startsWith('/') || line.startsWith('./'));
	}

	async add(item: TAbstractFile): Promise<void> {
		// Escape glob metacharacters so a filename cannot accidentally hide unrelated paths.
		const path = escapeLiteralPath(item.path);
		await this.edit((source) => {
			const entry = `/${path}${item instanceof TFolder ? '/' : ''}`;
			if (source.split(/\r?\n/).includes(entry)) return source;
			const newline = source.includes('\r\n') ? '\r\n' : '\n';
			return source + (source && !source.endsWith('\n') ? newline : '') + entry + newline;
		});
	}

	async remove(entry: string): Promise<void> {
		await this.edit((source) => mapLines(source, (line) => line === entry ? null : line));
	}

	/** Rename exact file exclusions only; wildcard, directory, and unanchored rules stay untouched. */
	async renameExactPaths(moves: Array<{ from: string; to: string }>): Promise<() => Promise<void>> {
		if (!moves.length) return async () => undefined;
		const destinations = new Map(moves.map(({ from, to }) => [from, to]));
		let before = '', after = '';
		await this.edit((source) => {
			before = source;
			after = mapLines(source, (line) => {
			const literal = parseLiteralFileRule(line);
			const destination = literal && destinations.get(literal.path);
			return destination ? `${literal.prefix}${escapeLiteralPath(destination)}${literal.trailingSpaces}` : line;
			});
			return after;
		});
		return async () => {
			if (before === after) return;
			await this.edit((source) => {
				if (source === before) return source;
				if (source !== after) throw new Error('Cannot restore ignore rules because they changed after the config rename.');
				return before;
			});
		};
	}

	private async edit(change: (source: string) => string): Promise<void> {
		const result = this.queue.then(async () => {
			await this.load();
			const next = change(this.source);
			if (next === this.source) return;
			await this.plugin.app.vault.adapter.write('.obsidianignore', next);
			await this.load();
			this.plugin.decorations.refresh();
		});
		this.queue = result.catch(() => undefined);
		return result;
	}
}

function escapeLiteralPath(path: string): string { return path.replace(/[\\*?[\]#! ]/g, '\\$&'); }

/** Keep each line's original terminator, including an unterminated final line. */
function mapLines(source: string, change: (line: string) => string | null): string {
	return source.replace(/([^\r\n]*)(\r\n|\n|$)/g, (_match, line: string, ending: string) => {
		const next = change(line);
		return next === null ? '' : next + ending;
	});
}

function parseLiteralFileRule(line: string): { path: string; prefix: string; trailingSpaces: string } | null {
	const prefix = line.startsWith('./') ? './' : line.startsWith('/') ? '/' : '';
	if (!prefix) return null;
	let path = '', trailingSpaces = '';
	for (let i = prefix.length; i < line.length; i++) {
		const character = line[i]!;
		if (character === '\\') {
			if (++i === line.length) return null;
			path += trailingSpaces + line[i]!;
			trailingSpaces = '';
		} else if ('*?['.includes(character)) return null;
		else if (character === ' ') trailingSpaces += character;
		else { path += trailingSpaces + character; trailingSpaces = ''; }
	}
	return path && !path.endsWith('/') ? { path, prefix, trailingSpaces } : null;
}
