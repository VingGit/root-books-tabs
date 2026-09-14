import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getSourcePopoutInit } from '../src/popout-position';

function sourceLeaf(screenX: unknown, screenY: unknown): unknown {
	return { getContainer: () => ({ win: { screenX, screenY } }) };
}

describe('getSourcePopoutInit', () => {
	it('uses coordinates inside the source window on a secondary display', () => {
		assert.deepEqual(getSourcePopoutInit(sourceLeaf(1920, 40)), { x: 1968, y: 88 });
	});

	it('preserves negative display coordinates', () => {
		assert.deepEqual(getSourcePopoutInit(sourceLeaf(-1600, 10)), { x: -1552, y: 58 });
	});

	it('falls back to Obsidian placement when window coordinates are unavailable', () => {
		assert.equal(getSourcePopoutInit({}), undefined);
		assert.equal(getSourcePopoutInit(sourceLeaf(Number.NaN, 10)), undefined);
	});
});
