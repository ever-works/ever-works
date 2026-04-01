import { Global, Module } from '@nestjs/common';
import { ACTIVITY_LOG_ANALYTICS_DISPATCHER } from '@ever-works/agent/activity-log';
import { JitsuService } from './jitsu.service';

@Global()
@Module({
    providers: [
        JitsuService,
        {
            provide: ACTIVITY_LOG_ANALYTICS_DISPATCHER,
            useExisting: JitsuService,
        },
    ],
    exports: [JitsuService, ACTIVITY_LOG_ANALYTICS_DISPATCHER],
})
export class JitsuModule {}
