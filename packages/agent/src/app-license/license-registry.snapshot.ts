/**
 * APW-03 (App spec, Apps catalog and license gate) — the **bundled licence
 * registry snapshot**, the last-resort copy of `licenses.yml`
 * (`catalog.md` §4; `plan.md` §2.6 "Registry": live → last good → bundled
 * snapshot).
 *
 * ## Where this came from
 *
 * Copied verbatim from `ever-works/templates` `licenses.yml` at commit
 * `46d12bbfef59bc5358c85e5a997b52988327554c`, whose own header reads
 * **"SEED / DRAFT … NOT LEGAL ADVICE AND NOT YET LEGAL-REVIEWED"**. Its
 * `licenses[]` are "the licenses our seven seed templates and their upstreams
 * actually use, not a finished registry". So `GPL-3.0`, `BSD-*`, `ISC`,
 * `MPL-2.0` and every other id not listed below classify as `unknown`. That is
 * deliberate: adding a licence is a legal-review decision (`catalog.md` §7
 * rule 3), not a code change, and this copy must not be extended here. When the
 * registry changes, re-copy it and update {@link LICENSE_REGISTRY_SNAPSHOT_SOURCE}.
 *
 * ## Why TypeScript and not `license-registry.snapshot.yml`
 *
 * `plan.md` §2.6 names a `.yml` file. The agent package is built with
 * `nest build -b swc`, which copies no non-TS assets into `dist/`, and `apps/api`
 * and `packages/tasks` consume that BUILT output. A `.yml` next to this file
 * would therefore be missing at runtime everywhere that matters. A typed
 * constant ships with the build and needs no YAML parser or file read.
 *
 * ## What reads what
 *
 * `license-classify.ts` reads `licenses[].spdx` / `.class`, `exceptions[]` and
 * `aliases[]`. It never reads `unknown`, whose `class` is advisory display
 * metadata that "never becomes a license class" (`catalog.md` §4). `unknown` is
 * kept here because it is part of the registry and carries the attestation text
 * for an unclassified licence.
 *
 * A classification made from this snapshot must force `managedHosting: false`
 * (FR-38, plan §2.6). That is the gate's job; this file only holds the data.
 */

/** The classes a registry row may carry. `unknown` is computed by the platform, never listed (`catalog.md` §4). */
export type LicenseRegistryClass = 'green' | 'amber' | 'red';

/** What an `exceptions[]` row does to the base licence's class (`catalog.md` §4). */
export type LicenseExceptionEffect = 'none' | 'class:green' | 'class:amber' | 'class:red';

/** An attestation text. Changing `text` requires a new `textId`, which invalidates earlier attestations. */
export interface LicenseRegistryAttestation {
    readonly textId: string;
    readonly text: string;
}

/** One `licenses[]` row. */
export interface LicenseRegistryLicense {
    /** An SPDX id or `LicenseRef-*`, unique in the registry. */
    readonly spdx: string;
    readonly name: string;
    readonly class: LicenseRegistryClass;
    /** Values from `obligationsVocabulary`. */
    readonly obligations: readonly string[];
    /** Required for `amber` and `red`. */
    readonly attestation?: LicenseRegistryAttestation;
}

/** One `exceptions[]` row. */
export interface LicenseRegistryException {
    readonly spdx: string;
    readonly effect: LicenseExceptionEffect;
}

/** One `aliases[]` row: a licence title (or id) found in the wild, mapped to an SPDX id. */
export interface LicenseRegistryAlias {
    readonly match: string;
    readonly spdx: string;
}

/**
 * The registry's `unknown` block. Its `class` is ADVISORY (it must not be
 * `green`) and never becomes a licence class; see the module comment.
 */
export interface LicenseRegistryUnknown {
    readonly class: Exclude<LicenseRegistryClass, 'green'>;
    readonly attestation?: LicenseRegistryAttestation;
}

/** How one class may be hosted. Fixed by CONTRACTS R-3; a registry that loosens it is rejected. */
export interface LicenseRegistryClassRules {
    readonly managedHosting: boolean | 'upstream-agreement';
    readonly yourCluster: boolean;
    readonly attestation: boolean;
    readonly catalog?: boolean;
}

/** The content of `licenses.yml` (`catalog.md` §4). */
export interface LicenseRegistryContent {
    readonly schemaVersion: number;
    readonly updatedAt: string;
    readonly classes: Readonly<Record<LicenseRegistryClass, LicenseRegistryClassRules>>;
    readonly obligationsVocabulary: readonly string[];
    readonly licenses: readonly LicenseRegistryLicense[];
    readonly exceptions: readonly LicenseRegistryException[];
    readonly aliases: readonly LicenseRegistryAlias[];
    readonly unknown?: LicenseRegistryUnknown;
}

/** Where {@link LICENSE_REGISTRY_SNAPSHOT} was copied from, and its review status. */
export const LICENSE_REGISTRY_SNAPSHOT_SOURCE = {
    repository: 'ever-works/templates',
    path: 'licenses.yml',
    commitSha: '46d12bbfef59bc5358c85e5a997b52988327554c',
    /** The seed says "NOT YET LEGAL-REVIEWED" (`catalog.md` §4: "Legal-reviewed before launch"). */
    legalReviewed: false,
} as const;

/**
 * The bundled `licenses.yml`, verbatim from
 * {@link LICENSE_REGISTRY_SNAPSHOT_SOURCE} (row order and wording kept).
 */
export const LICENSE_REGISTRY_SNAPSHOT: LicenseRegistryContent = {
    schemaVersion: 1,
    updatedAt: '2026-09-17',
    // CONTRACTS.md Resolution R-3 — do not loosen.
    classes: {
        green: { managedHosting: true, yourCluster: true, attestation: false },
        amber: { managedHosting: 'upstream-agreement', yourCluster: true, attestation: true },
        red: { managedHosting: false, yourCluster: true, attestation: true, catalog: false },
    },
    obligationsVocabulary: [
        'attribution', // keep copyright and license notices
        'state-changes', // mark modified files
        'disclose-source', // distributing binaries requires source
        'network-source-offer', // users over a network must be offered the running version's source
        'same-license', // derivative works keep the license
        'no-managed-hosting', // may not be offered as a hosted service to third parties
        'no-commercial-use',
        'no-competing-use',
        'branding-must-remain',
        'trademark-restrictions',
    ],
    licenses: [
        // ── The four Website/Work templates in this listing ──
        {
            spdx: 'AGPL-3.0-only',
            name: 'GNU Affero General Public License v3.0 only',
            class: 'green',
            obligations: ['attribution', 'disclose-source', 'same-license', 'network-source-offer'],
        },
        // ── App templates, their app sources, and this repository's own content ──
        {
            spdx: 'MIT',
            name: 'MIT License',
            class: 'green',
            obligations: ['attribution'],
        },
        {
            spdx: 'Apache-2.0',
            name: 'Apache License 2.0',
            class: 'green',
            obligations: ['attribution', 'state-changes'],
        },
        // ── Fixture licenses for the acceptance lanes (APW-13 T25) ──
        {
            spdx: 'BUSL-1.1',
            name: 'Business Source License 1.1',
            class: 'amber',
            obligations: ['no-managed-hosting'],
            attestation: {
                textId: 'busl-1.1-v1',
                text:
                    "I have read this project's license and its Additional Use Grant, and my use of this App Work on my " +
                    'own cluster complies with them.',
            },
        },
        {
            spdx: 'PolyForm-Noncommercial-1.0.0',
            name: 'PolyForm Noncommercial License 1.0.0',
            class: 'red',
            obligations: ['no-commercial-use', 'no-managed-hosting'],
            attestation: {
                textId: 'polyform-noncommercial-v1',
                text: 'I will run this App Work only for purposes this license permits, and not commercially.',
            },
        },
    ],
    exceptions: [
        // "<license> WITH <exception>" keeps the base class unless listed
        { spdx: 'Classpath-exception-2.0', effect: 'none' },
    ],
    aliases: [
        { match: 'The MIT License', spdx: 'MIT' },
        { match: 'MIT License', spdx: 'MIT' },
        // what the Git provider's license API reports for our templates
        { match: 'AGPL-3.0', spdx: 'AGPL-3.0-only' },
        { match: 'GNU Affero General Public License v3.0', spdx: 'AGPL-3.0-only' },
        { match: 'Apache License, Version 2.0', spdx: 'Apache-2.0' },
        { match: 'Business Source License 1.1', spdx: 'BUSL-1.1' },
        { match: 'PolyForm Noncommercial License 1.0.0', spdx: 'PolyForm-Noncommercial-1.0.0' },
    ],
    unknown: {
        class: 'amber', // no license, or a text the registry cannot identify
        attestation: {
            textId: 'unknown-license-v1',
            text: 'I could not find a license the registry recognises. I confirm I have the right to run this software.',
        },
    },
};
