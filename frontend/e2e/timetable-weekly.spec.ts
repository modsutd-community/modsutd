import { test, expect } from '@playwright/test';

// SAMS refuses List View until enrolment is final but keeps rendering the
// Weekly Calendar View, so this paste path is the only one a student has in
// exactly the window they most want their timetable. The plain text of that
// grid is unparseable - the rowspans that say which day a class is on are
// gone - so the app reads text/html off the clipboard instead. This drives
// that for real: a paste event carrying both flavours, then the grid.

const KEY = 'modsutd.timetable.consent.v3';

const scope = (page: import('@playwright/test').Page, isMobile: boolean | undefined) =>
  isMobile ? page.locator('body') : page.locator('[data-panel="tt"]');

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

test.describe('timetable · weekly calendar view', () => {
  test.beforeEach(async ({ page, isMobile }) => {
    await page.goto('/timetable');
    await page.evaluate((k) => localStorage.setItem(k, 'yes'), KEY);
    // The weekly path spreads one pasted week across the term, which it can
    // only do once /data/term-calendar.json is in. Nobody can paste faster than
    // that fetch, but a starved worker can - and the panel then keeps the one
    // honest week and says the term is unknown, which reads as a parser bug.
    const calendar = page.waitForResponse(
      (r) => r.url().endsWith('/data/term-calendar.json') && r.ok(),
    );
    await page.reload();
    await calendar;
    await scope(page, isMobile).getByRole('button', { name: /generate timetable/i }).click();
  });

  test('a weekly-view paste parses, and lands on the right day', async ({ page, isMobile }) => {
    const box = scope(page, isMobile).locator('textarea');
    await expect(box).toBeVisible();

    // A real paste carries both flavours. Dispatch the event for the html, then
    // fill for the text the browser would have inserted.
    await box.evaluate((el, html) => {
      const dt = new DataTransfer();
      dt.setData('text/html', html);
      dt.setData('text/plain', 'ignored');
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
    }, WEEKLY_HTML);
    await box.fill(WEEKLY_TEXT);

    await scope(page, isMobile).getByRole('button', { name: /^parse/i }).click();

    await expect(page.locator('[data-act="tt-grid"]')).toBeVisible();
    // One week is close to useless for an export, so it is spread across the
    // published teaching weeks - and the note has to say so, because a student
    // is owed the difference between what SAMS showed and what we derived.
    await expect(page.locator('[data-act="weekly-note"]')).toContainText(/13 teaching weeks/i);
    // Wednesday, not Tuesday. This is the whole reason the html path exists.
    await expect(page.locator('[data-act="tt-grid"]')).toContainText('02.155');
  });

  // Both views are offered up front, because a student refused List View has
  // to see the alternative without having to fail a paste first.
  test('offers both views, and warns only where it applies', async ({ page, isMobile }) => {
    const sc = scope(page, isMobile);
    await expect(sc.locator('[data-act="view-list"]')).toBeChecked();
    // The regular-week warning is about the weekly grid, so it appears only
    // once that is the view being described.
    await expect(sc.locator('[data-act="steps-weekly"]')).toHaveCount(0);

    await sc.locator('[data-act="view-weekly"]').check();
    await expect(sc.locator('[data-act="steps-weekly"]')).toContainText(/regular week/i);
  });

  // The panel scrolls and is its own stacking context, so a bubble rendered
  // inside it is cropped at the panel edge whatever its z-index - overflow
  // clips before z-index is consulted. It is portalled onto <body> instead.
  test('says why list view may be missing, in a tip nothing can clip', async ({ page, isMobile }) => {
    // Located by hook, never by its label - that line has been reworded twice.
    const why = scope(page, isMobile).locator('[data-act="listview-tip"]');
    await expect(why).toBeVisible();
    await expect(page.getByRole('tooltip')).toHaveCount(0);

    // Stacked under "Recommended!", not under the option to its left. Compared
    // against where that word actually starts, since the note carries its own
    // left padding to clear the radio.
    const note = scope(page, isMobile).getByText('Recommended!');
    const noteBox = (await note.boundingBox())!;
    const pad = await note.evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
    const tipBox = (await why.boundingBox())!;
    expect(Math.abs(tipBox.x - (noteBox.x + pad))).toBeLessThan(2);
    // Directly under it, one pixel apart. The row gap on the option was 5px
    // and read as a paragraph break between two halves of the same thought.
    const gap = tipBox.y - (noteBox.y + noteBox.height);
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThanOrEqual(1.5);

    await why.locator('button').click();
    const tip = page.getByRole('tooltip');
    await expect(tip).toContainText(/HASS electives are confirmed/i);

    // On <body>, not inside the panel: an ancestor with overflow is exactly
    // what used to crop it.
    expect(await tip.evaluate((el) => el.parentElement?.tagName)).toBe('BODY');

    // And wholly on screen. A tip half off the right edge is the same bug
    // wearing a different hat.
    const box = (await tip.boundingBox())!;
    const view = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(view.width);
  });

  // Filling the box sets no clipboard, so this is the plain-text case: the
  // weekly page is on screen and the grid still cannot be read. The error has
  // to name the copy, not the view. Sending this reader to List View is advice
  // they often cannot take, since no access to it is why they are here.
  test('a plain-text weekly copy is blamed on the clipboard, not on List View', async ({
    page,
    isMobile,
  }) => {
    const box = scope(page, isMobile).locator('textarea');
    await box.fill(WEEKLY_TEXT);
    await scope(page, isMobile).getByRole('button', { name: /^parse/i }).click();
    await expect(page.locator('[data-act="weekly-plain-text"]')).toBeVisible();
  });

  // The other half of the split: text that is neither view keeps the message
  // that explains both, so a genuinely wrong paste is not told to re-copy.
  test('text that is neither view says so', async ({ page, isMobile }) => {
    const box = scope(page, isMobile).locator('textarea');
    await box.fill('hello, this is not a timetable at all');
    await scope(page, isMobile).getByRole('button', { name: /^parse/i }).click();
    await expect(page.locator('[data-act="not-a-timetable"]')).toBeVisible();
  });
});
