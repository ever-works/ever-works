import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
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
import { CreateItemsGeneratorDto } from './items-generator/dto/create-items-generator.dto';
import { ItemsGeneratorResponseDto } from './items-generator/dto/items-generator-response.dto';
import { CreateDirectoryDto } from './dto/create-directory.dto';

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
      const owner = await this.githubService.getUser(user.getGitToken());
      dir.owner = owner.login;
    }
    dir.name = name;
    dir.description = description;

    Directory.createMock(dir);
    return dir;
  }

  @Post('generate')
  @HttpCode(HttpStatus.ACCEPTED)
  async generateItemsGenerator(
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    createItemsGeneratorDto: CreateItemsGeneratorDto,
  ): Promise<ItemsGeneratorResponseDto> {
    const user = await User.sessionMock();
    const directory = await Directory.findMock(createItemsGeneratorDto.slug);
    if (!directory) {
      throw new NotFoundException('Directory not found');
    }

    // Intentionally not awaiting this to allow for an immediate response
    // The actual processing will happen in the background.
    // A more robust solution might involve job queues, webhooks, or websockets for status updates.
    (async () => {
      const startTime = new Date();
      console.log(`Generation started at: ${startTime.toISOString()}`);

      const generated = await this.dataGenerator.initialize(
        directory,
        user,
        createItemsGeneratorDto,
      );

      if (generated) {
        await Promise.all([
          this.markdownGenerator.initialize(directory, user),
          this.websiteGenerator.initialize(directory, user),
        ]);
      }

      const endTime = new Date();
      console.log(`Generation finished at: ${endTime.toISOString()}`);
      const duration = (endTime.getTime() - startTime.getTime()) / 1000;
      console.log(`Total time taken: ${duration} seconds`);
    })();

    return {
      status: 'pending',
      slug: createItemsGeneratorDto.slug,
      message: `Processing request for '${createItemsGeneratorDto.name}'. Check logs or data directory for updates.`,
    };
  }

  @Post('sync')
  async updateData(
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    createItemsGeneratorDto: CreateItemsGeneratorDto,
  ) {
    const user = await User.sessionMock();
    const directory = await Directory.findMock(createItemsGeneratorDto.slug);
    if (!directory) {
      throw new NotFoundException('Directory not found');
    }

    await this.dataGenerator.update(directory, user, createItemsGeneratorDto);
    await this.markdownGenerator.update(directory, user);

    return directory;
  }
}
