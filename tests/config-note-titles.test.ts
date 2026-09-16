import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ConfigNoteTitleService } from '../src/config-note-titles';
import { TAbstractFile, TFile, TFolder } from './obsidian-mock';

function fixture(configFileBaseName = 'index') {
	const files = new Map<string, TAbstractFile>();
	const frontmatter = new Map<string, Record<string, unknown>>();
	const bodies = new Map<string, string>();
	let writes = 0;
	const root = new TFolder(''); files.set('', root);
	function add<T extends TAbstractFile>(file: T, values: Record<string, unknown> = {}): T {
		files.set(file.path, file);
		file.parent = files.get(file.path.split('/').slice(0, -1).join('/')) as TFolder;
		file.parent.children.push(file);
		if (file instanceof TFile) {
			frontmatter.set(file.path, { ...values });
			bodies.set(file.path, body(values));
		}
		return file;
	}
	const app = {
		vault: {
			getName: () => 'Test vault',
			getMarkdownFiles: () => [...files.values()].filter((file): file is TFile => file instanceof TFile && file.extension === 'md'),
			read: (file: TFile) => Promise.resolve(bodies.get(file.path) ?? ''),
			process: (file: TFile, change: (content: string) => string) => { bodies.set(file.path, change(bodies.get(file.path) ?? '')); return Promise.resolve(); },
		},
		metadataCache: { getFileCache: (file: TFile) => ({ frontmatter: frontmatter.get(file.path) }) },
		fileManager: { processFrontMatter: (file: TFile, change: (values: Record<string, unknown>) => void) => {
			writes++;
			const values = frontmatter.get(file.path) ?? {}; change(values); frontmatter.set(file.path, values); bodies.set(file.path, body(values));
			return Promise.resolve();
		} },
	} as Record<string, unknown>;
	const plugin = {
		app,
		settings: { configFileBaseName },
		scopeResolver: { resolveFolder: (folder: TFolder | null | undefined) => folder?.path.startsWith('Excluded') ? null : folder?.path.split('/')[0] || null },
	};
	const service = new ConfigNoteTitleService(plugin as never);
	return { add, app, files, frontmatter, service, writes: () => writes };
}

test('display titles cannot replace folder aliases or maintained creation dates', async () => {
	const f = fixture();
	f.add(new TFolder('Book A'));
	const file = f.add(new TFile('Book A/index.md'), { aliases: ['Book A'], 'creation-date': '26-09-15 08:00:00.000' });
	assert.equal(await f.service.syncFile(file as never, 'aliases'), false);
	assert.equal(await f.service.syncFile(file as never, 'book-tabs-creation-date'), false);
	assert.deepEqual(f.frontmatter.get(file.path)?.aliases, ['Book A']);
	assert.equal(f.writes(), 0);
});

function body(values: Record<string, unknown>): string {
	return `---\n${JSON.stringify(values)}\n---\nBody stays`;
}

test('reconciles root, book, and nested config titles while ignoring ordinary and excluded notes', async () => {
	const f = fixture();
	f.add(new TFile('index.md'), { title: 'wrong', custom: 'root' });
	f.add(new TFolder('Book A'));
	f.add(new TFile('Book A/index.md'), { title: 'wrong', custom: 'book' });
	f.add(new TFolder('Book A/Chapter'));
	f.add(new TFile('Book A/Chapter/index.md'), { custom: 'nested' });
	f.add(new TFile('Book A/note.md'), { title: 'ordinary' });
	f.add(new TFolder('Excluded'));
	f.add(new TFile('Excluded/index.md'), { title: 'excluded' });

	assert.equal(await f.service.reconcileAll('title'), 3);
	assert.deepEqual(f.frontmatter.get('index.md'), { title: 'Test vault', custom: 'root' });
	assert.deepEqual(f.frontmatter.get('Book A/index.md'), { title: 'Book A', custom: 'book' });
	assert.deepEqual(f.frontmatter.get('Book A/Chapter/index.md'), { custom: 'nested', title: 'Chapter' });
	assert.equal(f.frontmatter.get('Book A/note.md')?.title, 'ordinary');
	assert.equal(f.frontmatter.get('Excluded/index.md')?.title, 'excluded');
	assert.equal(await f.service.reconcileAll('title'), 0);
});

test('uses the configured folder basename while the root config remains index.md', async () => {
	const f = fixture('home');
	f.add(new TFile('index.md'));
	f.add(new TFolder('Book A'));
	const home = f.add(new TFile('Book A/home.md'));
	const index = f.add(new TFile('Book A/index.md'));
	assert.equal(f.service.isManagedConfigNote(home), true);
	assert.equal(f.service.isManagedConfigNote(index), false);
	assert.equal(await f.service.reconcileAll('title'), 2);
	assert.equal(f.frontmatter.get('Book A/home.md')?.title, 'Book A');
	assert.equal(f.frontmatter.get('Book A/index.md')?.title, undefined);
});

test('migrates a configured property without leaving old plain or prefixed copies', async () => {
	const f = fixture();
	f.add(new TFolder('Book A'));
	const config = f.add(new TFile('Book A/index.md'), { title: 'old', 'book-tabs-title': 'stale', custom: true });
	assert.equal(await f.service.syncFile(config, 'display-name', 'title'), true);
	assert.deepEqual(f.frontmatter.get(config.path), { custom: true, 'display-name': 'Book A' });
});

test('detects and synchronizes a compatible enabled Property Over File Name instance', async () => {
	const f = fixture();
	const calls: string[] = [];
	const external = {
		manifest: { id: 'property-over-file-name', version: '0.8.16' },
		settings: { propertyKey: 'name', untouched: true },
		saveData: async (settings: Record<string, unknown>) => { assert.equal(settings, external.settings); calls.push('save'); },
		updateLinkSuggester: () => calls.push('links'),
		rebuildCache: () => calls.push('cache'),
		updateGraphView: () => calls.push('graph'),
	};
	(f.app as { plugins?: unknown }).plugins = { getPlugin: (id: string) => id === 'property-over-file-name' ? external : null };
	assert.deepEqual(f.service.propertyPluginStatus(), { state: 'connected', propertyKey: 'name', version: '0.8.16' });
	assert.deepEqual(await f.service.syncPropertyPlugin(' title '), { state: 'synced', propertyKey: 'title', refreshFailures: [] });
	assert.equal(external.settings.propertyKey, 'title');
	assert.deepEqual(calls, ['save', 'links', 'cache', 'graph']);
});

test('plugin adapter fails safely for absent, incompatible, and failed saves', async () => {
	const f = fixture();
	assert.deepEqual(f.service.propertyPluginStatus(), { state: 'not-enabled' });
	(f.app as { plugins?: unknown }).plugins = { getPlugin: () => ({ settings: {} }) };
	assert.equal(f.service.propertyPluginStatus().state, 'incompatible');
	const external = {
		manifest: { id: 'property-over-file-name' }, settings: { propertyKey: 'old' },
		saveData: async () => { throw new Error('disk full'); },
	};
	(f.app as { plugins?: unknown }).plugins = { getPlugin: () => external };
	assert.deepEqual(await f.service.syncPropertyPlugin('new'), { state: 'failed', reason: 'disk full' });
	assert.equal(external.settings.propertyKey, 'old');
	assert.deepEqual(await f.service.syncPropertyPlugin('   '), { state: 'failed', reason: 'The display-title property cannot be empty.' });
});
