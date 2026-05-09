import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { RemoteCallDto } from './remote-call.dto';

const constraintsFor = (
    errs: { property: string; constraints?: Record<string, string> }[],
    property: string,
) => errs.find((e) => e.property === property)?.constraints ?? {};

describe('trigger RemoteCallDto validation', () => {
    const valid = {
        name: 'workQueryService',
        method: 'getWork',
        args: { json: { id: 'w-1' } },
    };

    it('accepts a fully valid payload', async () => {
        const dto = plainToInstance(RemoteCallDto, valid);
        expect(await validate(dto)).toHaveLength(0);
    });

    it('accepts an args envelope with optional meta', async () => {
        const dto = plainToInstance(RemoteCallDto, {
            ...valid,
            args: { json: { id: 'w-1' }, meta: { values: { id: ['Date'] } } },
        });
        expect(await validate(dto)).toHaveLength(0);
    });

    it('rejects missing name via @IsString', async () => {
        const dto = plainToInstance(RemoteCallDto, { method: 'm', args: { json: null } });
        const errs = await validate(dto);
        expect(constraintsFor(errs, 'name').isString).toBeDefined();
    });

    it('rejects non-string name via @IsString', async () => {
        const dto = plainToInstance(RemoteCallDto, { ...valid, name: 42 as unknown as string });
        const errs = await validate(dto);
        expect(constraintsFor(errs, 'name').isString).toBeDefined();
    });

    it('accepts empty-string name (no @IsNotEmpty enforced — service-side guard surfaces this)', async () => {
        const dto = plainToInstance(RemoteCallDto, { ...valid, name: '' });
        expect(await validate(dto)).toHaveLength(0);
    });

    it('rejects missing method via @IsString', async () => {
        const dto = plainToInstance(RemoteCallDto, { name: 'svc', args: { json: null } });
        const errs = await validate(dto);
        expect(constraintsFor(errs, 'method').isString).toBeDefined();
    });

    it('rejects non-string method via @IsString', async () => {
        const dto = plainToInstance(RemoteCallDto, { ...valid, method: 12 as unknown as string });
        const errs = await validate(dto);
        expect(constraintsFor(errs, 'method').isString).toBeDefined();
    });

    it('rejects missing args via @IsObject', async () => {
        const dto = plainToInstance(RemoteCallDto, { name: 'svc', method: 'm' });
        const errs = await validate(dto);
        expect(constraintsFor(errs, 'args').isObject).toBeDefined();
    });

    it('rejects non-object args via @IsObject', async () => {
        const dto = plainToInstance(RemoteCallDto, {
            ...valid,
            args: 'string-args' as unknown as RemoteCallDto['args'],
        });
        const errs = await validate(dto);
        expect(constraintsFor(errs, 'args').isObject).toBeDefined();
    });

    it('rejects array args via @IsObject (class-validator distinguishes plain object from array)', async () => {
        const dto = plainToInstance(RemoteCallDto, {
            ...valid,
            args: [] as unknown as RemoteCallDto['args'],
        });
        const errs = await validate(dto);
        expect(constraintsFor(errs, 'args').isObject).toBeDefined();
    });

    it('accepts args.json being an arbitrary value (no nested validation enforced)', async () => {
        const dto = plainToInstance(RemoteCallDto, {
            ...valid,
            args: { json: 'a-string-value' },
        });
        expect(await validate(dto)).toHaveLength(0);
    });
});
