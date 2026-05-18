import { TemplateCustomizationPayload } from './template-customization.types';

export interface TemplateCustomizationDispatcher {
    dispatchTemplateCustomization(payload: TemplateCustomizationPayload): Promise<string | null>;
}

export const TEMPLATE_CUSTOMIZATION_DISPATCHER = Symbol('TEMPLATE_CUSTOMIZATION_DISPATCHER');
