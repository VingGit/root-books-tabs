import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BookOrderService, dateStamp, reconcileFileOrder } from '../src/book-order';
import { TAbstractFile, TFile, TFolder } from './obsidian-mock';
import { addConfigComments, removeObsoleteGeneratedHelp, restoreConfigComments } from '../src/config-frontmatter';

function fixture(direction: 'ascending' | 'descending' = 'descending') {
	const files = new Map<string, TAbstractFile>();
	const fm = new Map<string, Record<string, unknown>>();
	const bodies = new Map<string, string>();
	const writes = { frontmatter: 0, content: 0 };
	const root = new TFolder(''); files.set('', root);
	function add<T extends TAbstractFile>(file: T, content = ''): T {
		files.set(file.path, file);
		file.parent = files.get(file.path.split('/').slice(0, -1).join('/')) as TFolder;
		file.parent.children.push(file);
		if (file instanceof TFile) bodies.set(file.path, content);
		return file;
	}
	const book = add(new TFolder('Book A')); add(new TFolder('Book B'));
	const plugin = {
		settings: {
			configFileBaseName: 'index', colorFrontmatterProperty: 'color', tabTextFrontmatterProperty: 'tab-text-bg',
			orderingDirection: direction, configNotePosition: 'top',
		},
		vaultConfig: { set: (key: string, value: unknown) => { (plugin.settings as Record<string, unknown>)[key] = value; return Promise.resolve(); } },
		scopeResolver: {
			listBooks: () => [{ id: book.path, name: book.name, folderPath: book.path }, { id: 'Book B', name: 'Book B', folderPath: 'Book B' }],
			resolveFile: (file: TAbstractFile | null) => file?.path.startsWith('Book A/') ? { id: 'Book A' } : file?.path.startsWith('Book B/') ? { id: 'Book B' } : null,
		},
		app: {
			vault: {
				getAbstractFileByPath: (path: string) => files.get(path) ?? null,
				getFileByPath: (path: string) => files.get(path) instanceof TFile ? files.get(path) : null,
				getFolderByPath: (path: string) => files.get(path) instanceof TFolder ? files.get(path) : null,
				getMarkdownFiles: () => [...files.values()].filter((file): file is TFile => file instanceof TFile && file.extension === 'md'),
				read: (file: TFile) => Promise.resolve(bodies.get(file.path) ?? ''),
				cachedRead: (file: TFile) => Promise.resolve(bodies.get(file.path) ?? ''),
				process: (file: TFile, change: (text: string) => string) => { writes.content++; bodies.set(file.path, change(bodies.get(file.path) ?? '')); return Promise.resolve(); },
				create: (path: string, content = '') => { if (files.has(path)) throw Error('exists'); return Promise.resolve(add(new TFile(path), content)); },
			},
			metadataCache: { getFileCache: (file: TFile) => ({ frontmatter: fm.get(file.path) }) },
			fileManager: {
				processFrontMatter: (file: TFile, fn: (values: Record<string, unknown>) => void) => {
					writes.frontmatter++;
					const values = fm.get(file.path) ?? {}; fn(values); fm.set(file.path, values); return Promise.resolve();
				},
				renameFile: (file: TAbstractFile, path: string) => {
					if (files.has(path)) return Promise.reject(Error('exists'));
					file.parent!.children = file.parent!.children.filter(child => child !== file);
					const values = fm.get(file.path), body = bodies.get(file.path);
					fm.delete(file.path); bodies.delete(file.path); files.delete(file.path);
					file.path = path; add(file, body); if (values) fm.set(path, values); return Promise.resolve();
				},
			},
		},
	};
	const service = new BookOrderService(plugin as never);
	return { add, files, fm, bodies, writes, book, service, scope: { id: book.path, name: book.name, folderPath: book.path } };
}

test('preparation creates portable immediate-child arrays for every visible file type', async () => {
	const f = fixture();
	const note = f.add(new TFile('Book A/note.md'), 'Note body');
	f.add(new TFile('Book A/image.png'));
	f.add(new TFile('Book A/board.canvas'));
	f.add(new TFile('Book A/table.base'));
	f.add(new TFolder('Book A/sub'));
	f.fm.set(note.path, { custom: ['keep'] });
	await f.service.prepare(f.scope);
	assert.deepEqual(f.fm.get(note.path)?.custom, ['keep']);
	assert.equal('fileOrder' in f.fm.get(note.path)!, false);
	assert.deepEqual(f.fm.get('Book A/index.md')?.fileOrder, ['board.canvas', 'image.png', 'note.md', 'sub', 'table.base']);
	assert.deepEqual(f.fm.get('Book A/sub/index.md')?.fileOrder, []);
	assert.equal(f.fm.get(note.path)?.['creation-date'], dateStamp(note.stat.ctime));
});

test('entering an already prepared book performs no vault writes', async () => {
	const f = fixture();
	f.add(new TFile('Book A/note.md'), 'Note body');
	f.add(new TFolder('Book A/sub'));
	await f.service.prepare(f.scope);
	f.writes.frontmatter = 0; f.writes.content = 0;
	await f.service.prepare(f.scope);
	assert.deepEqual(f.writes, { frontmatter: 0, content: 0 });
});

test('array repair removes stale names and inserts new names alphabetically without reordering valid entries', () => {
	assert.deepEqual(
		reconcileFileOrder(['index.md', 'z.md', 'missing.md', 'a.md', 'a.md'], ['z.md', 'm.png', 'index.md', 'a.md'], 'index.md'),
		['m.png', 'z.md', 'a.md'],
	);
	assert.deepEqual(reconcileFileOrder(undefined, ['b.md', 'index.md', 'a.md'], 'index.md'), ['a.md', 'b.md']);
});

test('create and delete events reconcile the owning directory array', async () => {
	const f = fixture();
	const a = f.add(new TFile('Book A/a.md'));
	const c = f.add(new TFile('Book A/c.png'));
	await f.service.prepare(f.scope);
	const b = f.add(new TFile('Book A/b.canvas'));
	await f.service.syncStructure(b as never);
	assert.deepEqual(f.fm.get('Book A/index.md')?.fileOrder, ['a.md', 'b.canvas', 'c.png']);
	a.parent!.children = a.parent!.children.filter(child => child !== a);
	f.files.delete(a.path);
	await f.service.syncDeleted(a.path);
	assert.deepEqual(f.fm.get('Book A/index.md')?.fileOrder, ['b.canvas', 'c.png']);
	assert.ok(c.parent);
});

test('structure events do not create config notes before a book opts into them', async () => {
	const f = fixture();
	const note = f.add(new TFile('Book A/note.md'));
	await f.service.syncStructure(note as never);
	assert.equal(f.files.has('Book A/index.md'), false);
	const sub = f.add(new TFolder('Book A/sub'));
	await f.service.syncStructure(sub as never);
	assert.equal(f.files.has('Book A/sub/index.md'), false);
});

test('startup reconciles existing config notes and namespaces plain color collisions without creating missing notes', async () => {
	const f = fixture();
	const config = f.add(new TFile('Book A/index.md'));
	f.add(new TFolder('Book A/sub'));
	f.fm.set(config.path, { color: '#123456', custom: 'keep' });
	await f.service.reconcileExistingConfigs(f.scope);
	assert.equal(f.fm.get(config.path)?.color, '#123456');
	assert.equal(f.fm.get(config.path)?.['book-tabs-color'], '#123456');
	assert.equal(f.fm.get(config.path)?.custom, 'keep');
	assert.equal(f.files.has('Book A/sub/index.md'), false);
});

test('dragging persists manual arrays for non-Markdown files and rejects cross-book moves', async () => {
	const f = fixture('ascending');
	const image = f.add(new TFile('Book A/image.png')), board = f.add(new TFile('Book A/board.canvas'));
	const sub = f.add(new TFolder('Book A/sub'));
	await f.service.prepare(f.scope);
	await f.service.move('Book A', image.path, board.path, 'before');
	assert.deepEqual(f.fm.get('Book A/index.md')?.fileOrder, ['sub', 'image.png', 'board.canvas']);
	assert.equal(f.fm.get('Book A/index.md')?.forcedOrderingType, 'manual');
	await f.service.move('Book A', image.path, sub.path, 'inside');
	assert.equal(image.path, 'Book A/sub/image.png');
	assert.deepEqual(f.fm.get('Book A/sub/index.md')?.fileOrder, ['image.png']);
	await f.service.move('Book A', image.path, 'Book B', 'inside');
	assert.equal(image.path, 'Book A/sub/image.png');
});

test('directory config notes stay fixed and cannot enter manual ordering', async () => {
	const f = fixture();
	const sub = f.add(new TFolder('Book A/sub'));
	await f.service.prepare(f.scope);
	const rootIndex = f.files.get('Book A/index.md')!;
	await assert.rejects(() => f.service.move('Book A', rootIndex.path, sub.path, 'inside'), /cannot be moved/i);
	assert.equal(rootIndex.path, 'Book A/index.md');
	assert.ok(f.files.has('Book A/sub/index.md'));
});

test('config note position is fixed while direction reverses ordinary entries', async () => {
	const f = fixture();
	const index = f.add(new TFile('Book A/index.md'));
	const a = f.add(new TFile('Book A/a.md'));
	const z = f.add(new TFile('Book A/z.md'));
	assert.ok(f.service.compare(index as never, a as never, 'alphabetical') < 0);
	assert.ok(f.service.compare(a as never, z as never, 'alphabetical') > 0);
	await f.service.setDirection('ascending');
	assert.ok(f.service.compare(a as never, z as never, 'alphabetical') < 0);
	(f.service as unknown as { plugin: { settings: { configNotePosition: string } } }).plugin.settings.configNotePosition = 'bottom';
	assert.ok(f.service.compare(index as never, z as never, 'alphabetical') > 0);
});

test('alphabetical is the default, folder overrides inherit, and type changes leave manual arrays intact', async () => {
	const f = fixture(); const sub = f.add(new TFolder('Book A/sub')); f.add(new TFile('Book A/a.md'));
	await f.service.prepare(f.scope);
	assert.equal(f.service.getType(f.book as never), 'alphabetical');
	const before = structuredClone(f.fm.get('Book A/index.md')?.fileOrder);
	await f.service.setType('Book A', 'creation-date');
	assert.equal(f.service.getType(sub as never), 'creation-date');
	assert.deepEqual(f.fm.get('Book A/index.md')?.fileOrder, before);
});

test('creation-date ordering uses generated Markdown timestamps and binary file stats', async () => {
	const f = fixture();
	const note = f.add(new TFile('Book A/note.md'), 'Original body');
	const older = f.add(new TFile('Book A/older.png')), newer = f.add(new TFile('Book A/newer.png'));
	older.stat.ctime = 1; newer.stat.ctime = 2;
	await f.service.prepare(f.scope);
	assert.equal(f.fm.get(note.path)?.['creation-date'], dateStamp(note.stat.ctime));
	assert.ok(f.service.compare(older as never, newer as never, 'creation-date') > 0);
});

test('usage comments describe manual arrays without Markdown comments', () => {
	const input = '---\ncustom: keep\nfileOrder:\n  - index.md\nforcedOrderingType: false\n---\n# Existing body\n';
	const output = addConfigComments(input);
	assert.match(output, /# Immediate child names in manual display order/);
	assert.match(output, /custom: keep/); assert.ok(output.endsWith('# Existing body\n'));
	assert.equal(addConfigComments(output), output); assert.ok(!output.includes('<!--'));
	assert.match(restoreConfigComments('---\n# Keep this explanation\ncustom: keep\n---\nBody', '---\ncustom: keep\n---\nBody'), /# Keep this explanation\ncustom: keep/);
});

test('generated help stays on the prefixed plugin field when a plain key collides', () => {
	const output = addConfigComments('---\ncolor: user-theme\nbook-tabs-color: "#abcdef"\n---\n');
	assert.ok(!output.includes('# Optional #RRGGBB book color override. Remove to use the local automatic color.\ncolor:'));
	assert.match(output, /color: user-theme\n# Optional #RRGGBB book color override[\s\S]*\nbook-tabs-color:/);
});

test('superseded generated ordering metadata is removed without changing unrelated content', () => {
	const obsoleteKey = ['wei', 'ght'].join('');
	const input = [
		'---',
		'custom: keep',
		'# False inherits the book/parent order; old or creation-date forces this folder order.',
		'forcedOrderingType: false',
		'# Integer order among siblings. Config notes default to 0 and appear first inside their own folder.',
		`${obsoleteKey}: 3`,
		'# Immediate child names in manual display order. Missing names are added; stale names are removed.',
		'fileOrder:',
		'  - index.md',
		'---',
		'',
		'<!-- Ordering: forcedOrderingType is false (inherit), old or dates. tabInsertDirection: false inherits. -->',
		'# Existing body',
		'',
	].join('\n');
	const output = removeObsoleteGeneratedHelp(input);
	assert.ok(!output.includes(`${obsoleteKey}:`));
	assert.ok(!output.includes('<!-- Ordering:'));
	assert.match(output, /custom: keep/);
	assert.match(output, /fileOrder:\n  - index\.md/);
	assert.ok(output.endsWith('# Existing body\n'));
});

test('preparation migrates superseded generated config data in place', async () => {
	const f = fixture(), obsoleteKey = ['wei', 'ght'].join('');
	const config = f.add(new TFile('Book A/index.md'), [
		'---',
		'# Integer order among siblings. Config notes default to 0 and appear first inside their own folder.',
		`${obsoleteKey}: 0`,
		'custom: keep',
		'---',
		'Body stays',
	].join('\n'));
	f.fm.set(config.path, { [obsoleteKey]: 0, custom: 'keep' });
	await f.service.prepare(f.scope);
	assert.equal(obsoleteKey in f.fm.get(config.path)!, false);
	assert.equal(f.fm.get(config.path)?.custom, 'keep');
	assert.ok(!f.bodies.get(config.path)?.includes(`${obsoleteKey}:`));
	assert.match(f.bodies.get(config.path)!, /Body stays/);
});

test('legacy generated array help keeps the plain field owned and removes an existing plugin duplicate', async () => {
	const f = fixture();
	const config = f.add(new TFile('Book A/index.md'), [
		'---',
		'# Immediate child names in manual display order. Missing names are added; stale names are removed.',
		'fileOrder:',
		'  - index.md',
		'  - missing.md',
		'book-tabs-fileOrder:',
		'  - note.md',
		'custom: keep',
		'---',
		'Body stays',
	].join('\n'));
	f.add(new TFile('Book A/note.md'));
	f.fm.set(config.path, { fileOrder: ['index.md', 'missing.md'], 'book-tabs-fileOrder': ['note.md'], custom: 'keep' });
	await f.service.prepare(f.scope);
	assert.equal('fileOrder' in f.fm.get(config.path)!, false);
	assert.deepEqual(f.fm.get(config.path)?.['book-tabs-fileOrder'], ['note.md']);
	assert.equal(f.fm.get(config.path)?.custom, 'keep');
	assert.ok(!f.bodies.get(config.path)?.includes('Missing names are added; stale names are removed.'));
	assert.match(f.bodies.get(config.path)!, /Body stays/);
});
