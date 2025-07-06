import { Module } from '@nestjs/common';
import { AgentHTTPController } from './agent-http.controller';
import { DataGeneratorModule } from '../data-generator/data-generator.module';
import { ItemsGeneratorModule } from '../items-generator/items-generator.module';
import { GitModule } from '../git/git.module';
import { MarkdownGeneratorModule } from '../markdown-generator/markdown-generator.module';
import { WebsiteGeneratorModule } from '../website-generator/website-generator.module';
import { DeployModule } from '../deploy/deploy.module';

@Module({
	imports: [
		DataGeneratorModule,
		ItemsGeneratorModule,
		GitModule,
		MarkdownGeneratorModule,
		WebsiteGeneratorModule,
		DeployModule
	],
	controllers: [AgentHTTPController]
})
export class AgentHTTPModule {}
