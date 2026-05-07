import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { FacadesModule } from '../facades/facades.module';
import { TemplateCatalogService } from './template-catalog.service';

@Module({
    imports: [DatabaseModule, FacadesModule],
    providers: [TemplateCatalogService],
    exports: [TemplateCatalogService],
})
export class TemplateCatalogModule {}
