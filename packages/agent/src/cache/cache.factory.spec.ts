import { CacheFactory } from './cache.factory';
import { CacheModule } from '@nestjs/cache-manager';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CacheEntry } from '../entities/cache.entity';
import { TypeORMKeyvAdapter } from './typeorm-keyv.adapter';

jest.mock('@nestjs/cache-manager', () => ({
    CacheModule: {
        register: jest.fn(() => ({ module: 'in-memory' })),
        registerAsync: jest.fn((options) => ({ module: 'typeorm-async', options })),
    },
}));

jest.mock('@nestjs/typeorm', () => ({
    TypeOrmModule: {
        forFeature: jest.fn((entities) => ({ module: 'typeorm-feature', entities })),
    },
    InjectRepository: () => () => undefined,
}));

describe('CacheFactory', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('InMemory', () => {
        it('delegates to CacheModule.register with no arguments', () => {
            const result = CacheFactory.InMemory();

            expect(CacheModule.register).toHaveBeenCalledTimes(1);
            expect(CacheModule.register).toHaveBeenCalledWith();
            expect(result).toEqual({ module: 'in-memory' });
        });

        it('returns a fresh module reference each call (no shared state)', () => {
            CacheFactory.InMemory();
            CacheFactory.InMemory();

            expect(CacheModule.register).toHaveBeenCalledTimes(2);
        });
    });

    describe('TypeORM', () => {
        it('imports TypeOrmModule.forFeature with the CacheEntry entity', () => {
            CacheFactory.TypeORM();

            expect(TypeOrmModule.forFeature).toHaveBeenCalledWith([CacheEntry]);

            const registerCall = (CacheModule.registerAsync as jest.Mock).mock.calls[0][0];

            expect(registerCall.imports).toEqual([
                { module: 'typeorm-feature', entities: [CacheEntry] },
            ]);
        });

        it('forwards isGlobal flag undefined when no options given', () => {
            CacheFactory.TypeORM();

            const registerCall = (CacheModule.registerAsync as jest.Mock).mock.calls[0][0];
            expect(registerCall.isGlobal).toBeUndefined();
        });

        it('forwards isGlobal flag when supplied', () => {
            CacheFactory.TypeORM({ isGlobal: true });

            const registerCall = (CacheModule.registerAsync as jest.Mock).mock.calls[0][0];
            expect(registerCall.isGlobal).toBe(true);
        });

        it('factory function constructs a TypeORMKeyvAdapter from the resolved DataSource', async () => {
            CacheFactory.TypeORM({ ttl: 1000, namespace: 'test' });

            const registerCall = (CacheModule.registerAsync as jest.Mock).mock.calls[0][0];
            const fakeRepository = { findOne: jest.fn() };
            const fakeDataSource = {
                getRepository: jest.fn().mockReturnValue(fakeRepository),
            };

            const result = await registerCall.useFactory(fakeDataSource);

            expect(fakeDataSource.getRepository).toHaveBeenCalledWith(CacheEntry);
            expect(result.stores).toHaveLength(1);
            expect(result.stores[0]).toBeInstanceOf(TypeORMKeyvAdapter);
        });

        it('factory function passes through ttl and namespace to the adapter', async () => {
            CacheFactory.TypeORM({ ttl: 5000, namespace: 'my-ns' });

            const registerCall = (CacheModule.registerAsync as jest.Mock).mock.calls[0][0];
            const fakeRepository = {};
            const fakeDataSource = {
                getRepository: jest.fn().mockReturnValue(fakeRepository),
            };

            const result = await registerCall.useFactory(fakeDataSource);
            const adapter = result.stores[0] as TypeORMKeyvAdapter;

            expect(adapter._namespace).toBe('my-ns');
            expect(adapter.opts.ttl).toBe(5000);
        });

        it('factory function defaults adapter namespace to "app-cache" when omitted', async () => {
            CacheFactory.TypeORM();

            const registerCall = (CacheModule.registerAsync as jest.Mock).mock.calls[0][0];
            const fakeDataSource = {
                getRepository: jest.fn().mockReturnValue({}),
            };

            const result = await registerCall.useFactory(fakeDataSource);
            const adapter = result.stores[0] as TypeORMKeyvAdapter;

            expect(adapter._namespace).toBe('app-cache');
            expect(adapter.opts.ttl).toBeUndefined();
        });

        it('inject array contains DataSource', () => {
            CacheFactory.TypeORM();

            const registerCall = (CacheModule.registerAsync as jest.Mock).mock.calls[0][0];

            expect(Array.isArray(registerCall.inject)).toBe(true);
            expect(registerCall.inject).toHaveLength(1);
        });
    });
});
