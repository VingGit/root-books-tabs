import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { FrontmatterSectionManager } from '../src/frontmatter-section';
import { readPluginFrontmatter, writePluginFrontmatter, removePluginFrontmatter, addConfigComments, restoreConfigComments } from '../src/config-frontmatter';
import { stripFrontmatter } from '../src/frontmatter-maintenance';

test('section migration resolves owned duplicates, preserves unrelated data and is idempotent', () => {
	const manager = new FrontmatterSectionManager();
	const fm: Record<string, unknown> = { custom: ['keep'], color: 'user-theme', orderingType: 'manual', 'book-tabs-orderingType': 'properties', fileOrder: ['a.md'], 'book-tabs-fileOrder': ['b.md'], 'creation-date': 'keep', book: 'other-plugin' };
	manager.migrate(fm, new Set(['orderingType', 'fileOrder']), ['color', 'orderingType', 'fileOrder']);
	assert.deepEqual(fm, { custom: ['keep'], color: 'user-theme', 'creation-date': 'keep', book: 'other-plugin', 'book-tabs': { orderingType: 'properties' } });
	const first = structuredClone(fm); manager.migrate(fm, new Set(), ['orderingType', 'fileOrder']); assert.deepEqual(fm, first);
});

test('section values take precedence and setting edits stay separate from shared metadata', () => {
	const fm: Record<string, unknown> = { color: 'user-theme', 'book-tabs-color': '#111111', 'book-tabs': { color: '#222222' }, aliases: ['Book'] };
	assert.equal(readPluginFrontmatter(fm, 'color'), '#222222');
	writePluginFrontmatter(fm, 'color', '#333333');
	assert.equal(fm.color, 'user-theme'); assert.equal('book-tabs-color' in fm, false);
	assert.deepEqual(fm['book-tabs'], { color: '#333333' });
	removePluginFrontmatter(fm, 'color'); assert.equal(readPluginFrontmatter(fm, 'color'), null);
	assert.deepEqual(fm.aliases, ['Book']);
});

test('section deletion is clean and uniform ordering retains unknown fields', () => {
	const manager = new FrontmatterSectionManager();
	const fm: Record<string, unknown> = { title: 'Keep', 'book-tabs': { zebra: 1, color: '#ffffff', orderingType: 'manual', fileOrder: [], bookModeEnabled: true, aardvark: 2 } };
	manager.normalize(fm);
	assert.deepEqual(Object.keys(manager.read(fm)!), ['bookModeEnabled', 'orderingType', 'color', 'aardvark', 'zebra']);
	assert.equal(manager.read(fm)?.orderingType, 'alphabetical');
	manager.delete(fm); assert.deepEqual(fm, { title: 'Keep' });
});

test('malformed sections stop a write before modifying any data', () => {
	const manager = new FrontmatterSectionManager();
	const fm = { 'book-tabs': 'broken', 'book-tabs-color': '#123456' };
	assert.throws(() => manager.migrate(fm, new Set(), ['color']), /must be a mapping/);
	assert.deepEqual(fm, { 'book-tabs': 'broken', 'book-tabs-color': '#123456' });
});

test('nested help is idempotent and never claims a plain user collision', () => {
	const input = '---\ncolor: user-theme\nbook-tabs:\n  color: "#ffffff"\n---\nBody\n';
	const output = addConfigComments(input);
	assert.ok(!output.includes('color override. Remove to use the local automatic color.\ncolor:'));
	assert.match(output, /  # Optional #RRGGBB[\s\S]*\n  color:/);
	assert.equal(addConfigComments(output), output);
});

test('destructive reset removes only closed leading YAML and preserves body bytes', () => {
	assert.equal(stripFrontmatter('\uFEFF---\r\nfield: x\r\n---\r\n\r\n# Body\r\n---\r\n'), '\uFEFF\r\n# Body\r\n---\r\n');
	assert.equal(stripFrontmatter('---\nfield: x\n...\nText'), 'Text');
	assert.equal(stripFrontmatter('# Body\n---\nfield: x\n---\n'), '# Body\n---\nfield: x\n---\n');
	assert.equal(stripFrontmatter('---\nfield: x\nNo terminator'), '---\nfield: x\nNo terminator');
	assert.equal(stripFrontmatter(''), '');
});

test('uniform section writes preserve explanations attached to unknown nested settings', () => {
	const before = '---\n# Other plugin\ncustom: keep\nbook-tabs:\n  # Personal explanation\n  extension-option: true\n---\nBody';
	const after = '---\ncustom: keep\nbook-tabs:\n  color: "#ffffff"\n  extension-option: true\n---\nBody';
	const restored = restoreConfigComments(before, after);
	assert.match(restored, /# Other plugin\ncustom: keep/);
	assert.match(restored, /  # Personal explanation\n  extension-option: true/);
	assert.equal(restoreConfigComments(before, restored), restored);
});
