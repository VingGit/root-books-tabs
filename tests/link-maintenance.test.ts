import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { LinkMaintenanceController } from '../src/link-maintenance';

test('link maintenance enables Obsidian automatic link updates', async () => {
	let value: unknown = false, writes = 0;
	const controller = new LinkMaintenanceController({
		settings: { forceUpdateLinks: true },
		app: { vault: {
			getConfig: (key: string) => key === 'alwaysUpdateLinks' ? value : undefined,
			setConfig: async (key: string, next: unknown) => { assert.equal(key, 'alwaysUpdateLinks'); value = next; writes++; },
		} },
	} as never);
	assert.equal(await controller.enforce(), true);
	assert.equal(value, true);
	assert.equal(writes, 1);
	assert.equal(await controller.enforce(), true);
	assert.equal(writes, 1);
});

test('link maintenance is inert when disabled or Obsidian has no config setter', async () => {
	let writes = 0;
	const disabled = new LinkMaintenanceController({
		settings: { forceUpdateLinks: false },
		app: { vault: { setConfig: () => { writes++; } } },
	} as never);
	const unavailable = new LinkMaintenanceController({
		settings: { forceUpdateLinks: true },
		app: { vault: {} },
	} as never);
	assert.equal(await disabled.enforce(), false);
	assert.equal(await unavailable.enforce(), false);
	assert.equal(writes, 0);
});

test('link maintenance contains compatibility failures', async () => {
	const controller = new LinkMaintenanceController({
		settings: { forceUpdateLinks: true },
		app: { vault: { setConfig: () => { throw new Error('unsupported'); } } },
	} as never);
	assert.equal(await controller.enforce(), false);
});
