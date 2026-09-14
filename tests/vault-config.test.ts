import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { VaultConfigService } from '../src/vault-config';
import { DEFAULT_SETTINGS } from '../src/settings-model';
import { TFile, TFolder, TAbstractFile } from './obsidian-mock';

const managed = (fm: Record<string, unknown>, key: string): unknown =>
	Object.prototype.hasOwnProperty.call(fm, `book-tabs-${key}`) ? fm[`book-tabs-${key}`] : fm[key];

function fixture(initial: Record<string, unknown> = {}, initialContent?: string) {
	const root = new TFolder('');
	const files = new Map<string, TAbstractFile>([['', root]]);
	const fm: Record<string, unknown> = { ...initial };
	let writes = 0, fail = false;
	function add<T extends TAbstractFile>(file: T): T {
		file.parent = files.get(file.path.split('/').slice(0, -1).join('/')) as TFolder;
		file.parent.children.push(file); files.set(file.path, file); return file;
	}
	add(new TFile('index.md'));
	const plugin = {
		settings: structuredClone(DEFAULT_SETTINGS),
		app: { vault: {
			getAbstractFileByPath: (path: string) => files.get(path) ?? null,
			getFileByPath: (path: string) => files.get(path) instanceof TFile ? files.get(path) : null,
			getMarkdownFiles: () => [...files.values()].filter(file => file instanceof TFile && file.extension === 'md'),
			create: async (path: string) => { if (files.has(path)) throw Error('exists'); return add(new TFile(path)); },
			read: async () => initialContent ?? `---\n${JSON.stringify(fm)}\n---\nKeep this body`,
			process: async (_file: TFile, change: (text: string) => string) => { assert.ok(change(initialContent ?? `---\n${JSON.stringify(fm)}\n---\nKeep this body`).endsWith('Keep this body')); },
		}, fileManager: {
			processFrontMatter: async (_file: TFile, change: (values: Record<string, unknown>) => void) => {
				if (fail) { fail = false; throw Error('test write failure'); }
				writes++; change(fm);
			},
		} },
		scopeResolver: {
			listBooks: () => root.children.filter((entry): entry is TFolder => entry instanceof TFolder)
				.map(folder => ({ id: folder.path, name: folder.name, folderPath: folder.path })),
		},
		bookOrder: { ensureConfig: async (folder: TFolder) => add(new TFile(`${folder.path}/index.md`)) },
	};
	const service = new VaultConfigService(plugin as never);
	return { plugin, service, fm, add, files, writes: () => writes, failNext: () => { fail = true; } };
}

test('root config preserves fields, local preferences, and pending edits during metadata reload', async () => {
	const f = fixture({ showBookLabel: true, colorTabs: true, custom: { keep: 1 } });
	await f.service.ensureRoot();
	f.plugin.settings.selectedBookId = 'Local';
	f.plugin.settings.showBookLabel = false;
	f.fm['book-tabs-colorTabs'] = false;
	await f.service.load();
	assert.equal(f.plugin.settings.showBookLabel, false);
	assert.equal(f.plugin.settings.colorTabs, false);
	assert.equal(f.plugin.settings.selectedBookId, 'Local');
	await f.service.saveSettings();
	assert.equal(f.fm.showBookLabel, true);
	assert.equal(f.fm['book-tabs-showBookLabel'], false);
	assert.equal(f.fm.colorTabs, true);
	assert.equal(f.fm['book-tabs-colorTabs'], false);
	assert.deepEqual(f.fm.custom, { keep: 1 });
	assert.equal('selectedBookId' in f.fm, false);
});

test('plain collisions are preserved while prefixed settings take precedence and receive updates', async () => {
	const f = fixture({ showBookLabel: 'user value', 'book-tabs-colorTabs': false, custom: 'keep' });
	await f.service.ensureRoot();
	assert.equal(f.fm.showBookLabel, 'user value');
	assert.equal(f.fm['book-tabs-showBookLabel'], true);
	assert.equal(f.plugin.settings.showBookLabel, true);
	assert.equal(f.plugin.settings.colorTabs, false);
	await f.service.set('showBookLabel', false);
	assert.equal(f.fm.showBookLabel, 'user value');
	assert.equal(f.fm['book-tabs-showBookLabel'], false);
	assert.equal(f.fm.custom, 'keep');
});

test('generated help marks legacy plain fields as plugin-owned for in-place updates', async () => {
	const content = '---\n# True shows a subtle book label above Markdown notes.\nshowBookLabel: false\n---\nKeep this body';
	const f = fixture({ showBookLabel: false }, content);
	await f.service.ensureRoot();
	assert.equal(f.fm.showBookLabel, false);
	assert.equal('book-tabs-showBookLabel' in f.fm, false);
	await f.service.set('showBookLabel', true);
	assert.equal(f.fm.showBookLabel, true);
	assert.equal('book-tabs-showBookLabel' in f.fm, false);
});

test('prefixed root values win during direct loads', async () => {
	const f = fixture({ showBookLabel: false, 'book-tabs-showBookLabel': true });
	await f.service.load();
	assert.equal(f.service.values.showBookLabel, true);
	assert.equal(f.plugin.settings.showBookLabel, true);
});

test('portable explorer routing updates root config', async () => {
	const f = fixture(); await f.service.ensureRoot();
	await f.service.set('fileExplorerOpenBehavior', 'current-group');
	assert.equal(managed(f.fm, 'fileExplorerOpenBehavior'), 'current-group');
	assert.equal(f.plugin.settings.fileExplorerOpenBehavior, 'current-group');
});

test('obsolete generated Grid boundary settings are removed without deleting an unowned plain collision', async () => {
	const f = fixture({
		showGridBoundaries: 'user value',
		'book-tabs-showGridBoundaries': true,
		'book-tabs-gridBoundaryThickness': 7,
	});
	await f.service.ensureRoot();
	assert.equal(f.fm.showGridBoundaries, 'user value');
	assert.equal('book-tabs-showGridBoundaries' in f.fm, false);
	assert.equal('book-tabs-gridBoundaryThickness' in f.fm, false);
});

test('rapid saves retain reversals and do not mark later unsaved edits persisted', async () => {
	const f = fixture(); await f.service.ensureRoot();
	f.plugin.settings.showBookLabel = false;
	const first = f.service.saveSettings();
	f.plugin.settings.showBookLabel = true;
	const second = f.service.saveSettings();
	f.plugin.settings.gridColumns = 5;
	await Promise.all([first, second]);
	assert.equal(managed(f.fm, 'showBookLabel'), true);
	assert.equal(f.plugin.settings.showBookLabel, true);
	assert.equal(f.plugin.settings.gridColumns, 5);
	assert.equal(managed(f.fm, 'gridColumns'), 2);
	await f.service.saveSettings();
	assert.equal(managed(f.fm, 'gridColumns'), 5);
});

test('failed root save can retry and does not poison later operations', async () => {
	const f = fixture(); await f.service.ensureRoot();
	f.plugin.settings.gridColumns = 4; f.failNext();
	await assert.rejects(f.service.saveSettings(), /test write failure/);
	await f.service.saveSettings();
	await f.service.set('isFreshClone', false);
	assert.equal(managed(f.fm, 'gridColumns'), 4); assert.equal(managed(f.fm, 'isFreshClone'), false);
});

test('concurrent root creation and updates create once and preserve separate keys', async () => {
	const f = fixture(); f.files.delete('index.md');
	await Promise.all([f.service.ensureRoot(), f.service.set('isFreshClone', false), f.service.set('freshCloneOpeningPath', 'Book A')]);
	assert.equal(managed(f.fm, 'isFreshClone'), false); assert.equal(managed(f.fm, 'freshCloneOpeningPath'), 'Book A');
});

test('fresh startup respects valid files, book fallback, restored state, and empty book creation', async () => {
	const f = fixture({ isFreshClone: true }); await f.service.ensureRoot();
	const book = f.add(new TFolder('Book A'));
	const note = f.add(new TFile('Book A/latest.md'));
	const empty = f.add(new TFolder('Empty'));
	await f.service.set('freshCloneOpeningPath', note.path); assert.equal(await f.service.startupFile(true), note);
	await f.service.set('freshCloneOpeningPath', book.path); assert.equal(await f.service.startupFile(true), note);
	const index = f.add(new TFile('Book A/index.md')); assert.equal(await f.service.startupFile(true), index);
	await f.service.set('freshCloneOpeningPath', 'missing'); assert.equal(await f.service.startupFile(true), null);
	note.stat.mtime = 999999; assert.equal(await f.service.startupFile(false), note);
	await f.service.set('freshCloneOpeningPath', empty.path); assert.equal((await f.service.startupFile(true))?.path, 'Empty/index.md');
	assert.equal(f.service.values.isFreshClone, true);
	await f.service.set('isFreshClone', false); assert.equal(await f.service.startupFile(false), null);
});

test('an unsaved reversal during an earlier write remains available for the next save', async () => {
	const f = fixture(); await f.service.ensureRoot();
	f.plugin.settings.showBookLabel = false;
	const saving = f.service.saveSettings();
	f.plugin.settings.showBookLabel = true;
	await saving;
	assert.equal(managed(f.fm, 'showBookLabel'), false);
	assert.equal(f.plugin.settings.showBookLabel, true);
	await f.service.saveSettings();
	assert.equal(managed(f.fm, 'showBookLabel'), true);
});
