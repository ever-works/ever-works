import { Module } from '@nestjs/common';
import { DirectoryModule } from '@packages/agent/services';
import { DirectoriesController } from './directories.controller';
import { DeployModule } from '@packages/agent/deploy';

@Module({
    imports: [DirectoryModule, DeployModule],
    controllers: [DirectoriesController],
})
export class DirectoriesModule {}
