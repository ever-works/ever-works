import { Module } from '@nestjs/common';
import { TemplateCatalogModule as AgentTemplateCatalogModule } from '@ever-works/agent/template-catalog';
import { TemplateCatalogController } from './template-catalog.controller';

@Module({
    imports: [AgentTemplateCatalogModule],
    controllers: [TemplateCatalogController],
})
export class TemplateCatalogModule {}
