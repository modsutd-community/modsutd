import type { Page } from '@playwright/test';

// The weekly grid fixture and the paste that delivers it, shared so the
// timetable spec and the telegram spec cannot drift apart on what a weekly
// paste is. A real paste carries both flavours; only text/html is parsed,
// because the plain text has lost the rowspans that put a class on its day.

const cell = (lines: string[]) => `<span>${lines.join('<br>')}</span>`;
const empty = '<td>&nbsp;</td>';

// Row 5 carries six <td> for eight columns: the Time column and Friday are
// still spoken for by rowspans above it. Counting cells puts this class on
// Tuesday; it is on Wednesday.
const WEEKLY_HTML = `<p>Week of 14/9/2026 - 20/9/2026</p>
<table id="WEEKLY_SCHED_HTMLAREA">
<tr><th>Time</th><th>Monday<br> 14 Sep</th><th>Tuesday<br> 15 Sep</th>
<th>Wednesday<br> 16 Sep</th><th>Thursday<br> 17 Sep</th><th>Friday<br> 18 Sep</th>
<th>Saturday<br> 19 Sep</th><th>Sunday<br> 20 Sep</th></tr>
<tr><td>8:00AM</td>${empty}${empty}${empty}${empty}
<td rowspan="5">${cell(['01 .400 - CC01', 'Capstone 1', 'Cohort Based Learning', '8:30AM - 11:30AM', 'ECC Building 1 1.411'])}</td>${empty}${empty}</tr>
<tr><td>9:00AM</td>${empty}${empty}${empty}${empty}${empty}${empty}</tr>
<tr><td rowspan="2">10:00AM</td>${empty}${empty}${empty}${empty}${empty}${empty}</tr>
<tr>${empty}${empty}<td rowspan="4">${cell(['02 .155 - L01', 'Design Thinking', 'Lecture', '10:30AM - 12:00PM', 'Lecture Theatre 2 2.401'])}</td>${empty}${empty}${empty}</tr>
<tr><td>11:00AM</td>${empty}${empty}${empty}${empty}${empty}</tr>
</table>`;

// What the same copy looks like as plain text - the flavour the old parser got,
// and which yields nothing.
const WEEKLY_TEXT = 'Week of 14/9/2026 - 20/9/2026\nTime\tMonday\tTuesday\n8:00AM\t\t';

export { WEEKLY_HTML, WEEKLY_TEXT };

export const CONSENT_KEY = 'modsutd.timetable.consent.v3';

/**
 * Get to a visible paste box: consent, then the term calendar the weekly
 * path needs to spread its one week, then the button that reveals the box.
 */
export async function openPasteBox(page: Page): Promise<void> {
  await page.goto('/timetable');
  await page.evaluate((k) => localStorage.setItem(k, 'yes'), CONSENT_KEY);
  const calendar = page.waitForResponse(
    (r) => r.url().endsWith('/data/term-calendar.json') && r.ok(),
  );
  await page.reload();
  await calendar;
  await page.getByRole('button', { name: /generate timetable/i }).first().click();
}

/** Paste the weekly grid into the timetable box and press parse. */
export async function pasteWeekly(page: Page): Promise<void> {
  const box = page.locator('textarea').first();
  await box.waitFor();
  await box.evaluate((el, html) => {
    const dt = new DataTransfer();
    dt.setData('text/html', html);
    dt.setData('text/plain', 'ignored');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  }, WEEKLY_HTML);
  await box.fill(WEEKLY_TEXT);
  await page.getByRole('button', { name: /^parse/i }).first().click();
}
