import * as cheerio from 'cheerio';
import { Logger } from '@nestjs/common';
import slugify from 'slugify';

const logger = new Logger('TextUtils');

export function extractTextFromHtml(htmlContent: string): string {
  try {
    const $ = cheerio.load(htmlContent);
    // Remove script and style elements
    $(
      'script, style, noscript, iframe, header, footer, nav, aside, form, [aria-hidden="true"], .noprint',
    ).remove();
    // Get text from the body, attempt to normalize whitespace
    let text = $('body').text() || '';
    text = text.replace(/\s\s+/g, ' ').trim();
    return text;
  } catch (error) {
    logger.error(`Error extracting text with Cheerio: ${error.message}`);
    return ''; // Return empty string on error
  }
}

export function slugifyText(text: string): string {
  return slugify(text, { lower: true, trim: true });
}
