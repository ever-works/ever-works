import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
    IsValidCapability,
    IsValidCapabilityConstraint,
    isValidCapability,
    getValidCapabilities,
} from './capability.validator';
import {
    ALL_PLUGIN_CAPABILITIES,
    PLUGIN_CAPABILITIES,
    isValidPluginCapability,
} from '@ever-works/plugin';

describe('IsValidCapabilityConstraint', () => {
    const constraint = new IsValidCapabilityConstraint();
    const argsStub = (value: unknown) => ({ value }) as unknown as Parameters<typeof constraint.validate>[1];

    it.each(Object.values(PLUGIN_CAPABILITIES))(
        'validate(%s) returns true for the documented capability',
        (capability) => {
            expect(constraint.validate(capability, argsStub(capability))).toBe(true);
        },
    );

    it('validate(unknown string) returns false', () => {
        expect(constraint.validate('not-a-capability', argsStub('not-a-capability'))).toBe(false);
    });

    it('validate(empty string) returns false', () => {
        expect(constraint.validate('', argsStub(''))).toBe(false);
    });

    it.each([null, undefined, 0, 1, true, false, {}, [], [PLUGIN_CAPABILITIES.SEARCH]])(
        'validate(non-string %p) returns false',
        (value) => {
            expect(constraint.validate(value, argsStub(value))).toBe(false);
        },
    );

    it('defaultMessage interpolates the offending value into the error string', () => {
        const message = constraint.defaultMessage(argsStub('bogus'));
        expect(message).toContain("'bogus' is not a valid capability");
    });

    it('defaultMessage lists every documented capability after the value', () => {
        const message = constraint.defaultMessage(argsStub('bogus'));
        const expectedTail = `Valid capabilities are: ${ALL_PLUGIN_CAPABILITIES.join(', ')}`;
        expect(message.endsWith(expectedTail)).toBe(true);
    });

    it('defaultMessage interpolates non-string values via template-literal coercion', () => {
        // null → 'null', undefined → 'undefined', 42 → '42'
        expect(constraint.defaultMessage(argsStub(null))).toContain("'null' is not a valid capability");
        expect(constraint.defaultMessage(argsStub(undefined))).toContain(
            "'undefined' is not a valid capability",
        );
        expect(constraint.defaultMessage(argsStub(42))).toContain("'42' is not a valid capability");
    });
});

describe('@IsValidCapability decorator', () => {
    class Dto {
        @IsValidCapability()
        capability!: unknown;
    }

    class DtoCustomMessage {
        @IsValidCapability({ message: 'pick a real capability' })
        capability!: unknown;
    }

    it.each(Object.values(PLUGIN_CAPABILITIES))(
        'accepts the documented capability "%s"',
        async (cap) => {
            const dto = plainToInstance(Dto, { capability: cap });
            const errors = await validate(dto);
            expect(errors).toHaveLength(0);
        },
    );

    it('rejects unknown capability strings', async () => {
        const dto = plainToInstance(Dto, { capability: 'totally-fake' });
        const errors = await validate(dto);
        expect(errors).toHaveLength(1);
        expect(errors[0].constraints).toBeDefined();
        const messages = Object.values(errors[0].constraints ?? {});
        expect(messages.some((m) => m.includes("'totally-fake' is not a valid capability"))).toBe(true);
    });

    it('rejects non-string values', async () => {
        const dto = plainToInstance(Dto, { capability: 123 });
        const errors = await validate(dto);
        expect(errors).toHaveLength(1);
    });

    it('rejects null and undefined', async () => {
        const dtoNull = plainToInstance(Dto, { capability: null });
        const dtoUndefined = plainToInstance(Dto, { capability: undefined });
        await expect(validate(dtoNull)).resolves.toHaveLength(1);
        await expect(validate(dtoUndefined)).resolves.toHaveLength(1);
    });

    it('honors a caller-provided message in ValidationOptions', async () => {
        const dto = plainToInstance(DtoCustomMessage, { capability: 'nope' });
        const errors = await validate(dto);
        expect(errors).toHaveLength(1);
        expect(Object.values(errors[0].constraints ?? {})).toContain('pick a real capability');
    });

    it('uses the constraint name "isValidCapability" so collected errors are keyed predictably', async () => {
        const dto = plainToInstance(Dto, { capability: 'nope' });
        const errors = await validate(dto);
        expect(errors).toHaveLength(1);
        expect(Object.keys(errors[0].constraints ?? {})).toEqual(['isValidCapability']);
    });
});

describe('barrel re-exports', () => {
    it('re-exports isValidPluginCapability under the local alias `isValidCapability`', () => {
        // Identity check (not just toEqual): ensures the file forwards the same function reference.
        expect(isValidCapability).toBe(isValidPluginCapability);
    });

    it('isValidCapability(value) accepts every documented capability', () => {
        for (const cap of ALL_PLUGIN_CAPABILITIES) {
            expect(isValidCapability(cap)).toBe(true);
        }
    });

    it('isValidCapability(value) rejects unknown strings and non-strings', () => {
        expect(isValidCapability('nope')).toBe(false);
        expect(isValidCapability(undefined)).toBe(false);
        expect(isValidCapability(null)).toBe(false);
        expect(isValidCapability(42)).toBe(false);
    });
});

describe('getValidCapabilities', () => {
    it('returns the same array reference as ALL_PLUGIN_CAPABILITIES (no defensive copy)', () => {
        // Function returns readonly string[]; at runtime it is the same array object.
        expect(getValidCapabilities()).toBe(ALL_PLUGIN_CAPABILITIES);
    });

    it('returned array contains every documented capability id', () => {
        const caps = getValidCapabilities();
        for (const cap of Object.values(PLUGIN_CAPABILITIES)) {
            expect(caps).toContain(cap);
        }
    });

    it('returned array length matches the documented PLUGIN_CAPABILITIES surface', () => {
        expect(getValidCapabilities()).toHaveLength(Object.keys(PLUGIN_CAPABILITIES).length);
    });
});
