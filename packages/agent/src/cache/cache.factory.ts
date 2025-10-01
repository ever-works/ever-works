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

export const CacheFactory = {
    InMemory() {
        return CacheModule.register();
    },

    TypeORM(options?: CacheOptions) {
        return CacheModule.register({
            imports: [TypeOrmModule.forFeature([CacheEntry])],
            inject: [DataSource],
            isGlobal: options?.isGlobal,
            useFactory: (dataSource: DataSource) => {
                const repository = dataSource.getRepository(CacheEntry);

                // Create the TypeORM adapter
                const typeormAdapter = new TypeORMKeyvAdapter({
                    repository,
                    namespace: options?.namespace,
                    ttl: options?.ttl,
                });

                return { stores: [typeormAdapter] };
            },
        });
    },
};
