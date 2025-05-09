import * as cheerio from 'cheerio';
import { Logger } from '@nestjs/common';

const logger = new Logger('TextUtils'); // Optional: if you want logging within these utils

export function extractTextFromHtml(htmlContent: string): string {
  try {
    const $ = cheerio.load(htmlContent);
    // Remove script and style elements
    $(
      'script, style, noscript, iframe, header, footer, nav, aside, form, [aria-hidden="true"], .noprint',
    ).remove();
    // Get text from the body, attempt to normalize whitespace
    let text = $('body').text() || '';
    text = text.replace(/\s\s+/g, ' ').trim(); // Replace multiple spaces/newlines with a single space
    return text;
  } catch (error) {
    logger.error(`Error extracting text with Cheerio: ${error.message}`);
    return ''; // Return empty string on error
  }
}

export function slugify(text: string): string {
  return text
    .toString()
    .normalize('NFKD') // Normalize accented characters
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-') // Replace spaces with -
    .replace(/[^\w-]+/g, '') // Remove all non-word chars
    .replace(/--+/g, '-'); // Replace multiple - with single -
}