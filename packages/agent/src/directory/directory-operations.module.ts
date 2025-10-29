import { Module } from '@nestjs/common';
import { DatabaseModule } from '@src/database/database.module';
import { DatabaseDirectoryOperationsService } from './database-directory-operations.service';
import { DIRECTORY_OPERATIONS } from './directory-operations.interface';

@Module({
    imports: [DatabaseModule],
    providers: [
        DatabaseDirectoryOperationsService,
        {
            provide: DIRECTORY_OPERATIONS,
            useExisting: DatabaseDirectoryOperationsService,
        },
    ],
    exports: [DIRECTORY_OPERATIONS],
})
export class DirectoryOperationsModule {}
