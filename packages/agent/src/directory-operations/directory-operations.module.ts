import { Module } from '@nestjs/common';
import { DatabaseModule } from '@src/database/database.module';
import { DirectoryOperationsService } from './directory-operations.service';

@Module({
    imports: [DatabaseModule],
    providers: [DirectoryOperationsService],
    exports: [DirectoryOperationsService, DatabaseModule],
})
export class DirectoryOperationsModule {}
