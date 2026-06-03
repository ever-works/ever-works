import { Injectable, Logger } from '@nestjs/common';
import { PluginRepository } from '@ever-works/agent/plugins';
import type { PluginEntity } from '@ever-works/agent/plugins';
import type {
	PluginCatalogEntry,
	PluginCatalogResponse,
	PluginInstallStateDto,
	PluginInstallState,
	PluginInstallSource
} from '@ever-works/contracts';

/**
 * EW-693 / T22 — Plugin catalog.
 *
 * The catalog is the listable set of DISTRIBUTABLE plugins (manifest
 * `distribution: 'registry'`). v1 sources it from the local plugins
 * table only — every plugin the platform knows about already has a
 * DB row (created at boot by the loader's discover step or by a
 * prior `POST /plugins/install`), so a local query is enough.
 *
 * A future iteration can layer a registry-side listing on top
 * (e.g. `npm view @ever-works/* --json`) and merge by package name;
 * the response envelope already carries `degraded`/`degradedReason`
 * so the UI can render the merged view gracefully.
 */
@Injectable()
export class PluginCatalogService {
	private readonly logger = new Logger(PluginCatalogService.name);

	constructor(private readonly pluginRepository: PluginRepository) {}

	async listCatalog(): Promise<PluginCatalogResponse> {
		const rows = await this.pluginRepository.findAll();
		const entries = rows
			.filter((row) => this.isDistributable(row))
			.map((row) => this.toCatalogEntry(row));

		return {
			entries,
			fetchedAt: new Date().toISOString(),
			degraded: false
		};
	}

	/**
	 * Per-plugin install-state lookup used by
	 * `GET /plugins/:id/install-status`. Returns null when the plugin
	 * has no row at all (the caller maps to 404).
	 */
	async getInstallState(pluginId: string): Promise<PluginInstallStateDto | null> {
		const row = await this.pluginRepository.findByPluginId(pluginId);
		if (!row) return null;
		return this.toInstallStateDto(row);
	}

	private isDistributable(row: PluginEntity): boolean {
		const manifest = (row.manifest ?? {}) as Record<string, unknown>;
		const distribution = manifest.distribution as string | undefined;
		if (distribution === 'core' || distribution === 'registry') {
			return distribution === 'registry';
		}
		// Default derivation mirrors the SDK helper:
		// systemPlugin === true ⇒ 'core', else 'registry'.
		return manifest.systemPlugin !== true;
	}

	private toCatalogEntry(row: PluginEntity): PluginCatalogEntry {
		const manifest = (row.manifest ?? {}) as Record<string, unknown>;
		const packageName = this.packageNameFromSpec(row.registrySpec ?? undefined);
		return {
			pluginId: row.pluginId,
			name: row.name,
			description: row.description,
			category: row.category,
			capabilities: row.capabilities ?? [],
			version: row.version,
			distribution: 'registry',
			packageName,
			latestVersion: row.installedVersion ?? undefined,
			homepage: typeof manifest.homepage === 'string' ? (manifest.homepage as string) : undefined,
			author:
				typeof (manifest.author as { name?: string } | undefined)?.name === 'string'
					? ((manifest.author as { name?: string }).name as string)
					: undefined,
			deprecated:
				typeof manifest.deprecated === 'boolean' ? (manifest.deprecated as boolean) : false,
			install: this.toInstallStateDto(row)
		};
	}

	private toInstallStateDto(row: PluginEntity): PluginInstallStateDto {
		return {
			pluginId: row.pluginId,
			installState: (row.installState ?? 'available') as PluginInstallState,
			source: (row.source ?? 'bundled') as PluginInstallSource,
			registrySpec: row.registrySpec ?? undefined,
			installedVersion: row.installedVersion ?? undefined,
			integrity: row.integrity ?? undefined,
			installError: row.installError ?? undefined,
			updatedAt: row.updatedAt ? row.updatedAt.toISOString() : undefined
		};
	}

	private packageNameFromSpec(spec: string | undefined): string | undefined {
		if (!spec) return undefined;
		const at = spec.lastIndexOf('@');
		if (at <= 0) return undefined;
		return spec.slice(0, at);
	}
}
