import axios from 'axios';
import * as cheerio from 'cheerio';

/**
 * Scrapes clean text, title, meta description, and headings from a landing page URL
 * so ad creative and angle discovery agents stay strictly grounded in real page offers.
 */
export async function scrapeLandingPage(url) {
  const response = await axios.get(url, {
    timeout: 15000,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    }
  });

  const $ = cheerio.load(response.data);
  $('script, style, noscript, svg, iframe').remove();

  const title = ($('title').text() || '').replace(/\s+/g, ' ').trim();
  const metaDescription = ($('meta[name="description"]').attr('content') || '').replace(/\s+/g, ' ').trim();
  const h1 = $('h1')
    .map((_, el) => $(el).text().replace(/\s+/g, ' ').trim())
    .get()
    .filter(Boolean);
  const h2 = $('h2')
    .map((_, el) => $(el).text().replace(/\s+/g, ' ').trim())
    .get()
    .filter(Boolean)
    .slice(0, 12);

  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();

  return {
    url,
    title,
    metaDescription,
    h1,
    h2,
    headings: [...h1, ...h2],
    textContent: bodyText.slice(0, 8000)
  };
}
