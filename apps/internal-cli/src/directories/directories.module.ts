import { Module } from '@nestjs/common';
import { DirectoryModule } from '@ever-works/agent/services';
import { DirectoriesController } from './directories.controller';

@Module({
    imports: [DirectoryModule],
    controllers: [DirectoriesController],
})
export class DirectoriesModule {}
