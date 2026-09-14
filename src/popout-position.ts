import type { WorkspaceWindowInitData } from 'obsidian';

/** Place a plugin-created pop-out slightly inside the source Obsidian window's display. */
export function getSourcePopoutInit(sourceLeaf: unknown): WorkspaceWindowInitData | undefined {
	if (!isUnknownRecord(sourceLeaf)) return undefined;
	const getContainer = sourceLeaf.getContainer;
	if (typeof getContainer !== 'function') return undefined;
	let sourceWindow: Record<string, unknown> | null = null;
	try {
		const container: unknown = Reflect.apply(getContainer, sourceLeaf, []);
		if (isUnknownRecord(container) && isUnknownRecord(container.win)) sourceWindow = container.win;
	} catch {
		return undefined;
	}
	if (!sourceWindow) return undefined;
	const { screenX, screenY } = sourceWindow;
	if (typeof screenX !== 'number' || !Number.isFinite(screenX)
		|| typeof screenY !== 'number' || !Number.isFinite(screenY)) return undefined;
	return { x: Math.round(screenX + 48), y: Math.round(screenY + 48) };
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
