import { Global, Module } from '@nestjs/common';
import { TriggerService } from './trigger.service';
import { WORK_GENERATION_DISPATCHER, WORK_IMPORT_DISPATCHER } from '@ever-works/agent/tasks';

@Global()
@Module({
    providers: [
        TriggerService,
        {
            provide: WORK_GENERATION_DISPATCHER,
            useExisting: TriggerService,
        },
        {
            provide: WORK_IMPORT_DISPATCHER,
            useExisting: TriggerService,
        },
    ],
    exports: [TriggerService, WORK_GENERATION_DISPATCHER, WORK_IMPORT_DISPATCHER],
})
export class TriggerModule {}
