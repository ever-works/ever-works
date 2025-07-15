import { Module } from '@nestjs/common';
import { DeployController } from './deploy.controller';
import { VercelService } from './vercel.service';
import { GitModule } from '../git/git.module';
import { WebsiteGeneratorModule } from '../website-generator/website-generator.module';
import { DatabaseModule } from '../database/database.module';

@Module({
    imports: [DatabaseModule, GitModule, WebsiteGeneratorModule],
    providers: [VercelService],
    controllers: [DeployController],
    exports: [VercelService],
})
export class DeployModule {}
