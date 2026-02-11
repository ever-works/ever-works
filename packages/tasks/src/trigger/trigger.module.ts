import { Global, Module } from '@nestjs/common';
import { TriggerService } from './trigger.service';
import {
    DIRECTORY_GENERATION_DISPATCHER,
    DIRECTORY_IMPORT_DISPATCHER,
} from '@ever-works/agent/tasks';

@Global()
@Module({
    providers: [
        TriggerService,
        {
            provide: DIRECTORY_GENERATION_DISPATCHER,
            useExisting: TriggerService,
        },
        {
            provide: DIRECTORY_IMPORT_DISPATCHER,
            useExisting: TriggerService,
        },
    ],
    exports: [TriggerService, DIRECTORY_GENERATION_DISPATCHER, DIRECTORY_IMPORT_DISPATCHER],
})
export class TriggerModule {}
