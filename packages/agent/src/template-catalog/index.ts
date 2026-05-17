export { TemplateCatalogService } from './template-catalog.service';
export type { ForkTemplateResult, TemplateCatalogItem } from './template-catalog.service';
export { TemplateCatalogModule } from './template-catalog.module';
export { TemplateCustomizationService } from './template-customization.service';
export type {
    CreateAndStartCustomizationInput,
    CreateAndStartCustomizationResult,
} from './template-customization.service';
export {
    getCustomizationPromptForBaseTemplate,
    hasCustomizationPromptForBaseTemplate,
} from './customization-prompts';
