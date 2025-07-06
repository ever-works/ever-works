import { Module } from '@nestjs/common';
import { DeployController } from './deploy.controller';
import { VercelService } from './vercel.service';
import { GitModule } from '../git/git.module';
import { WebsiteGeneratorModule } from '../website-generator/website-generator.module';

@Module({
    imports: [GitModule, WebsiteGeneratorModule],
    providers: [VercelService],
    controllers: [DeployController],
})
export class DeployModule {}
