import {
  Body,
  Controller,
  NotFoundException,
  Post,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { DataGeneratorService } from './data-generator/data-generator.service';
import { MarkdownGeneratorService } from './markdown-generator/markdown-generator.service';
import { WebsiteGeneratorService } from './website-generator/website-generator.service';
import { Directory } from './entities/directory.entity';
import { User } from './entities/user.entity';
import { GithubService } from './git/github.service';
import { GenerateDataDto } from './validators/generate-data.dto';
import { CreateDirectoryDto } from './validators/create-directory.dto';

@Controller()
export class AppController {
  constructor(
    private readonly dataGenerator: DataGeneratorService,
    private readonly markdownGenerator: MarkdownGeneratorService,
    private readonly websiteGenerator: WebsiteGeneratorService,
    private readonly githubService: GithubService,
  ) {}

  @Post('directories')
  @UsePipes(new ValidationPipe({ transform: true }))
  async createDirectory(@Body() createDirectoryDto: CreateDirectoryDto) {
    const { slug, name, description, owner } = createDirectoryDto;
    const user = await User.sessionMock();
    const dir = new Directory();
    dir.slug = slug;
    dir.organization = typeof owner !== 'undefined';
    if (owner) {
      dir.owner = owner;
    } else {
      const githubUser = await this.githubService.getUser(user.getGitToken()); // Renamed owner to githubUser to avoid conflict
      dir.owner = githubUser.login;
    }
    dir.name = name;
    dir.description = description;

    Directory.createMock(dir);
    return dir;
  }

  @Post('generate')
  @UsePipes(new ValidationPipe({ transform: true }))
  async generateData(@Body() generateDataDto: GenerateDataDto) {
    const { slug, prompt } = generateDataDto;
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
  @UsePipes(new ValidationPipe({ transform: true }))
  async updateData(@Body() updateDataDto: GenerateDataDto) {
    const { slug, prompt } = updateDataDto;

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
