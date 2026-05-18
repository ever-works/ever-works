import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { FacadesModule } from '../facades/facades.module';
import { TemplateCatalogService } from './template-catalog.service';
import { TemplateCustomizationService } from './template-customization.service';

// FacadesModule wires both GitFacadeService and CodeEditFacadeService.
// PluginsModule is registered globally via forRoot() at the app root
// (see FacadesModule header notes) so we don't import it here.
@Module({
    imports: [DatabaseModule, FacadesModule],
    providers: [TemplateCatalogService, TemplateCustomizationService],
    exports: [TemplateCatalogService, TemplateCustomizationService],
})
export class TemplateCatalogModule {}
