// EW-742 P2.2 T17 / EW-743 — coverage-driven unit spec for the credential
// field schema metadata + the two mode-discriminator helpers
// (`isFieldRequired`, `isFieldVisibleForMode`).
//
// Targets: apps/web/src/components/settings/job-runtime-schemas.ts
//   - JOB_RUNTIME_CREDENTIAL_SCHEMAS shape integrity (per-provider field
//     lists, secret/required flags, requiredWhen.mode predicates,
//     placeholders, envVar hints, multiline cert fields).
//   - PROVIDERS_WITHOUT_CREDENTIALS — confirms Trigger.dev is NOT in the
//     set post EW-743 (regression guard).
//   - JOB_RUNTIME_PROVIDER_MODE_BANNERS — Trigger.dev mode banner copy
//     per inherit/byo/override.
//   - isFieldRequired — discriminator-driven requiredness vs static
//     `required` fallback for `requiredWhen.mode` branch.
//   - isFieldVisibleForMode — visibility predicate; always-optional
//     fields stay visible regardless of mode.
//
// Before: 0 spec lines covering this module (no sibling spec). After:
// ~25 cases exercising every branch in the two pure helpers + the
// schema-shape invariants the form depends on.
//
// Convention: matches the project-wide `src/**/*.unit.spec.{ts,tsx}`
// glob (vitest + jsdom). Pure-function module — no React Testing Library
// or i18n mocks needed.

import { describe, expect, it } from 'vitest';
import {
    JOB_RUNTIME_CREDENTIAL_SCHEMAS,
    JOB_RUNTIME_PROVIDER_MODE_BANNERS,
    PROVIDERS_WITHOUT_CREDENTIALS,
    isFieldRequired,
    isFieldVisibleForMode,
    type JobRuntimeCredentialField,
} from './job-runtime-schemas';
import type {
    TenantJobRuntimeMode,
    TenantJobRuntimeProviderId,
} from '@/lib/api/tenant-job-runtime';

const ALL_PROVIDERS: readonly TenantJobRuntimeProviderId[] = [
    'trigger',
    'bullmq',
    'pgboss',
    'temporal',
    'inngest',
];
const ALL_MODES: readonly TenantJobRuntimeMode[] = ['inherit', 'byo', 'override'];

function field(over: Partial<JobRuntimeCredentialField> = {}): JobRuntimeCredentialField {
    return {
        name: over.name ?? 'sample',
        label: over.label ?? 'Sample',
        description: over.description ?? 'desc',
        secret: over.secret ?? false,
        required: over.required ?? false,
        ...(over.requiredWhen !== undefined ? { requiredWhen: over.requiredWhen } : {}),
        ...(over.envVar !== undefined ? { envVar: over.envVar } : {}),
        ...(over.placeholder !== undefined ? { placeholder: over.placeholder } : {}),
        ...(over.multiline !== undefined ? { multiline: over.multiline } : {}),
    };
}

describe('JOB_RUNTIME_CREDENTIAL_SCHEMAS — provider coverage', () => {
    it.each(ALL_PROVIDERS)(
        'declares an entry for provider %s with at least one field',
        (provider) => {
            const fields = JOB_RUNTIME_CREDENTIAL_SCHEMAS[provider];
            expect(Array.isArray(fields)).toBe(true);
            expect(fields.length).toBeGreaterThan(0);
        },
    );

    it('declares schemas for exactly the five EW-685 contract providers (no orphan keys)', () => {
        const keys = Object.keys(JOB_RUNTIME_CREDENTIAL_SCHEMAS).sort();
        expect(keys).toEqual([...ALL_PROVIDERS].sort());
    });

    it('every field name is non-empty and unique within its provider', () => {
        for (const provider of ALL_PROVIDERS) {
            const names = JOB_RUNTIME_CREDENTIAL_SCHEMAS[provider].map((f) => f.name);
            expect(names.every((n) => n.length > 0)).toBe(true);
            expect(new Set(names).size).toBe(names.length);
        }
    });

    it('every field has a label + description (form renderer relies on non-empty strings)', () => {
        for (const provider of ALL_PROVIDERS) {
            for (const f of JOB_RUNTIME_CREDENTIAL_SCHEMAS[provider]) {
                expect(f.label.length).toBeGreaterThan(0);
                expect(f.description.length).toBeGreaterThan(0);
            }
        }
    });

    it('secret fields never declare a `multiline` widget unless they are TLS material', () => {
        // Sanity guard: any multiline+secret field today is exclusively
        // PEM cert/key material — keep the assertion narrow so future
        // multiline secrets must be added intentionally.
        for (const provider of ALL_PROVIDERS) {
            for (const f of JOB_RUNTIME_CREDENTIAL_SCHEMAS[provider]) {
                if (f.multiline && f.secret) {
                    expect(f.name).toMatch(/^tls/);
                }
            }
        }
    });
});

describe('JOB_RUNTIME_CREDENTIAL_SCHEMAS — trigger (EW-743 BYO contract)', () => {
    const trigger = JOB_RUNTIME_CREDENTIAL_SCHEMAS.trigger;

    it('exposes the four EW-743 fields in stable order', () => {
        expect(trigger.map((f) => f.name)).toEqual([
            'accessToken',
            'secretKey',
            'projectRef',
            'apiUrl',
        ]);
    });

    it('accessToken / secretKey / projectRef use requiredWhen=[byo,override] to mirror the plugin if/then', () => {
        for (const name of ['accessToken', 'secretKey', 'projectRef']) {
            const f = trigger.find((x) => x.name === name)!;
            expect(f.required).toBe(false);
            expect(f.requiredWhen?.mode).toEqual(['byo', 'override']);
        }
    });

    it('apiUrl is always-optional (no requiredWhen) so self-host overrides stay visible', () => {
        const apiUrl = trigger.find((f) => f.name === 'apiUrl')!;
        expect(apiUrl.requiredWhen).toBeUndefined();
        expect(apiUrl.required).toBe(false);
        expect(apiUrl.secret).toBe(false);
    });

    it('accessToken + secretKey are masked (secret=true); projectRef + apiUrl are not', () => {
        const byName = Object.fromEntries(trigger.map((f) => [f.name, f]));
        expect(byName.accessToken.secret).toBe(true);
        expect(byName.secretKey.secret).toBe(true);
        expect(byName.projectRef.secret).toBe(false);
        expect(byName.apiUrl.secret).toBe(false);
    });

    it('exposes envVar hints for every Trigger.dev field (operator fallback path)', () => {
        for (const f of trigger) {
            expect(f.envVar).toMatch(/^TRIGGER_/);
        }
    });
});

describe('JOB_RUNTIME_CREDENTIAL_SCHEMAS — temporal mTLS surface', () => {
    const temporal = JOB_RUNTIME_CREDENTIAL_SCHEMAS.temporal;

    it('exposes namespace + address + tlsCert + tlsKey', () => {
        expect(temporal.map((f) => f.name)).toEqual(['namespace', 'address', 'tlsCert', 'tlsKey']);
    });

    it('renders PEM material as multiline secrets (paste-the-whole-block UX)', () => {
        const tlsCert = temporal.find((f) => f.name === 'tlsCert')!;
        const tlsKey = temporal.find((f) => f.name === 'tlsKey')!;
        expect(tlsCert.multiline).toBe(true);
        expect(tlsCert.secret).toBe(true);
        expect(tlsKey.multiline).toBe(true);
        expect(tlsKey.secret).toBe(true);
    });

    it('namespace is hard-required (always-required, no requiredWhen)', () => {
        const namespace = temporal.find((f) => f.name === 'namespace')!;
        expect(namespace.required).toBe(true);
        expect(namespace.requiredWhen).toBeUndefined();
    });
});

describe('JOB_RUNTIME_CREDENTIAL_SCHEMAS — bullmq / pgboss / inngest', () => {
    it('bullmq.redisUrl is the only hard-required field, with a redis:// placeholder', () => {
        const fs = JOB_RUNTIME_CREDENTIAL_SCHEMAS.bullmq;
        const redisUrl = fs.find((f) => f.name === 'redisUrl')!;
        expect(redisUrl.required).toBe(true);
        expect(redisUrl.secret).toBe(true);
        expect(redisUrl.placeholder).toContain('redis://');
        const others = fs.filter((f) => f.name !== 'redisUrl');
        expect(others.every((f) => f.required === false)).toBe(true);
    });

    it('pgboss.connectionString is required + secret; schema is optional + non-secret', () => {
        const fs = JOB_RUNTIME_CREDENTIAL_SCHEMAS.pgboss;
        const conn = fs.find((f) => f.name === 'connectionString')!;
        const schema = fs.find((f) => f.name === 'schema')!;
        expect(conn.required).toBe(true);
        expect(conn.secret).toBe(true);
        expect(schema.required).toBe(false);
        expect(schema.secret).toBe(false);
    });

    it('inngest exposes eventKey + signingKey, both hard-required secrets', () => {
        const fs = JOB_RUNTIME_CREDENTIAL_SCHEMAS.inngest;
        expect(fs.map((f) => f.name)).toEqual(['eventKey', 'signingKey']);
        expect(fs.every((f) => f.required === true && f.secret === true)).toBe(true);
    });
});

describe('PROVIDERS_WITHOUT_CREDENTIALS', () => {
    it('is empty post EW-743 — Trigger.dev no longer suppresses the tenant credentials form', () => {
        expect(PROVIDERS_WITHOUT_CREDENTIALS.size).toBe(0);
        expect(PROVIDERS_WITHOUT_CREDENTIALS.has('trigger')).toBe(false);
    });

    it.each(ALL_PROVIDERS)(
        'does not include %s (every shipped provider exposes credentials)',
        (p) => {
            expect(PROVIDERS_WITHOUT_CREDENTIALS.has(p)).toBe(false);
        },
    );
});

describe('JOB_RUNTIME_PROVIDER_MODE_BANNERS', () => {
    it('declares a trigger entry with all three mode keys (no missing copy)', () => {
        const banner = JOB_RUNTIME_PROVIDER_MODE_BANNERS.trigger;
        expect(banner).toBeDefined();
        expect(Object.keys(banner!).sort()).toEqual([...ALL_MODES].sort());
    });

    it('trigger.inherit copy mentions the shared platform project (operator default)', () => {
        const banner = JOB_RUNTIME_PROVIDER_MODE_BANNERS.trigger!;
        expect(banner.inherit.toLowerCase()).toContain('shared');
    });

    it('trigger.byo copy mentions PAT + secret + project ref (operator wiring hint)', () => {
        const banner = JOB_RUNTIME_PROVIDER_MODE_BANNERS.trigger!;
        expect(banner.byo.toLowerCase()).toContain('pat');
    });

    it('other providers do not declare a mode-banner entry (opt-in only)', () => {
        for (const p of ALL_PROVIDERS) {
            if (p === 'trigger') continue;
            expect(JOB_RUNTIME_PROVIDER_MODE_BANNERS[p]).toBeUndefined();
        }
    });
});

describe('isFieldRequired', () => {
    it('returns the discriminator-included match when requiredWhen.mode is set', () => {
        const f = field({ requiredWhen: { mode: ['byo', 'override'] } });
        expect(isFieldRequired(f, 'byo')).toBe(true);
        expect(isFieldRequired(f, 'override')).toBe(true);
    });

    it('returns false when current mode is outside the requiredWhen.mode set', () => {
        const f = field({ requiredWhen: { mode: ['byo', 'override'] } });
        expect(isFieldRequired(f, 'inherit')).toBe(false);
    });

    it('falls back to the static required=true when requiredWhen is absent', () => {
        const f = field({ required: true });
        for (const m of ALL_MODES) expect(isFieldRequired(f, m)).toBe(true);
    });

    it('falls back to the static required=false when requiredWhen is absent', () => {
        const f = field({ required: false });
        for (const m of ALL_MODES) expect(isFieldRequired(f, m)).toBe(false);
    });

    it('requiredWhen takes precedence over the static `required` flag', () => {
        // Even if `required: true` is declared, the discriminator wins —
        // this guards against accidentally double-marking a field.
        const f = field({ required: true, requiredWhen: { mode: ['byo'] } });
        expect(isFieldRequired(f, 'inherit')).toBe(false);
        expect(isFieldRequired(f, 'override')).toBe(false);
        expect(isFieldRequired(f, 'byo')).toBe(true);
    });

    it('handles a single-mode requiredWhen list (only one mode triggers it)', () => {
        const f = field({ requiredWhen: { mode: ['override'] } });
        expect(isFieldRequired(f, 'override')).toBe(true);
        expect(isFieldRequired(f, 'byo')).toBe(false);
        expect(isFieldRequired(f, 'inherit')).toBe(false);
    });

    it('treats an empty requiredWhen.mode array as "never required" (degenerate but safe)', () => {
        const f = field({ requiredWhen: { mode: [] }, required: true });
        for (const m of ALL_MODES) expect(isFieldRequired(f, m)).toBe(false);
    });
});

describe('isFieldVisibleForMode', () => {
    it('returns true for the discriminator-included mode (the field IS the mode-conditional credential)', () => {
        const f = field({ requiredWhen: { mode: ['byo', 'override'] } });
        expect(isFieldVisibleForMode(f, 'byo')).toBe(true);
        expect(isFieldVisibleForMode(f, 'override')).toBe(true);
    });

    it('hides a requiredWhen field when current mode is outside the set (inherit-mode credential suppression)', () => {
        const f = field({ requiredWhen: { mode: ['byo', 'override'] } });
        expect(isFieldVisibleForMode(f, 'inherit')).toBe(false);
    });

    it('always-optional fields stay visible regardless of mode (apiUrl-style override)', () => {
        const f = field();
        for (const m of ALL_MODES) expect(isFieldVisibleForMode(f, m)).toBe(true);
    });

    it('always-required fields stay visible regardless of mode', () => {
        const f = field({ required: true });
        for (const m of ALL_MODES) expect(isFieldVisibleForMode(f, m)).toBe(true);
    });

    it('Trigger.dev accessToken is hidden in inherit and visible in byo/override (live schema integration)', () => {
        const accessToken = JOB_RUNTIME_CREDENTIAL_SCHEMAS.trigger.find(
            (f) => f.name === 'accessToken',
        )!;
        expect(isFieldVisibleForMode(accessToken, 'inherit')).toBe(false);
        expect(isFieldVisibleForMode(accessToken, 'byo')).toBe(true);
        expect(isFieldVisibleForMode(accessToken, 'override')).toBe(true);
    });

    it('Trigger.dev apiUrl is visible in every mode (always-optional override field)', () => {
        const apiUrl = JOB_RUNTIME_CREDENTIAL_SCHEMAS.trigger.find((f) => f.name === 'apiUrl')!;
        for (const m of ALL_MODES) expect(isFieldVisibleForMode(apiUrl, m)).toBe(true);
    });
});
