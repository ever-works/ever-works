import { Module } from '@nestjs/common';
import { TemplateCatalogModule as AgentTemplateCatalogModule } from '@ever-works/agent/template-catalog';
import { ActivityLogModule } from '@ever-works/agent/activity-log';
import { TemplateCatalogController } from './template-catalog.controller';

@Module({
    imports: [AgentTemplateCatalogModule, ActivityLogModule],
    controllers: [TemplateCatalogController],
})
export class TemplateCatalogModule {}
