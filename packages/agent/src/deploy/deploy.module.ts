import { Module } from '@nestjs/common';
import { VercelService } from './vercel.service';
import { GitModule } from '../git/git.module';
import { WebsiteGeneratorModule } from '../website-generator/website-generator.module';
import { DatabaseModule } from '../database/database.module';

@Module({
    imports: [DatabaseModule, GitModule, WebsiteGeneratorModule],
    providers: [VercelService],
    exports: [VercelService],
})
export class DeployModule {}
