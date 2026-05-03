import { Module } from '@nestjs/common';
import { DatabaseModule } from '@src/database/database.module';
import { WorkOperationsService } from './work-operations.service';

@Module({
    imports: [DatabaseModule],
    providers: [WorkOperationsService],
    exports: [WorkOperationsService, DatabaseModule],
})
export class WorkOperationsModule {}
