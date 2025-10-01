import { Injectable } from '@nestjs/common';
import { CacheEntry } from '../entities/cache.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TypeORMKeyvAdapter } from './typeorm-keyv.adapter';

@Injectable()
export class CacheRepository {
    public readonly typeormAdapter: TypeORMKeyvAdapter;

    constructor(@InjectRepository(CacheEntry) repository: Repository<CacheEntry>) {
        this.typeormAdapter = new TypeORMKeyvAdapter({ repository });
    }
}
