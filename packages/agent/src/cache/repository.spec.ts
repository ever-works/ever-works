import { CacheEntryRepository } from './repository';
import { TypeORMKeyvAdapter } from './typeorm-keyv.adapter';

describe('CacheEntryRepository', () => {
    it('exposes a TypeORMKeyvAdapter built around the injected typeorm repository', () => {
        const fakeRepository = { findOne: jest.fn() } as any;

        const wrapper = new CacheEntryRepository(fakeRepository);

        expect(wrapper.typeormAdapter).toBeInstanceOf(TypeORMKeyvAdapter);
        expect(wrapper.typeormAdapter._namespace).toBe('app-cache');
    });

    it('does not share adapter instances across different wrappers', () => {
        const a = new CacheEntryRepository({} as any);
        const b = new CacheEntryRepository({} as any);

        expect(a.typeormAdapter).not.toBe(b.typeormAdapter);
    });
});
