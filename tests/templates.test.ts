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
			configFileBaseName: 'index',
			templateFilePrefix: '',
			templateFileDate: 'DD.MM.YYYY',
			templateFilePath: 'templates/example.md',
			templateFileAppliedTo: 'md',
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
			},
			metadataCache: { getFileCache: (file: TFile) => ({ frontmatter: frontmatter.get(file.path) }) },
			fileManager: {
				processFrontMatter: async (file: TFile, change: (values: Record<string, unknown>) => void) => {
					const values = frontmatter.get(file.path) ?? {}; change(values); frontmatter.set(file.path, values);
				},
				renameFile: async (file: TAbstractFile, nextPath: string) => {
					const oldPath = file.path, oldParent = file.parent!;
					oldParent.children = oldParent.children.filter((child) => child !== file);
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

test('template fields inherit independently from root and nearest folder overrides', () => {
	const f = fixture();
	f.plugin.vaultConfig.values = {
		'template-file-prefix': 'root-',
		'book-tabs-template-file-path': 'templates/root.md',
	};
	const bookConfig = f.add(new TFile('Book A/index.md'));
	const subConfig = f.add(new TFile('Book A/sub/index.md'));
	f.frontmatter.set(bookConfig.path, {
		'template-file-prefix': 'book-',
		'book-tabs-template-file-applied-to': 'canvas',
	});
	f.frontmatter.set(subConfig.path, { 'template-file-path': 'templates/sub.md' });
	assert.deepEqual(f.service.resolveForFolder(f.sub), {
		templateFilePrefix: 'book-',
		templateFileDate: 'DD.MM.YYYY',
		templateFilePath: 'templates/sub.md',
		templateFileAppliedTo: 'canvas',
	});
});

test('create applies a valid date prefix, adds time on collision, and copies binary-safe contents', async () => {
	const f = fixture();
	f.plugin.settings.templateFilePrefix = '{{date}}_';
	f.add(new TFile('Book A/17.09.2026_note.md'));
	const created = f.add(new TFile('Book A/note.md')); created.stat.size = 0;
	assert.equal(await f.service.handleCreate(created), true);
	assert.equal(created.path, 'Book A/17.09.2026_at_17-23_note.md');
	assert.equal(new TextDecoder().decode(f.binary.get(created.path)), 'Template');
});

test('create applies to imported matching files and ignores unmatched extensions, config notes, and the template source', async () => {
	const f = fixture();
	f.plugin.settings.templateFilePrefix = 'new-';
	const nonempty = f.add(new TFile('Book A/content.md'));
	const canvas = f.add(new TFile('Book A/board.canvas')); canvas.stat.size = 0;
	const config = f.add(new TFile('Book A/index.md')); config.stat.size = 0;
	const rootFile = f.add(new TFile('root.md')); rootFile.stat.size = 0;
	const excluded = f.add(new TFile('templates/other.md')); excluded.stat.size = 0;
	assert.equal(await f.service.handleCreate(nonempty), true);
	assert.equal(await f.service.handleCreate(canvas), false);
	assert.equal(await f.service.handleCreate(config), false);
	assert.equal(await f.service.handleCreate(f.template), false);
	assert.equal(await f.service.handleCreate(rootFile), false);
	assert.equal(await f.service.handleCreate(excluded), false);
	assert.equal(nonempty.path, 'Book A/new-content.md');
	assert.equal(rootFile.path, 'root.md');
	assert.equal(excluded.path, 'templates/other.md');
	assert.equal(new TextDecoder().decode(f.binary.get(nonempty.path)), 'Template');
});

test('folder override writes use prefixed keys without replacing plain frontmatter and are discoverable', async () => {
	const f = fixture();
	const config = f.add(new TFile('Book A/index.md'));
	f.frontmatter.set(config.path, { 'template-file-prefix': 'keep-plain' });
	await f.service.writeFolderOverrides(f.book, { templateFilePrefix: 'managed-' });
	assert.equal(f.frontmatter.get(config.path)?.['template-file-prefix'], 'keep-plain');
	assert.equal(f.frontmatter.get(config.path)?.['book-tabs-template-file-prefix'], 'managed-');
	assert.equal(f.service.readFolderOverrides(f.book).templateFilePrefix, 'managed-');
	assert.deepEqual(f.service.discoverFolderOverrides().map((entry) => entry.folder.path), ['Book A']);
});
