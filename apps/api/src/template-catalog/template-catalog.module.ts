import { Module } from '@nestjs/common';
import { WorkModule } from '@ever-works/agent/services';
import { TemplateCatalogController } from './template-catalog.controller';

@Module({
    imports: [WorkModule],
    controllers: [TemplateCatalogController],
})
export class TemplateCatalogModule {}
