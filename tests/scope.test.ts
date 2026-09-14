import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { FirstLevelFolderScopeResolver } from '../src/scope';
import { TAbstractFile, TFile, TFolder } from './obsidian-mock';

function fixture(excluded: string[]) {
	const root = new TFolder('');
	const files = new Map<string, TAbstractFile>([['', root]]);
	const addFolder = (path: string): TFolder => {
		const folder = new TFolder(path); folder.parent = root; root.children.push(folder); files.set(path, folder); return folder;
	};
	const addFile = (path: string, parent: TFolder): TFile => {
		const file = new TFile(path); file.parent = parent; parent.children.push(file); files.set(path, file); return file;
	};
	const books = addFolder('Books 2'), first = addFolder('Books 1'), templates = addFolder('templates');
	const bookFile = addFile('Books 1/note.md', first), templateFile = addFile('templates/example.md', templates);
	const resolver = new FirstLevelFolderScopeResolver({
		getRoot: () => root,
		getAbstractFileByPath: (path: string) => files.get(path) ?? null,
	} as never, () => excluded);
	return { resolver, books, bookFile, templateFile };
}

test('excluded first-level folders are omitted from books and resolve as unscoped', () => {
	const f = fixture(['./templates/', 'nested/path', '']);
	assert.deepEqual(f.resolver.listBooks().map(book => book.id), ['Books 1', 'Books 2']);
	assert.deepEqual(f.resolver.listExcludedFolders().map(folder => folder.id), ['templates']);
	assert.equal(f.resolver.resolveFile(f.templateFile as never), null);
	assert.equal(f.resolver.resolveExcludedFile(f.templateFile as never)?.id, 'templates');
	assert.equal(f.resolver.resolveExcludedFile(f.bookFile as never), null);
	assert.equal(f.resolver.resolveFile(f.bookFile as never)?.id, 'Books 1');
	assert.equal(f.resolver.hasMultipleBooks(), true);
});

test('excluded folders do not count toward the multiple-book routing threshold', () => {
	const f = fixture(['templates', 'Books 2']);
	assert.deepEqual(f.resolver.listBooks().map(book => book.id), ['Books 1']);
	assert.equal(f.resolver.hasMultipleBooks(), false);
});
