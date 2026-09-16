import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { TFile } from 'obsidian';
import {
	ArticleNavigatorIntegration,
	applyArticleMutationPlan,
	compileArticleBlacklist,
	DEFAULT_ARTICLE_NAVIGATOR_KEYS,
	planArticleNavigation,
	planMissingArticleProperties,
	readLiveArticleNavigatorKeys,
	resolveArticleNavigatorKeys,
} from '../src/article-navigator';

test('key resolution uses valid live settings atomically and otherwise keeps stored defaults', () => {
	const live = { previousKey: ' Before ', nextKey: 'After', seeAlsoKey: 'Related' };
	const app = { plugins: { plugins: { 'article-navigator': { settings: live } } } };
	assert.deepEqual(readLiveArticleNavigatorKeys(app as never), {
		previousKey: 'Before', nextKey: 'After', seeAlsoKey: 'Related',
	});
	assert.deepEqual(resolveArticleNavigatorKeys({ previousKey: 'Prior' }, readLiveArticleNavigatorKeys(app as never), true), {
		keys: { previousKey: 'Before', nextKey: 'After', seeAlsoKey: 'Related' },
		source: 'article-navigator',
	});
	assert.deepEqual(resolveArticleNavigatorKeys({ previousKey: 'Prior' }, { previousKey: 'same', nextKey: 'same', seeAlsoKey: 'other' }, true), {
		keys: { ...DEFAULT_ARTICLE_NAVIGATOR_KEYS, previousKey: 'Prior' },
		source: 'stored',
	});
});

test('blacklist supports exact files, folder subtrees, regex rules, comments, and invalid pattern reporting', () => {
	const blacklist = compileArticleBlacklist(`
# Root config
index.md
Private
/^Diary\\/draft-/i
regex:\\.secret\\.md$
/invalid[/
`);
	assert.equal(blacklist.matches('index.md'), true);
	assert.equal(blacklist.matches('Book/index.md'), false);
	assert.equal(blacklist.matches('Private/note.md'), true);
	assert.equal(blacklist.matches('Diary/DRAFT-one.md'), true);
	assert.equal(blacklist.matches('Book/one.secret.md'), true);
	assert.equal(blacklist.matches('Book/public.md'), false);
	assert.deepEqual(blacklist.invalidPatterns, ['/invalid[/']);
});

test('missing-property planning scopes recursively, honors blacklist, and preserves existing SeeAlso', () => {
	const files = [
		new TFile('index.md'),
		new TFile('Diary/one.md'),
		new TFile('Diary/sub/two.md'),
		new TFile('Other/three.md'),
		new TFile('Diary/board.canvas'),
	];
	const frontmatter = new Map<string, Record<string, unknown>>([
		['Diary/one.md', { PreviousArticle: '[[old]]', SeeAlso: ['[[keep]]'] }],
	]);
	const plan = planMissingArticleProperties(
		files,
		(file) => frontmatter.get(file.path),
		DEFAULT_ARTICLE_NAVIGATOR_KEYS,
		{ folderPath: 'Diary', blacklist: compileArticleBlacklist('Diary/sub') },
	);
	assert.deepEqual(plan.skippedBlacklisted.map((file) => file.path), ['Diary/sub/two.md']);
	assert.equal(plan.files.length, 1);
	assert.equal(plan.files[0]?.file.path, 'Diary/one.md');
	assert.deepEqual(plan.files[0]?.changes.map((change) => [change.key, change.after]), [
		['NextArticle', ''],
	]);
});

test('population removes blacklisted notes from the sequence and records exact conflicts', () => {
	const first = new TFile('Diary/one.md');
	const skipped = new TFile('Diary/draft-two.md');
	const third = new TFile('Diary/three.md');
	const frontmatter = new Map<string, Record<string, unknown>>([
		[first.path, { NextArticle: '[[wrong]]' }],
		[third.path, { PreviousArticle: '' }],
	]);
	const plan = planArticleNavigation(
		[first, skipped, third, first],
		(file) => frontmatter.get(file.path),
		DEFAULT_ARTICLE_NAVIGATOR_KEYS,
		(_from, target) => `[[${target.path}]]`,
		{ blacklist: compileArticleBlacklist('/draft-/') },
	);
	assert.deepEqual(plan.skippedBlacklisted.map((file) => file.path), [skipped.path]);
	assert.deepEqual(plan.files.map((entry) => [entry.file.path, entry.changes.map((change) => [change.key, change.after])]), [
		[first.path, [['PreviousArticle', ''], ['NextArticle', '[[Diary/three.md]]']]],
		[third.path, [['PreviousArticle', '[[Diary/one.md]]'], ['NextArticle', '']]],
	]);
	assert.deepEqual(plan.conflicts.map((conflict) => ({
		path: conflict.file.path, key: conflict.key, before: conflict.before, after: conflict.after,
	})), [{
		path: first.path,
		key: 'NextArticle',
		before: '[[wrong]]',
		after: '[[Diary/three.md]]',
	}]);
});

test('public API facade builds disambiguated wikilinks and apply skips stale replacements', async () => {
	const first = new TFile('Book/one.md');
	const second = new TFile('Book/two.md');
	const frontmatter = new Map<string, Record<string, unknown>>([
		[first.path, {}],
		[second.path, {}],
	]);
	const app = {
		vault: { getMarkdownFiles: () => [first, second] },
		metadataCache: {
			getFileCache: (file: TFile) => ({ frontmatter: frontmatter.get(file.path) }),
			fileToLinktext: (target: TFile, fromPath: string) => `${fromPath}->${target.path}`,
		},
		fileManager: {
			processFrontMatter: async (file: TFile, change: (values: Record<string, unknown>) => void) => {
				const values = frontmatter.get(file.path) ?? {};
				change(values);
				frontmatter.set(file.path, values);
			},
		},
	};
	const integration = new ArticleNavigatorIntegration(app as never);
	const plan = integration.planPopulation([first, second], DEFAULT_ARTICLE_NAVIGATOR_KEYS);
	frontmatter.get(first.path)!.NextArticle = 'edited-after-preview';
	const result = await integration.apply(plan);
	assert.equal(result.filesUpdated, 2);
	assert.equal(result.propertiesWritten, 3);
	assert.equal(result.staleChangesSkipped.length, 1);
	assert.equal(frontmatter.get(first.path)?.PreviousArticle, '');
	assert.equal(frontmatter.get(first.path)?.NextArticle, 'edited-after-preview');
	assert.equal(frontmatter.get(second.path)?.PreviousArticle, '[[Book/two.md->Book/one.md]]');
	assert.equal(frontmatter.get(second.path)?.NextArticle, '');
});

test('missing-property apply remains idempotent if another writer adds SeeAlso after planning', async () => {
	const file = new TFile('Book/note.md');
	const values: Record<string, unknown> = {};
	const plan = planMissingArticleProperties([file], () => values, DEFAULT_ARTICLE_NAVIGATOR_KEYS);
	values.SeeAlso = ['[[preserve]]'];
	const result = await applyArticleMutationPlan({
		fileManager: { processFrontMatter: async (_file: TFile, change: (fm: Record<string, unknown>) => void) => change(values) },
	} as never, plan);
	assert.equal(result.propertiesWritten, 2);
	assert.deepEqual(values.SeeAlso, ['[[preserve]]']);
});
