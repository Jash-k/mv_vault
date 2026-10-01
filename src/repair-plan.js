/**
 * src/repair-plan.js — the decisions a repair makes, as pure functions.
 *
 * Kept separate from src/repair.js (which is a script that talks to the network)
 * so the rules can be unit-tested without I/O. If a repair ever needs to change
 * how it decides WHAT to fix, it changes here and test/repair.test.js proves it.
 */
import { slugify } from './http.js';
import { titleForEntry, isGenericLabel } from './titles.js';
import { inferPath } from './repair-paths.js';

/**
 * Records whose identity was parsed from a UI label instead of their page.
 *
 * The moviesda "latest updates" rail writes the literal text "Download Now" into
 * every link, so a run that trusted the label stored `id: "download-now"`,
 * `title: "Download Now"`, `year: 0` — and every subsequent item on that rail
 * collided with it. The path is the only honest source for these.
 *
 * Deliberately narrow: only records whose title is a known UI label AND which
 * carry no year at all. `Watch (2022)` is a real film with a real identity and
 * must never be touched, and a record with a usable year was almost certainly
 * parsed correctly from somewhere else.
 *
 * @returns {Array<{record, path, title, year, id, same, clash}>}
 */
export function planJunkRepairs(vault = []) {
  const rows = [];
  for (const record of vault) {
    if (!isGenericLabel(record?.title) || record.year) continue;
    const path = inferPath(record.pageUrl);
    const { title, year } = titleForEntry({ path });
    if (!title) continue; // nothing recoverable: leave it for a human
    const id = `${slugify(title)}${year ? `-${year}` : ''}`;
    rows.push({
      record,
      path,
      title,
      year,
      id,
      same: id === record.id && title === record.title && year === record.year,
      clash: vault.find((m) => m !== record && m.id === id) || null,
    });
  }
  return rows;
}
