import { Module, forwardRef } from '@nestjs/common';
import { CodeUpdateGeneratorModule } from '@ever-works/agent/generators';
import { DatabaseModule } from '@ever-works/agent/database';
import { WorkModule } from '@ever-works/agent/services';
import { ActivityLogModule } from '@ever-works/agent/activity-log';
import { AuthModule } from '../auth/auth.module';
import { CodeUpdateController } from './code-update.controller';

@Module({
    imports: [
        CodeUpdateGeneratorModule,
        DatabaseModule,
        WorkModule,
        ActivityLogModule,
        forwardRef(() => AuthModule),
    ],
    controllers: [CodeUpdateController],
})
export class CodeUpdateModule {}
