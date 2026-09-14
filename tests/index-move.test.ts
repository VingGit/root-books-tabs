import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { IndexMoveController } from '../src/index-move';
import { TAbstractFile, TFile, TFolder } from './obsidian-mock';

function fixture(decision: 'block' | 'merge-frontmatter' = 'block') {
	const files = new Map<string, TAbstractFile>();
	const frontmatter = new Map<string, Record<string, unknown>>();
	const bodies = new Map<string, string>();
	const root = new TFolder(''); files.set('', root);
	const add = <T extends TAbstractFile>(file: T, values: Record<string, unknown> = {}, body = ''): T => {
		file.parent = files.get(file.path.split('/').slice(0, -1).join('/')) as TFolder;
		file.parent.children.push(file); files.set(file.path, file);
		if (file instanceof TFile) {
			frontmatter.set(file.path, values);
			bodies.set(file.path, `---\n${JSON.stringify(values)}\n---\n${body}`);
		}
		return file;
	};
	add(new TFolder('Book A')); add(new TFolder('Book B'));
	const source = add(new TFile('Book A/index.md'), { fileOrder: ['a.md'], source: 'copy' }, 'Source');
	const destination = add(new TFile('Book B/index.md'), { fileOrder: ['b.md'], destination: 'keep' }, 'Destination');
	const ordinary = add(new TFile('Book A/note.md'));
	add(new TFolder('templates'));
	const excludedIndex = add(new TFile('templates/index.md'));
	const rootIndex = add(new TFile('index.md'));
	let ordinaryMoves = 0;
	const manager = {
		processFrontMatter: async (file: TFile, change: (values: Record<string, unknown>) => void) => {
			const values = frontmatter.get(file.path) ?? {}; change(values); frontmatter.set(file.path, values);
		},
		renameFile: async (file: TAbstractFile, nextPath: string) => { file.path = nextPath; ordinaryMoves++; },
		trashFile: async (file: TAbstractFile) => { files.delete(file.path); },
	};
	const original = manager.renameFile;
	const plugin = {
		settings: { configFileBaseName: 'index', colorFrontmatterProperty: 'color', tabTextFrontmatterProperty: 'tab-text-bg', indexMoveDecision: decision },
		scopeResolver: { resolveFile: (file: TFile) => /^Book [AB]\//.test(file.path) ? { id: file.path.split('/')[0] } : null },
		saveSettings: async () => undefined,
		decorations: { refresh: () => undefined },
		bookOrder: { refresh: () => undefined, ensureConfig: async (folder: TFolder) => files.get(`${folder.path}/index.md`), syncStructure: async () => undefined },
		app: {
			fileManager: manager,
			vault: {
				getFolderByPath: (path: string) => files.get(path) instanceof TFolder ? files.get(path) : null,
				getAbstractFileByPath: (path: string) => files.get(path) ?? null,
				read: async (file: TFile) => bodies.get(file.path) ?? '',
				process: async (file: TFile, change: (content: string) => string) => { bodies.set(file.path, change(bodies.get(file.path) ?? '')); },
				create: async (path: string, body = '') => add(new TFile(path), {}, body),
				delete: async (file: TFile) => { files.delete(file.path); },
			},
		},
	};
	return { controller: new IndexMoveController(plugin as never), destination, excludedIndex, frontmatter, manager, ordinary, ordinaryMoves: () => ordinaryMoves, original, rootIndex, source };
}

test('index move guard blocks cross-folder moves, permits ordinary moves, and restores its patch', async () => {
	const f = fixture();
	f.controller.install();
	await f.manager.renameFile(f.source, 'Book B/index.md');
	assert.equal(f.source.path, 'Book A/index.md');
	assert.equal(f.ordinaryMoves(), 0);
	await f.manager.renameFile(f.ordinary, 'Book B/note.md');
	assert.equal(f.ordinary.path, 'Book B/note.md');
	assert.equal(f.ordinaryMoves(), 1);
	await f.manager.renameFile(f.rootIndex, 'Book A/index.md');
	assert.equal(f.rootIndex.path, 'index.md');
	assert.equal(f.ordinaryMoves(), 1);
	await f.manager.renameFile(f.excludedIndex, 'templates/moved-index.md');
	assert.equal(f.excludedIndex.path, 'templates/moved-index.md');
	assert.equal(f.ordinaryMoves(), 2);
	f.controller.uninstall();
	assert.equal(f.manager.renameFile, f.original);
});

test('remembered transfer copies user frontmatter while keeping location-owned fields and both paths', async () => {
	const f = fixture('merge-frontmatter');
	f.controller.install();
	await f.manager.renameFile(f.source, 'Book B/index.md');
	assert.equal(f.source.path, 'Book A/index.md');
	assert.equal(f.destination.path, 'Book B/index.md');
	assert.deepEqual(f.frontmatter.get(f.destination.path)?.fileOrder, ['b.md']);
	assert.equal(f.frontmatter.get(f.destination.path)?.source, 'copy');
	assert.equal(f.frontmatter.get(f.destination.path)?.destination, 'keep');
});
