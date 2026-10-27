import { parseFleetHelperManifest, type FleetHelperManifest } from '@ever-works/contracts';

/**
 * Desktop view & control (FL-07, FR-21) — the fingerprints of the screen
 * helper builds THIS node package accepts, baked in at publish.
 *
 * Empty until a helper is released: building and publishing a helper, and
 * filling `targets` here from its `unsigned-release-metadata.json`
 * (`apps/node/native/ever-works-screen/build-release.{sh,ps1}`), are
 * owner-approved release steps. With no published target, `helper install`
 * says so and points at building the helper; `helper admit` then needs
 * `--allow-unpublished` and records the admission as unpublished.
 *
 * Shape: `apps/node/native/ever-works-screen/helper-manifest.schema.json`.
 */
const RAW_MANIFEST = {
	schemaVersion: 1,
	version: '0.1.0',
	targets: {}
} as const;

export const BAKED_HELPER_MANIFEST: FleetHelperManifest = parseFleetHelperManifest(RAW_MANIFEST) ?? {
	schemaVersion: 1,
	version: '0.1.0',
	targets: {}
};
