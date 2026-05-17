import { Module } from '@nestjs/common';
import { TemplateCatalogModule as AgentTemplateCatalogModule } from '@ever-works/agent/template-catalog';
import { FacadesModule } from '@ever-works/agent/facades';
import { ActivityLogModule } from '@ever-works/agent/activity-log';
import { TemplateCatalogController } from './template-catalog.controller';

@Module({
    imports: [AgentTemplateCatalogModule, FacadesModule, ActivityLogModule],
    controllers: [TemplateCatalogController],
})
export class TemplateCatalogModule {}
