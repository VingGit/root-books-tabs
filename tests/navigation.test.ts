import assert from 'node:assert/strict';
import test from 'node:test';
import { TFile } from 'obsidian';
import { BookNavigationController } from '../src/navigation';

test('excluded files clicked in the explorer request a focused tab on the first click', async () => {
	const parent = {};
	const leaf = { parent };
	const file = new TFile('templates/example.md');
	const plugin = {
		app: { workspace: { getMostRecentLeaf: () => leaf } },
		scopeResolver: {
			resolveExcludedFile: (candidate: TFile) => candidate.path.startsWith('templates/'),
		},
	};
	const controller = new BookNavigationController(plugin as never);
	let requestedMode: unknown = null;
	const internals = controller as unknown as {
		routeOpen(leaf: unknown, file: TFile, state: unknown, original: unknown): Promise<void>;
		routeExcludedOpen(source: unknown, file: TFile, state: unknown, original: unknown, mode?: unknown): Promise<void>;
	};
	internals.routeExcludedOpen = async (_source, _file, _state, _original, mode) => { requestedMode = mode; };
	controller.expectFileExplorerOpen(file.path);

	await internals.routeOpen(leaf, file, undefined, async () => {});

	assert.equal(requestedMode, 'focused-tab');
});

test('non-explorer excluded navigation keeps the configured opening mode', async () => {
	const parent = {};
	const leaf = { parent };
	const file = new TFile('templates/example.md');
	const plugin = {
		app: { workspace: { getMostRecentLeaf: () => leaf } },
		scopeResolver: { resolveExcludedFile: () => true },
	};
	const controller = new BookNavigationController(plugin as never);
	let requestedMode: unknown = 'unseen';
	const internals = controller as unknown as {
		routeOpen(leaf: unknown, file: TFile, state: unknown, original: unknown): Promise<void>;
		routeExcludedOpen(source: unknown, file: TFile, state: unknown, original: unknown, mode?: unknown): Promise<void>;
	};
	internals.routeExcludedOpen = async (_source, _file, _state, _original, mode) => { requestedMode = mode; };

	await internals.routeOpen(leaf, file, undefined, async () => {});

	assert.equal(requestedMode, undefined);
});
