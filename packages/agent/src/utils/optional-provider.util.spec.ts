import { Injectable, Scope } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Test } from '@nestjs/testing';

import { getOptionalProvider } from './optional-provider.util';

/**
 * `getOptionalProvider` — the lookup that actually answers `undefined`.
 *
 * Built against a REAL Nest container, because the whole point is what Nest
 * does, and a double would only restate the assumption this file exists to
 * correct.
 */

@Injectable()
class Present {
    readonly name = 'present';
}

@Injectable()
class Absent {}

@Injectable({ scope: Scope.REQUEST })
class PerRequest {}

const ABSENT_TOKEN = Symbol('ABSENT_TOKEN');
const PRESENT_TOKEN = Symbol('PRESENT_TOKEN');

async function context() {
    const moduleRef = await Test.createTestingModule({
        providers: [Present, PerRequest, { provide: PRESENT_TOKEN, useValue: { tag: 'bound' } }],
    }).compile();
    return { moduleRef, ref: moduleRef.get(ModuleRef) };
}

describe('the premise — Nest THROWS for an absent provider', () => {
    it('does not return undefined from get(..., { strict: false })', async () => {
        // The assumption behind every `if (!x) return null` after a lookup.
        // If this ever stops throwing, the helper is harmless; while it does,
        // those branches are dead.
        const { ref } = await context();

        expect(() => ref.get(Absent, { strict: false })).toThrow(/does not exist/);
        expect(() => ref.get(ABSENT_TOKEN, { strict: false })).toThrow(/does not exist/);
    });
});

describe('getOptionalProvider', () => {
    it('returns the instance when the provider is bound', async () => {
        const { ref } = await context();

        expect(getOptionalProvider<Present>(ref, Present)?.name).toBe('present');
        expect(getOptionalProvider(ref, PRESENT_TOKEN)).toEqual({ tag: 'bound' });
    });

    it('returns undefined for an absent class and an absent token', async () => {
        const { ref } = await context();

        expect(getOptionalProvider(ref, Absent)).toBeUndefined();
        expect(getOptionalProvider(ref, ABSENT_TOKEN)).toBeUndefined();
    });

    it('works on the application context a worker task holds, not only ModuleRef', async () => {
        const { moduleRef } = await context();

        expect(getOptionalProvider(moduleRef, Absent)).toBeUndefined();
        expect(getOptionalProvider<Present>(moduleRef, Present)?.name).toBe('present');
    });

    it('still THROWS for a real wiring fault — a request-scoped provider asked for statically', async () => {
        // Only "not provided" is swallowed. Treating a scope error as "unbound"
        // would turn a bug into a silent default.
        const { ref } = await context();

        expect(() => getOptionalProvider(ref, PerRequest)).toThrow();
    });
});
