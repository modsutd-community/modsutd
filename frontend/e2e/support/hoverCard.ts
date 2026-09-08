import { expect, type Locator } from '@playwright/test';

/**
 * Hover a hover-intent target until the thing it opens is actually there.
 *
 * The plan tree opens its card on a 300ms timer (`armOpen` in PlanTree.tsx)
 * and cancels that timer on pointerleave. A single `hover()` is therefore a
 * coin flip whenever anything re-renders under a stationary cursor inside
 * those 300ms: the element the pointer was over is replaced, pointerleave
 * cancels the pending open, and pointerenter never fires again because the
 * mouse has not moved. The card then never appears and the next line waits
 * for something that is not coming.
 *
 * Re-hovering with the assertion is the documented way to drive a hover-intent
 * UI, and it fails for the right reason: if the card genuinely never opens,
 * this still goes red.
 */
export async function hoverUntil(target: Locator, appears: Locator): Promise<void> {
  await expect(async () => {
    await target.hover();
    await expect(appears).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });

  // Then move the pointer into what appeared, the way a person does. Left
  // parked on the chip, the card is still held open only by the 320ms grace
  // timer, so any reflow under the cursor closes it before the next line runs
  // - and the failure lands on whatever that line was reaching for, which
  // makes it look like the card was never the problem.
  await appears.hover().catch(() => { /* not everything is hoverable */ });
}
