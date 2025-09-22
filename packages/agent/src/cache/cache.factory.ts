import { CacheModule } from '@nestjs/cache-manager';
import { CacheEntry } from '../entities/cache.entity';
import { DataSource } from 'typeorm';
import { TypeORMKeyvAdapter } from './typeorm-keyv.adapter';
import { TypeOrmModule } from '@nestjs/typeorm';

type CacheOptions = {
    ttl?: number;
    namespace?: string;
    isGlobal?: boolean;
};

export const Cache = {
    InMemory() {
        return CacheModule.register({
            stores: [],
        });
    },

    TypeORM(options?: CacheOptions) {
        return CacheModule.registerAsync({
            imports: [TypeOrmModule.forFeature([CacheEntry])],
            inject: [DataSource],
            isGlobal: options?.isGlobal,
            useFactory: async (dataSource: DataSource) => {
                const repository = dataSource.getRepository(CacheEntry);

                // Create the TypeORM adapter
                const typeormAdapter = new TypeORMKeyvAdapter({
                    repository,
                    namespace: options?.namespace || 'app-cache',
                });

                return { stores: [typeormAdapter] };
            },
        });
    },
};
