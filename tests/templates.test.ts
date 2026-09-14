import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { FolderTemplateService } from '../src/templates';
import { TAbstractFile, TFile, TFolder } from './obsidian-mock';

function fixture() {
	const files = new Map<string, TAbstractFile>();
	const frontmatter = new Map<string, Record<string, unknown>>();
	const binary = new Map<string, ArrayBuffer>();
	const root = new TFolder(''); files.set('', root);
	const add = <T extends TAbstractFile>(file: T): T => {
		const parentPath = file.path.split('/').slice(0, -1).join('/');
		file.parent = files.get(parentPath) as TFolder;
		file.parent.children.push(file);
		files.set(file.path, file);
		return file;
	};
	const book = add(new TFolder('Book A'));
	const sub = add(new TFolder('Book A/sub'));
	const templateFolder = add(new TFolder('templates'));
	const template = add(new TFile('templates/example.md'));
	template.stat.size = 8;
	binary.set(template.path, new TextEncoder().encode('Template').buffer);
	const plugin = {
		settings: {
			configFileBaseName: 'index', templateFolder: 'templates',
			templateMd: { 'example.md': ['DD.MM.YYYY', '{{date}}_', true] } as Record<string, [string, string, boolean]>,
			templateCanvas: {} as Record<string, [string, string, boolean]>,
			templateBase: {} as Record<string, [string, string, boolean]>,
		},
		vaultConfig: { values: {} as Record<string, unknown> },
		scopeResolver: { resolveFile: (file: TFile) => file.path.startsWith('Book A/') ? { id: 'Book A' } : null },
		app: {
			vault: {
				getAbstractFileByPath: (path: string) => files.get(path) ?? null,
				getFileByPath: (path: string) => files.get(path) instanceof TFile ? files.get(path) as TFile : null,
				getMarkdownFiles: () => [...files.values()].filter((file): file is TFile => file instanceof TFile && file.extension === 'md'),
				read: async (file: TFile) => `---\n${JSON.stringify(frontmatter.get(file.path) ?? {})}\n---\n`,
				process: async (_file: TFile, change: (content: string) => string) => { change('---\n{}\n---\n'); },
				readBinary: async (file: TFile) => binary.get(file.path) ?? new ArrayBuffer(0),
				modifyBinary: async (file: TFile, contents: ArrayBuffer) => { binary.set(file.path, contents); file.stat.size = contents.byteLength; },
				createFolder: async (path: string) => add(new TFolder(path)),
				create: async (path: string, contents: string) => {
					const file = add(new TFile(path));
					binary.set(path, new TextEncoder().encode(contents).buffer);
					return file;
				},
			},
			metadataCache: { getFileCache: (file: TFile) => ({ frontmatter: frontmatter.get(file.path) }) },
			fileManager: {
				processFrontMatter: async (file: TFile, change: (values: Record<string, unknown>) => void) => {
					const values = frontmatter.get(file.path) ?? {}; change(values); frontmatter.set(file.path, values);
				},
				renameFile: async (file: TAbstractFile, nextPath: string) => {
					const oldPath = file.path, oldParent = file.parent!;
					oldParent.children = oldParent.children.filter(child => child !== file);
					files.delete(oldPath);
					const contents = binary.get(oldPath); binary.delete(oldPath);
					file.path = nextPath;
					const nextParentPath = nextPath.split('/').slice(0, -1).join('/');
					file.parent = files.get(nextParentPath) as TFolder;
					file.parent.children.push(file); files.set(nextPath, file);
					if (contents) binary.set(nextPath, contents);
				},
			},
		},
		bookOrder: {
			ensureConfig: async (folder: TFolder) => {
				const path = `${folder.path}/index.md`;
				const existing = files.get(path);
				if (existing instanceof TFile) return existing;
				const file = add(new TFile(path)); frontmatter.set(path, {}); return file;
			},
		},
	};
	const service = new FolderTemplateService(plugin as never, () => new Date(2026, 8, 17, 17, 23));
	return { add, binary, book, files, frontmatter, plugin, root, service, sub, template, templateFolder };
}

test('each content type inherits its nearest complete rule independently', () => {
	const f = fixture();
	f.plugin.vaultConfig.values = {
		'template-md': { 'root.md': ['YY', 'root-', true] },
		'book-tabs-template-canvas': { 'global.canvas': ['', '', false] },
	};
	const bookConfig = f.add(new TFile('Book A/index.md'));
	const subConfig = f.add(new TFile('Book A/sub/index.md'));
	f.frontmatter.set(bookConfig.path, { 'book-tabs-template-md': { 'book.md': ['DD', 'book-', true] } });
	f.frontmatter.set(subConfig.path, { 'template-base': { 'sub.base': ['', '', false] } });
	assert.deepEqual(f.service.resolveForFolder(f.sub), {
		templateFolder: 'templates',
		templateMd: { 'book.md': ['DD', 'book-', true] },
		templateCanvas: { 'global.canvas': ['', '', false] },
		templateBase: { 'sub.base': ['', '', false] },
	});
});

test('legacy Markdown folder fields keep their independent nearest-folder inheritance', () => {
	const f = fixture();
	const bookConfig = f.add(new TFile('Book A/index.md'));
	const subConfig = f.add(new TFile('Book A/sub/index.md'));
	f.frontmatter.set(bookConfig.path, { 'template-file-prefix': 'book-' });
	f.frontmatter.set(subConfig.path, { 'template-file-path': 'templates/sub.md', 'template-file-applied-To': 'md' });
	assert.deepEqual(f.service.resolveForFolder(f.sub).templateMd, {
		'templates/sub.md': ['DD.MM.YYYY', 'book-', true],
	});
});

test('Markdown rule uses the global template folder, dates names, and copies binary-safe contents', async () => {
	const f = fixture();
	f.add(new TFile('Book A/17.09.2026_note.md'));
	const created = f.add(new TFile('Book A/note.md')); created.stat.size = 0;
	assert.equal(await f.service.handleCreate(created), true);
	assert.equal(created.path, 'Book A/17.09.2026_at_17-23_note.md');
	assert.equal(new TextDecoder().decode(f.binary.get(created.path)), 'Template');
});

test('Canvas can copy a template without changing the filename', async () => {
	const f = fixture();
	const canvasTemplate = f.add(new TFile('templates/blank.canvas'));
	f.binary.set(canvasTemplate.path, new TextEncoder().encode('{"nodes":[],"edges":[]}').buffer);
	f.plugin.settings.templateCanvas = { 'blank.canvas': ['', 'unused-', false] };
	const created = f.add(new TFile('Book A/board.canvas'));
	assert.equal(await f.service.handleCreate(created), true);
	assert.equal(created.path, 'Book A/board.canvas');
	assert.equal(new TextDecoder().decode(f.binary.get(created.path)), '{"nodes":[],"edges":[]}');
});

test('unsupported, config, template-source, root, and excluded files remain unchanged', async () => {
	const f = fixture();
	const unsupported = f.add(new TFile('Book A/photo.png'));
	const config = f.add(new TFile('Book A/index.md'));
	const rootFile = f.add(new TFile('root.md'));
	const excluded = f.add(new TFile('templates/other.md'));
	assert.equal(await f.service.handleCreate(unsupported), false);
	assert.equal(await f.service.handleCreate(config), false);
	assert.equal(await f.service.handleCreate(f.template), false);
	assert.equal(await f.service.handleCreate(rootFile), false);
	assert.equal(await f.service.handleCreate(excluded), false);
});

test('saving overrides writes new mappings and creates only missing anchored template files', async () => {
	const f = fixture();
	const config = f.add(new TFile('Book A/index.md'));
	f.frontmatter.set(config.path, { 'template-md': { 'keep.md': ['', '', false] } });
	await f.service.writeFolderOverrides(f.book, {
		templatePathsUnderGlobalFolder: true,
		templateCanvas: { 'boards/blank.canvas': ['', '', false] },
		templateBase: { 'catalog.base': ['', '', false] },
	});
	assert.deepEqual(f.frontmatter.get(config.path)?.['template-md'], { 'keep.md': ['', '', false] });
	assert.deepEqual(f.frontmatter.get(config.path)?.['book-tabs-template-canvas'], { 'boards/blank.canvas': ['', '', false] });
	assert.equal(f.frontmatter.get(config.path)?.['book-tabs-template-paths-under-global-folder'], true);
	assert.ok(f.files.get('templates/boards/blank.canvas') instanceof TFile);
	assert.equal(new TextDecoder().decode(f.binary.get('templates/boards/blank.canvas')), '{"nodes":[],"edges":[]}\n');
	assert.equal(new TextDecoder().decode(f.binary.get('templates/catalog.base')), 'views: []\n');
	assert.deepEqual(f.service.discoverFolderOverrides().map(entry => entry.folder.path), ['Book A']);
});

test('exact override paths are created as written and an existing template is never overwritten', async () => {
	const f = fixture();
	const custom = f.add(new TFolder('custom'));
	const existing = f.add(new TFile('custom/blank.base'));
	f.binary.set(existing.path, new TextEncoder().encode('existing').buffer);
	await f.service.writeFolderOverrides(f.book, {
		templatePathsUnderGlobalFolder: false,
		templateBase: { 'custom/blank.base': ['', '', false] },
	});
	assert.ok(custom.children.includes(existing));
	assert.equal(new TextDecoder().decode(f.binary.get(existing.path)), 'existing');
});
