import { Module } from '@nestjs/common';
import { FacadesModule } from '@packages/agent/facades';

/**
 * TriggerAiModule - now delegates to FacadesModule.
 * AI operations use AiFacadeService from the plugin system.
 */
@Module({
    imports: [FacadesModule],
    exports: [FacadesModule],
})
export class TriggerAiModule {}
