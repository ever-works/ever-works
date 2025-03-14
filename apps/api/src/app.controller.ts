import { Body, Controller, NotFoundException, Post } from '@nestjs/common';
import { DataGeneratorService } from './data-generator/data-generator.service';
import { MarkdownGeneratorService } from './markdown-generator/markdown-generator.service';
import { WebsiteGeneratorService } from './website-generator/website-generator.service';
import { Directory } from './entities/directory.entity';
import { User } from './entities/user.entity';
import { GithubService } from './git/github.service';

@Controller()
export class AppController {
  constructor(
    private readonly dataGenerator: DataGeneratorService,
    private readonly markdownGenerator: MarkdownGeneratorService,
    private readonly websiteGenerator: WebsiteGeneratorService,
    private readonly githubService: GithubService,
  ) { }

  @Post('directories')
  async createDirectory(
    @Body('slug') slug: string,
    @Body('name') name: string,
    @Body('description') description: string,
    @Body('owner') owner?: string,
  ) {
    const user = await User.sessionMock();
    const dir = new Directory();
    dir.slug = slug;
    dir.organization = typeof owner !== 'undefined';
    if (owner) {
      dir.owner = owner;
    } else {
      const owner = await this.githubService.getUser(user.getGitToken());
      dir.owner = owner.login;
    }
    dir.name = name;
    dir.description = description;

    Directory.createMock(dir);
    return dir;
  }

  @Post('generate')
  async generateData(
    @Body('slug') slug: string,
    @Body('prompt') prompt: string,
  ) {
    const user = await User.sessionMock();
    const directory = await Directory.findMock(slug);
    if (!directory) {
      throw new NotFoundException('Directory not found');
    }

    await this.dataGenerator.initialize(directory, user, prompt);
    await Promise.all([
      this.markdownGenerator.initialize(directory, user),
      this.websiteGenerator.initialize(directory, user),
    ]);

    return directory;
  }

  @Post('sync')
  async updateData(
    @Body('slug') slug: string,
    @Body('prompt') prompt: string,
  ) {
    const user = await User.sessionMock();
    const directory = await Directory.findMock(slug);
    if (!directory) {
      throw new NotFoundException('Directory not found');
    }

    await this.dataGenerator.update(directory, user, prompt);
    await this.markdownGenerator.update(directory, user);

    return directory;
  }
}
