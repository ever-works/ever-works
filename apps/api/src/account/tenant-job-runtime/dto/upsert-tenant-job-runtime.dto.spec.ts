// EW-742 / EW-746 — coverage-driven unit spec for the
// `PUT /api/account/job-runtime/config` request DTO.
//
// Targets: apps/api/src/account/tenant-job-runtime/dto/upsert-tenant-job-runtime.dto.ts
//   - providerId enum gate (TENANT_JOB_RUNTIME_PROVIDER_IDS)
//   - mode enum gate (TENANT_JOB_RUNTIME_MODES)
//   - credentialsSecretRef required-when-mode!=inherit invariant (ValidateIf branch)
//   - credentialsSecretRef MaxLength(128) ceiling
//   - enabled optional boolean (@IsOptional / @IsBoolean path)
//   - Static enum tuples shipped at the expected width (regression guard
//     against accidentally dropping a provider id from the floor-level
//     allow-list)
//
// Before: 0 spec lines covering this DTO. After: ~22 cases pinning every
// validator branch + the enum-tuple invariants the controller relies on.

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
    TENANT_JOB_RUNTIME_MODES,
    TENANT_JOB_RUNTIME_PROVIDER_IDS,
    UpsertTenantJobRuntimeConfigDto,
    type TenantJobRuntimeMode,
    type TenantJobRuntimeProviderId,
} from './upsert-tenant-job-runtime.dto';

function makeDto(over: Partial<Record<string, unknown>> = {}) {
    return plainToInstance(UpsertTenantJobRuntimeConfigDto, {
        providerId: 'trigger',
        mode: 'byo',
        credentialsSecretRef: 'tenant-job-runtime:abc:trigger:v1',
        enabled: true,
        ...over,
    });
}

async function errorsFor(over: Partial<Record<string, unknown>> = {}) {
    return validate(makeDto(over));
}

describe('TENANT_JOB_RUNTIME_PROVIDER_IDS — floor-level enum (EW-685 contract)', () => {
    it('ships exactly five provider ids in stable order (regression guard)', () => {
        expect(TENANT_JOB_RUNTIME_PROVIDER_IDS).toEqual([
            'trigger',
            'temporal',
            'bullmq',
            'pgboss',
            'inngest',
        ]);
    });

    it('every id is non-empty and unique', () => {
        const set = new Set(TENANT_JOB_RUNTIME_PROVIDER_IDS);
        expect(set.size).toBe(TENANT_JOB_RUNTIME_PROVIDER_IDS.length);
        expect([...set].every((id) => id.length > 0)).toBe(true);
    });
});

describe('TENANT_JOB_RUNTIME_MODES — ADR-017 §1 enum', () => {
    it('ships exactly three modes: inherit | byo | override', () => {
        expect(TENANT_JOB_RUNTIME_MODES).toEqual(['inherit', 'byo', 'override']);
    });
});

describe('UpsertTenantJobRuntimeConfigDto — happy paths', () => {
    it('accepts a well-formed BYO payload with provider + mode + secret ref', async () => {
        const errors = await errorsFor();
        expect(errors).toHaveLength(0);
    });

    it.each(TENANT_JOB_RUNTIME_PROVIDER_IDS)(
        'accepts providerId=%s (every EW-685 provider stays in the floor allow-list)',
        async (providerId) => {
            const errors = await errorsFor({ providerId });
            expect(errors.find((e) => e.property === 'providerId')).toBeUndefined();
        },
    );

    it('accepts mode=byo and mode=override with a credentialsSecretRef', async () => {
        for (const mode of ['byo', 'override'] as TenantJobRuntimeMode[]) {
            const errors = await errorsFor({ mode });
            expect(errors).toHaveLength(0);
        }
    });

    it('accepts mode=inherit WITHOUT a credentialsSecretRef (ValidateIf skips IsString)', async () => {
        const errors = await errorsFor({ mode: 'inherit', credentialsSecretRef: undefined });
        expect(errors).toHaveLength(0);
    });

    it('accepts mode=inherit WITH a credentialsSecretRef present (DTO-level pass-through; service layer enforces "forbidden when inherit")', async () => {
        // ValidateIf runs IsString/MaxLength only when mode != inherit, so
        // a present-but-allowed-by-DTO string in inherit mode does NOT
        // emit a validator error here. The forbidden-when-inherit rule is
        // enforced at the service layer with a precise message.
        const errors = await errorsFor({
            mode: 'inherit',
            credentialsSecretRef: 'should-be-rejected-by-service-not-dto',
        });
        expect(errors).toHaveLength(0);
    });

    it('accepts omitted `enabled` (treated as default-true at the service layer)', async () => {
        const errors = await errorsFor({ enabled: undefined });
        expect(errors.find((e) => e.property === 'enabled')).toBeUndefined();
    });

    it('accepts enabled=false (soft-disable without dropping the row)', async () => {
        const errors = await errorsFor({ enabled: false });
        expect(errors).toHaveLength(0);
    });
});

describe('UpsertTenantJobRuntimeConfigDto — providerId enum gate', () => {
    it('rejects an unknown providerId (floor-level allow-list)', async () => {
        const errors = await errorsFor({ providerId: 'gearman' });
        const err = errors.find((e) => e.property === 'providerId');
        expect(err).toBeDefined();
        expect(err?.constraints).toHaveProperty('isIn');
    });

    it('rejects a numeric providerId (IsString gate)', async () => {
        const errors = await errorsFor({ providerId: 42 });
        const err = errors.find((e) => e.property === 'providerId');
        expect(err).toBeDefined();
    });

    it('rejects an empty-string providerId', async () => {
        const errors = await errorsFor({ providerId: '' });
        const err = errors.find((e) => e.property === 'providerId');
        expect(err).toBeDefined();
        expect(err?.constraints).toHaveProperty('isIn');
    });
});

describe('UpsertTenantJobRuntimeConfigDto — mode enum gate', () => {
    it.each(['unknown', 'INHERIT', 'BYO', 'Override'])(
        'rejects mode=%s (case-sensitive enum)',
        async (mode) => {
            const errors = await errorsFor({ mode });
            const err = errors.find((e) => e.property === 'mode');
            expect(err).toBeDefined();
            expect(err?.constraints).toHaveProperty('isIn');
        },
    );

    it('rejects a missing mode entirely', async () => {
        const errors = await errorsFor({ mode: undefined });
        const err = errors.find((e) => e.property === 'mode');
        expect(err).toBeDefined();
    });
});

describe('UpsertTenantJobRuntimeConfigDto — credentialsSecretRef required-when-mode!=inherit', () => {
    it('rejects missing credentialsSecretRef when mode=byo', async () => {
        const errors = await errorsFor({ mode: 'byo', credentialsSecretRef: undefined });
        const err = errors.find((e) => e.property === 'credentialsSecretRef');
        expect(err).toBeDefined();
        // ValidateIf flips IsString back on → undefined triggers isString.
        expect(err?.constraints).toHaveProperty('isString');
    });

    it('rejects missing credentialsSecretRef when mode=override', async () => {
        const errors = await errorsFor({ mode: 'override', credentialsSecretRef: undefined });
        const err = errors.find((e) => e.property === 'credentialsSecretRef');
        expect(err).toBeDefined();
        expect(err?.constraints).toHaveProperty('isString');
    });

    it('rejects null credentialsSecretRef when mode=byo (no @IsOptional escape hatch)', async () => {
        const errors = await errorsFor({ mode: 'byo', credentialsSecretRef: null });
        const err = errors.find((e) => e.property === 'credentialsSecretRef');
        expect(err).toBeDefined();
    });

    it('rejects non-string credentialsSecretRef when mode=byo', async () => {
        const errors = await errorsFor({ mode: 'byo', credentialsSecretRef: 12345 });
        const err = errors.find((e) => e.property === 'credentialsSecretRef');
        expect(err).toBeDefined();
        expect(err?.constraints).toHaveProperty('isString');
    });

    it('rejects credentialsSecretRef longer than 128 chars (MaxLength ceiling)', async () => {
        const tooLong = 'x'.repeat(129);
        const errors = await errorsFor({ credentialsSecretRef: tooLong });
        const err = errors.find((e) => e.property === 'credentialsSecretRef');
        expect(err).toBeDefined();
        expect(err?.constraints).toHaveProperty('maxLength');
    });

    it('accepts credentialsSecretRef at exactly the 128-char boundary', async () => {
        const exactly = 'x'.repeat(128);
        const errors = await errorsFor({ credentialsSecretRef: exactly });
        expect(errors.find((e) => e.property === 'credentialsSecretRef')).toBeUndefined();
    });
});

describe('UpsertTenantJobRuntimeConfigDto — enabled', () => {
    it('rejects non-boolean enabled (IsBoolean gate)', async () => {
        const errors = await errorsFor({ enabled: 'yes' });
        const err = errors.find((e) => e.property === 'enabled');
        expect(err).toBeDefined();
        expect(err?.constraints).toHaveProperty('isBoolean');
    });

    it('accepts enabled=true and enabled=false', async () => {
        for (const v of [true, false]) {
            const errors = await errorsFor({ enabled: v });
            expect(errors.find((e) => e.property === 'enabled')).toBeUndefined();
        }
    });

    it('treats omitted enabled as valid (IsOptional)', async () => {
        const dto = plainToInstance(UpsertTenantJobRuntimeConfigDto, {
            providerId: 'trigger',
            mode: 'inherit',
        });
        const errors = await validate(dto);
        expect(errors.find((e) => e.property === 'enabled')).toBeUndefined();
    });
});

describe('UpsertTenantJobRuntimeConfigDto — type exports stay aligned with the enum tuples', () => {
    it('TenantJobRuntimeProviderId values match TENANT_JOB_RUNTIME_PROVIDER_IDS at runtime', () => {
        // Round-trip: every literal in the tuple is assignable to the
        // exported union type (compile-time) AND echoed back in the array
        // (runtime). Guards against the tuple drifting from the type.
        const literals: TenantJobRuntimeProviderId[] = [
            'trigger',
            'temporal',
            'bullmq',
            'pgboss',
            'inngest',
        ];
        for (const id of literals) {
            expect(TENANT_JOB_RUNTIME_PROVIDER_IDS).toContain(id);
        }
    });

    it('TenantJobRuntimeMode values match TENANT_JOB_RUNTIME_MODES at runtime', () => {
        const literals: TenantJobRuntimeMode[] = ['inherit', 'byo', 'override'];
        for (const m of literals) {
            expect(TENANT_JOB_RUNTIME_MODES).toContain(m);
        }
    });
});
