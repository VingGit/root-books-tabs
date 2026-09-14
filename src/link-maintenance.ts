import type { Vault } from 'obsidian';

interface LinkMaintenancePlugin {
	settings: { forceUpdateLinks: boolean };
	app: { vault: Vault };
}

interface VaultConfigCompatibility {
	getConfig?: (key: string) => unknown;
	setConfig?: (key: string, value: unknown) => unknown;
}

/** Keeps Obsidian's own safe-rename link maintenance enabled when requested. */
export class LinkMaintenanceController {
	constructor(private readonly plugin: LinkMaintenancePlugin) {}

	async enforce(): Promise<boolean> {
		if (!this.plugin.settings.forceUpdateLinks) return false;
		const vault = this.plugin.app.vault as unknown as VaultConfigCompatibility;
		if (typeof vault.setConfig !== 'function') return false;
		try {
			if (typeof vault.getConfig === 'function' && vault.getConfig('alwaysUpdateLinks') === true) return true;
			await Promise.resolve(vault.setConfig('alwaysUpdateLinks', true));
			return true;
		} catch {
			return false;
		}
	}
}
