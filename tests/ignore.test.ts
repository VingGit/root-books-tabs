import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BookIgnoreService } from '../src/ignore';
import { TFile, TFolder } from './obsidian-mock';

function fixture(initial = '') {
	let source = initial, writes = 0;
	const service = new BookIgnoreService({
		app: { vault: { adapter: {
			exists: async () => Boolean(source), read: async () => source,
			write: async (_path: string, content: string) => { source = content; writes++; },
		} } }, decorations: { refresh: () => undefined },
	} as never);
	return { service, source: () => source, writes: () => writes, replace: (text: string) => { source = text; } };
}

test('literal additions escape metacharacters and preserve CRLF; removal retains unrelated lines', async () => {
	const f = fixture('# keep\r\n*.tmp\r\n');
	const file = new TFile('Book A/[draft]!.md');
	await f.service.add(file as never);
	assert.equal(f.source(), '# keep\r\n*.tmp\r\n/Book\\ A/\\[draft\\]\\!.md\r\n');
	assert.equal(f.service.isHidden(file as never), true);
	assert.equal(f.service.isHidden(new TFile('Book A/d!.md') as never), false);
	await f.service.add(file as never);
	assert.equal(f.writes(), 1);
	await f.service.remove('/Book\\ A/\\[draft\\]\\!.md');
	assert.equal(f.source(), '# keep\r\n*.tmp\r\n');
	await f.service.add(new TFolder('Book B') as never);
	assert.equal(f.service.isHidden(new TFile('Book B/nested/note.md') as never), true);
});

test('exact rename supports aliases and escapes while preserving glob, directory, negation and unanchored rules', async () => {
	const original = '# keep\r\n/Book A/index.md\r\n./Book\\ A/index.md\n/Book A/*.md\r\n/Book A/index.md/\n!/Book A/index.md\nBook A/index.md\n/Other/index.md\n/Book A/index.md  ';
	const f = fixture(original);
	const undo = await f.service.renameExactPaths([{ from: 'Book A/index.md', to: 'Book A/[config]!.md' }]);
	assert.equal(f.source(), '# keep\r\n/Book\\ A/\\[config\\]\\!.md\r\n./Book\\ A/\\[config\\]\\!.md\n/Book A/*.md\r\n/Book A/index.md/\n!/Book A/index.md\nBook A/index.md\n/Other/index.md\n/Book\\ A/\\[config\\]\\!.md  ');
	await undo();
	assert.equal(f.source(), original);
});

test('batch rename matches original paths once and rollback preserves pre-existing destination entries', async () => {
	const original = '/A/index.md\n/A/config.md\n';
	const f = fixture(original);
	const undo = await f.service.renameExactPaths([{ from: 'A/index.md', to: 'A/config.md' }, { from: 'A/config.md', to: 'A/final.md' }]);
	assert.equal(f.source(), '/A/config.md\n/A/final.md\n');
	await undo(); await undo();
	assert.equal(f.source(), original);
});

test('rename handles escaped metacharacters and trailing spaces in literal file names', async () => {
	const f = fixture('/A/\\[index\\]\\?.md\\ \n/A/[index]?.md\n');
	await f.service.renameExactPaths([{ from: 'A/[index]?.md ', to: 'A/new.md' }]);
	assert.equal(f.source(), '/A/new.md\n/A/[index]?.md\n');
});

test('rollback refuses concurrent changes and no-op rename does not create an ignore file', async () => {
	const empty = fixture();
	await empty.service.renameExactPaths([{ from: 'A/index.md', to: 'A/config.md' }]);
	assert.equal(empty.writes(), 0);
	const f = fixture('/A/index.md\n');
	const undo = await f.service.renameExactPaths([{ from: 'A/index.md', to: 'A/config.md' }]);
	f.replace('/A/config.md\n# later edit\n');
	await assert.rejects(undo(), /changed after/);
	assert.equal(f.source(), '/A/config.md\n# later edit\n');
	await f.service.add(new TFile('B/note.md') as never);
	assert.equal(f.source(), '/A/config.md\n# later edit\n/B/note.md\n');
});
