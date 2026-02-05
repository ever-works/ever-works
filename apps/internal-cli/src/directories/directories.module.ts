import { Module } from '@nestjs/common';
import { DirectoryModule } from '@packages/agent/services';
import { DirectoriesController } from './directories.controller';

@Module({
    imports: [DirectoryModule],
    controllers: [DirectoriesController],
})
export class DirectoriesModule {}
