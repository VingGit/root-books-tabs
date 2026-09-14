import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { migrateRuntimeState, migrateSettings } from '../src/settings-model';

test('excluded files default beside the current group and accept the pop-out override', () => {
	assert.equal(migrateSettings({}).excludedFileGroupLocation, 'next-to-current');
	assert.equal(migrateSettings({ excludedFileGroupLocation: 'popout' }).excludedFileGroupLocation, 'popout');
	assert.equal(migrateSettings({ excludedFileGroupLocation: 'invalid' }).excludedFileGroupLocation, 'next-to-current');
});

test('excluded group ownership survives runtime-state migration', () => {
	const state = migrateRuntimeState({
		version: 1,
		groups: { excluded: { kind: 'excluded', location: 'main' } },
		bookOrder: [],
		gridBaseBookIds: [],
	});
	assert.deepEqual(state.groups.excluded, { kind: 'excluded', location: 'main' });
});
