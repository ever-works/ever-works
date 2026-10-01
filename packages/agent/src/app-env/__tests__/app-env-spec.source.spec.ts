import { AppEnvSpecReadSource } from '../app-env-spec.source';
import {
    APP_SPEC_USABLE_STATUSES,
    isUsableAppSpecStatus,
    type AppSpecService,
} from '../../app-spec/app-spec.service';
import { isUsableStatus } from '../../app-builds/build-spec.source';

/**
 * APW-07 — `APP_ENV_SPEC_SOURCE`, the seam every read in the env epic goes
 * through.
 *
 * Unbound it answered "no entries at all": `list` was `[]` for every App Work,
 * `missingRequired` found nothing missing, `ensureGenerated` had nothing to
 * generate. So the cases that matter are about which statuses produce a
 * snapshot and which produce `null` — get that wrong in either direction and a
 * member either loses their env or resolves one from a spec nobody validated.
 */

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const SPEC = { kind: 'app', env: [{ name: 'DATABASE_URL' }] } as never;

function specs(read: Record<string, unknown> | null): AppSpecService {
    return { getEffectiveSpec: jest.fn(async () => read) } as unknown as AppSpecService;
}

describe('AppEnvSpecReadSource', () => {
    it('answers the snapshot for a valid spec', async () => {
        const source = new AppEnvSpecReadSource(
            specs({
                status: 'valid',
                spec: SPEC,
                specHash: 'sha256:abc',
                commitSha: 'c'.repeat(40),
            }),
        );

        expect(await source.read(WORK_ID)).toEqual({
            spec: SPEC,
            specHash: 'sha256:abc',
            commitSha: 'c'.repeat(40),
        });
    });

    it('answers a snapshot for valid_with_warnings too — the departure, deliberately', async () => {
        // The comment this adapter replaces asked for `valid` alone. That drops
        // EVERY env value of an App Work whose spec has one cosmetic warning:
        // the table renders empty, nothing is reported missing, and a Deploy
        // resolves no values. A bigger failure than the one it guards against.
        const source = new AppEnvSpecReadSource(
            specs({ status: 'valid_with_warnings', spec: SPEC, specHash: null, commitSha: null }),
        );

        expect(await source.read(WORK_ID)).toEqual({
            spec: SPEC,
            specHash: null,
            commitSha: null,
        });
    });

    it('fails closed for every other status, "could not tell" included', async () => {
        for (const status of ['invalid', 'missing', 'unreadable', 'no_state', '', 'whatever']) {
            const source = new AppEnvSpecReadSource(specs({ status, spec: SPEC }));
            expect(await source.read(WORK_ID)).toBeNull();
        }
    });

    it('answers null for a usable status with NO spec, rather than an invalid snapshot', async () => {
        // `AppEnvSpecSnapshot.spec` is required. Handing APW-07 a snapshot whose
        // `spec` is null against its own type moves the failure somewhere less
        // obvious than here.
        const source = new AppEnvSpecReadSource(specs({ status: 'valid', spec: null }));

        expect(await source.read(WORK_ID)).toBeNull();
    });

    it('answers null for a Work with no App spec state at all', async () => {
        expect(await new AppEnvSpecReadSource(specs(null)).read(WORK_ID)).toBeNull();
    });

    it('reads the EFFECTIVE spec — no commit argument', async () => {
        // The env of an App Work is the env of its current spec. Reading a
        // commit would answer the env of a past one.
        const service = specs({ status: 'valid', spec: SPEC });
        await new AppEnvSpecReadSource(service).read(WORK_ID);

        expect(service.getEffectiveSpec).toHaveBeenCalledWith(WORK_ID);
    });
});

describe('APP_SPEC_USABLE_STATUSES — one list, three readers', () => {
    it('is the pair APW-03 declares', () => {
        expect([...APP_SPEC_USABLE_STATUSES]).toEqual(['valid', 'valid_with_warnings']);
    });

    it('is the SAME answer APW-05’s Build source gives', () => {
        // Four independent copies of "which statuses count as valid" was three
        // chances to drift; this pins that they are now one.
        for (const status of [
            'valid',
            'valid_with_warnings',
            'invalid',
            'missing',
            'unreadable',
            'no_state',
        ]) {
            expect(isUsableStatus(status)).toBe(isUsableAppSpecStatus(status));
        }
    });

    it('treats null and undefined as not usable', () => {
        expect(isUsableAppSpecStatus(null)).toBe(false);
        expect(isUsableAppSpecStatus(undefined)).toBe(false);
    });
});
