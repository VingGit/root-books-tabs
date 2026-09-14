import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BookColorService, validateColorKeys } from '../src/colors';
import { TFile, TFolder } from './obsidian-mock';

function fixture() {
	const folder = new TFolder('Book');
	const file = new TFile('Book/index.md'); file.parent = folder;
	const excludedFolder = new TFolder('templates');
	const excluded = new TFile('templates/index.md'); excluded.parent = excludedFolder;
	const fm: Record<string, unknown> = { color: '#abcdef', 'tab-text-bg': 'black', unrelated: ['preserve'] };
	let failSave = false;
	const plugin = {
		settings: {
			configFileBaseName: 'index', colorFrontmatterProperty: 'color', tabTextFrontmatterProperty: 'tab-text-bg',
			manualColors: {} as Record<string, string>, manualTabTextColors: {} as Record<string, string>,
		},
		scopeResolver: { resolveFile: (candidate: TFile) => candidate.path.startsWith('Book/') ? { id: 'Book' } : null },
		decorations: { refresh: () => undefined },
		bookIgnore: { renameExactPaths: () => Promise.resolve(() => Promise.resolve()) },
		saveSettings: () => { if (failSave) { failSave = false; return Promise.reject(new Error('save failed')); } return Promise.resolve(); },
		app: {
			vault: {
				getMarkdownFiles: () => [file, excluded],
				getAbstractFileByPath: (path: string) => path === file.path ? file : path === excluded.path ? excluded : null,
				getFileByPath: (path: string) => path === file.path ? file : path === excluded.path ? excluded : null,
				read: () => Promise.resolve(''),
				process: () => Promise.resolve(''),
			},
			metadataCache: { getFileCache: () => ({ frontmatter: fm }) },
			fileManager: {
				processFrontMatter: (_file: TFile, change: (values: Record<string, unknown>) => void) => { change(fm); return Promise.resolve(); },
				renameFile: (_file: TFile, path: string) => { file.path = path; return Promise.resolve(); },
			},
		},
	};
	return { service: new BookColorService(plugin as never), excluded, file, fm, plugin, failNextSave: () => { failSave = true; } };
}

test('config migration moves both color keys and restores defaults without losing unrelated fields', async () => {
	const f = fixture();
	await f.service.renameConfiguration('config', 'accent', 'ink');
	assert.equal(f.file.path, 'Book/config.md');
	assert.equal(f.excluded.path, 'templates/index.md');
	assert.equal(f.fm.color, '#abcdef');
	assert.equal(f.fm['tab-text-bg'], 'black');
	assert.equal(f.fm.accent, '#abcdef');
	assert.equal(f.fm.ink, 'black');
	assert.deepEqual(f.fm.unrelated, ['preserve']);
	await f.service.renameConfiguration('index', 'color', 'tab-text-bg');
	assert.equal(f.file.path, 'Book/index.md');
	assert.equal(f.fm.color, '#abcdef');
	assert.equal(f.fm['tab-text-bg'], 'black');
	assert.deepEqual(f.fm.unrelated, ['preserve']);
});

test('color keys reject aliases and reserved metadata before modifying notes', async () => {
	const f = fixture();
	await assert.rejects(f.service.renameConfiguration('config', 'ink', 'ink'), /different/);
	assert.equal(f.file.path, 'Book/index.md');
	assert.throws(() => validateColorKeys('fileOrder', 'ink'), /ordering or navigation/);
	f.fm.ink = 'existing';
	await f.service.renameConfiguration('config', 'accent', 'ink');
	assert.equal(f.fm.color, '#abcdef');
	assert.equal(f.fm.ink, 'existing');
	assert.equal(f.fm['book-tabs-ink'], 'black');
});

test('failed settings save rolls back renamed notes and both color properties', async () => {
	const f = fixture(); f.failNextSave();
	await assert.rejects(f.service.renameConfiguration('config', 'accent', 'ink'), /save failed/);
	assert.equal(f.file.path, 'Book/index.md');
	assert.deepEqual(f.fm, { color: '#abcdef', 'tab-text-bg': 'black', unrelated: ['preserve'] });
	assert.deepEqual(f.plugin.settings, {
		configFileBaseName: 'index', colorFrontmatterProperty: 'color', tabTextFrontmatterProperty: 'tab-text-bg',
		manualColors: {}, manualTabTextColors: {},
	});
	await f.service.renameConfiguration('config', 'accent', 'ink');
	assert.equal(f.file.path, 'Book/config.md');
});

test('removing an override restores the same deterministic fallback', async () => {
	const f = fixture();
	const book = { id: 'Book', name: 'Book', folderPath: 'Book' };
	await f.service.removeOverride(book);
	const first = f.plugin.settings.manualColors.Book;
	await f.service.removeOverride(book);
	assert.match(first!, /^#[0-9a-f]{6}$/i);
	assert.equal(f.plugin.settings.manualColors.Book, first);
});
