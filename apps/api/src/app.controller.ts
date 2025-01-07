import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { DataGeneratorService } from './data-generator/data-generator.service';
import { GithubService } from './github/github.service';

@Controller()
export class AppController {
  constructor(
    private readonly dataGenerator: DataGeneratorService,
    private readonly githubService: GithubService,
  ) {}

  @Post()
  async generateData(@Body('name') name: string) {
    await this.dataGenerator.generate(name);
    return { success: true };
  }
}
