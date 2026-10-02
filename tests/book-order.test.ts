import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BookOrderService, dateStamp } from '../src/book-order';
import { TAbstractFile, TFile, TFolder } from './obsidian-mock';
import { addConfigComments, removeObsoleteGeneratedHelp, restoreConfigComments, updateConfigFrontmatter } from '../src/config-frontmatter';

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
			orderingDirection: direction, articleNavigatorNextProperty: 'NextArticle', articleNavigatorPreviousProperty: 'PreviousArticle',
		},
		vaultConfig: { set: (key: string, value: unknown) => { (plugin.settings as Record<string, unknown>)[key] = value; return Promise.resolve(); } },
		templates: { dateFormatForFolder: () => 'DD.MM.YYYY' },
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
			metadataCache: {
				getFileCache: (file: TFile) => ({ frontmatter: fm.get(file.path) }),
				getFirstLinkpathDest: (linkpath: string, sourcePath: string) => {
					const path = linkpath.endsWith('.md') ? linkpath : `${linkpath}.md`;
					return files.get(path) ?? files.get(`${sourcePath.split('/').slice(0, -1).join('/')}/${path}`) ?? null;
				},
			},
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
	return { add, files, fm, bodies, writes, book, service, plugin, scope: { id: book.path, name: book.name, folderPath: book.path } };
}

test('frontmatter updates preserve another writer’s values when the metadata cache lags', async () => {
	const f = fixture();
	const file = f.add(new TFile('Book A/index.md'));
	f.fm.set(file.path, { title: 'Book A', newerProperty: 'preserve' });
	f.plugin.app.metadataCache.getFileCache = () => ({ frontmatter: { title: 'old' } });
	await updateConfigFrontmatter(f.plugin.app as never, file as never, values => { values.title = 'Book A'; });
	assert.equal(f.fm.get(file.path)?.title, 'Book A');
	assert.equal(f.fm.get(file.path)?.newerProperty, 'preserve');
});

test('folder config aliases follow their parent and repair edits without replacing the body', async () => {
	const f = fixture();
	const config = f.add(new TFile('Book A/index.md'), 'Keep this body');
	f.fm.set(config.path, { aliases: ['edited'], unrelated: 'keep' });
	assert.equal(f.service.hasExpectedAlias(config as never), false);
	await f.service.syncConfig(config as never);
	assert.deepEqual(f.fm.get(config.path)?.aliases, ['Book A']);
	assert.equal(f.fm.get(config.path)?.unrelated, 'keep');
	assert.ok(f.bodies.get(config.path)?.includes('Keep this body'));
	assert.equal(f.service.hasExpectedAlias(config as never), true);
});

test('root config never receives a folder alias or folder order fields', async () => {
	const f = fixture();
	const rootConfig = f.add(new TFile('index.md'));
	f.fm.set(rootConfig.path, { aliases: ['Test vault'], rootSetting: true });
	assert.equal(f.service.hasExpectedAlias(rootConfig as never), true);
	await f.service.syncConfig(rootConfig as never);
	assert.deepEqual(f.fm.get(rootConfig.path), { aliases: ['Test vault'], rootSetting: true });
	assert.equal(f.writes.frontmatter, 0);
});

test('property ordering follows either direction links and reverses a stable chain', () => {
	const f = fixture('ascending');
	const first = f.add(new TFile('Book A/z.md'));
	const second = f.add(new TFile('Book A/a.md'));
	const third = f.add(new TFile('Book A/m.md'));
	f.fm.set(first.path, { NextArticle: '[[a]]' });
	f.fm.set(third.path, { PreviousArticle: '[[a]]' });
	const sorted = (): string[] => [third, second, first].sort((a, b) => f.service.compare(a as never, b as never, 'properties')).map(file => file.name);
	assert.deepEqual(sorted(), ['z.md', 'a.md', 'm.md']);
	f.service.setDirection('descending');
	assert.deepEqual(sorted(), ['m.md', 'a.md', 'z.md']);
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
	assert.equal((f.fm.get(config.path)?.['book-tabs'] as Record<string, unknown>)?.color, '#123456');
	assert.equal(f.fm.get(config.path)?.custom, 'keep');
	assert.equal(f.files.has('Book A/sub/index.md'), false);
});

test('hidden config notes stay fixed first while direction reverses ordinary entries', async () => {
	const f = fixture();
	const index = f.add(new TFile('Book A/index.md'));
	const a = f.add(new TFile('Book A/a.md'));
	const z = f.add(new TFile('Book A/z.md'));
	assert.ok(f.service.compare(index as never, a as never, 'alphabetical') < 0);
	assert.ok(f.service.compare(a as never, z as never, 'alphabetical') > 0);
	await f.service.setDirection('ascending');
	assert.ok(f.service.compare(a as never, z as never, 'alphabetical') < 0);
	assert.ok(f.service.compare(index as never, z as never, 'alphabetical') < 0);
});

test('creation-date ordering prefers filename dates, then frontmatter, then names', async () => {
	const f = fixture('ascending');
	const filenameOlder = f.add(new TFile('Book A/z-01.09.2026-note.md'));
	const filenameNewer = f.add(new TFile('Book A/a-02.09.2026-note.md'));
	f.fm.set(filenameOlder.path, { 'creation-date': '26-12-31 00:00:00.000' });
	f.fm.set(filenameNewer.path, { 'creation-date': '26-01-01 00:00:00.000' });
	assert.ok(f.service.compare(filenameOlder as never, filenameNewer as never, 'creation-date') < 0);

	const frontmatterOlder = f.add(new TFile('Book A/z-undated.md'));
	const frontmatterNewer = f.add(new TFile('Book A/a-undated.md'));
	f.fm.set(frontmatterOlder.path, { 'creation-date': '26-09-03 00:00:00.000' });
	f.fm.set(frontmatterNewer.path, { 'creation-date': '26-09-04 00:00:00.000' });
	assert.ok(f.service.compare(frontmatterOlder as never, frontmatterNewer as never, 'creation-date') < 0);

	const alphaFirst = f.add(new TFile('Book A/alpha.md'));
	const alphaLast = f.add(new TFile('Book A/zulu.md'));
	assert.ok(f.service.compare(alphaFirst as never, alphaLast as never, 'creation-date') < 0);
});

test('forced ordering direction inherits through folders and overrides the vault direction', () => {
	const f = fixture('descending');
	const sub = f.add(new TFolder('Book A/sub'));
	const config = f.add(new TFile('Book A/sub/index.md'));
	const a = f.add(new TFile('Book A/sub/a.md'));
	const z = f.add(new TFile('Book A/sub/z.md'));
	f.fm.set(config.path, { forcedOrderingDirection: 'ascending' });
	assert.equal(f.service.getDirection(sub as never), 'ascending');
	assert.equal(f.service.getDirectionOverride(sub as never), 'ascending');
	assert.ok(f.service.compare(a as never, z as never, 'alphabetical') < 0);
	f.fm.set(config.path, { forcedOrderingDirection: false });
	assert.equal(f.service.getDirection(sub as never), 'descending');
	assert.equal(f.service.getDirectionOverride(sub as never), null);
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


test('properties ignore links leaving the directory and use local filename dates', () => {
	const f = fixture('ascending');
	const early = f.add(new TFile('Book A/z-01.09.2026.md'));
	const middle = f.add(new TFile('Book A/y-02.09.2026.md'));
	const late = f.add(new TFile('Book A/a-03.09.2026.md'));
	f.add(new TFile('Book B/external.md'));
	f.fm.set(early.path, { PreviousArticle: '[[Book B/external]]' });
	f.fm.set(late.path, { NextArticle: '[[Book B/external]]' });
	const order = () => [late, middle, early].sort((a, b) => f.service.compare(a as never, b as never, 'properties')).map(note => note.name);
	assert.deepEqual(order(), [early.name, middle.name, late.name]);
	f.fm.set(late.path, { NextArticle: `[[${early.path}]]` });
	assert.deepEqual(order(), [middle.name, late.name, early.name]);
	f.service.setDirection('descending');
	assert.deepEqual(order(), [early.name, late.name, middle.name]);
});

test('properties honor a previous link even when the note also has a next link', () => {
	const f = fixture('ascending');
	const a = f.add(new TFile('Book A/z-03.09.2026.md'));
	const b = f.add(new TFile('Book A/a-01.09.2026.md'));
	const c = f.add(new TFile('Book A/m-02.09.2026.md'));
	f.fm.set(b.path, { PreviousArticle: `[[${a.path}]]`, NextArticle: `[[${c.path}]]` });
	assert.deepEqual([c, b, a].sort((x, y) => f.service.compare(x as never, y as never, 'properties')), [a, b, c]);
});

test('properties use filesystem timestamps before alphabetical and survive link cycles', () => {
	const f = fixture('ascending');
	const a = f.add(new TFile('Book A/z.md')), b = f.add(new TFile('Book A/a.md'));
	a.stat.ctime = 100; b.stat.ctime = 200;
	assert.ok(f.service.compare(a as never, b as never, 'properties') < 0);
	f.fm.set(a.path, { NextArticle: '[[a]]' }); f.fm.set(b.path, { NextArticle: '[[z]]' });
	assert.ok(f.service.compare(a as never, b as never, 'properties') < 0);
	a.stat.ctime = NaN; b.stat.ctime = NaN;
	f.fm.clear(); f.service.refresh(a as never); f.service.refresh(b as never);
	assert.ok(f.service.compare(a as never, b as never, 'properties') > 0);
});

test('paused automatic regeneration keeps empty folder configs empty', async () => {
	const f = fixture();
	const config = f.add(new TFile('Book A/index.md'), 'Body');
	(f.plugin as unknown as { frontmatterMaintenance: { paused: boolean } }).frontmatterMaintenance = { paused: true };
	await f.service.ensureConfig(f.book as never);
	await f.service.syncConfig(config as never);
	await f.service.syncCreationDate(config as never);
	await f.service.refreshCreationDates();
	assert.equal(f.writes.frontmatter, 0);
	assert.equal(f.bodies.get(config.path), 'Body');
});
