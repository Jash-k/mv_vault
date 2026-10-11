import * as cheerio from 'cheerio';

// Pure parser shared by the walker and the metadata worker. 'Language: Tamil'
// describes the available audio track, NEVER the work's original language.
export function parseSourceMetadata(html, sourceUrl, fetchedAt = new Date().toISOString()) {
  const $ = cheerio.load(String(html || ''));
  const fields = {};
  $('li > strong').each((_, el) => {
    const key = $(el).text().replace(/:\s*$/, '').toLowerCase().trim();
    const value = $(el).parent().children('span').first().text().trim();
    if (key && value) fields[key] = value;
  });
  const heading = fields.movie || $('h1').first().text() || $('title').text();
  const split = s => [...new Set(String(s || '').split(/,|\s+and\s+/).map(s => s.trim())
    .filter(s => s && !/^(n\/?a|unknown|none|not available)$/i.test(s)))];
  return { available: Boolean(heading?.trim()), sourceUrl, fetchedAt,
    sourceTitle: String(heading || '').trim(),
    sourceYear: Number(String(heading || '').match(/\((19\d{2}|20\d{2})\)/)?.[1] || 0),
    directors: split(fields.director), cast: split(fields.starring || fields.actors || fields.stars).slice(0, 8) };
}
