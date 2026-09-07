// Injected on SUTD pages and Microsoft Forms (which is what the term-end
// evaluations use). Watches for "your response was submitted" and floats a
// "share to modSUTD" button into the corner. Clicking it grabs the user's
// answers (where accessible) and opens modSUTD's /share page in a new tab
// with the text pre-filled.
//
// IMPORTANT: Microsoft Forms doesn't expose the user's submitted text on
// the thank-you page (by design - it's gone the moment you click submit).
// So we either:
//   (a) hook the FORM page BEFORE submit, capturing answers as the user
//       types them (stored locally, never sent anywhere), and offer them
//       on the thank-you page, OR
//   (b) just open the share page empty and let the user paste from memory
//       or from their email confirmation.
//
// v0.1 ships (b) - it's the safer privacy posture and the simpler code.
// v0.2 will add (a) gated behind an explicit per-form opt-in toggle.

const ORIGIN_DEFAULT = 'https://modsutd.tech';

async function getOrigin() {
  try {
    const stored = await chrome.storage.sync.get('origin');
    if (stored.origin) return stored.origin;
  } catch { /* fall through */ }
  return ORIGIN_DEFAULT;
}

function isSubmittedThankYouPage() {
  // Microsoft Forms confirmation text varies - check several heuristics.
  const text = (document.body.innerText || '').toLowerCase();
  if (text.includes('your response was submitted') ||
      text.includes('your response has been recorded') ||
      text.includes('thanks, your response has been submitted')) return true;
  return false;
}

function looksLikeSUTDEval() {
  const t = (document.title + ' ' + (document.body.innerText || '').slice(0, 4000)).toLowerCase();
  return t.includes('sutd') &&
    (t.includes('subject evaluation') || t.includes('module evaluation') ||
     t.includes('term evaluation') || t.includes('course evaluation'));
}

async function injectButton() {
  if (document.getElementById('modsutd-share-fab')) return;

  const origin = await getOrigin();
  const fab = document.createElement('a');
  fab.id = 'modsutd-share-fab';
  fab.href = `${origin}/share`;
  fab.target = '_blank';
  fab.rel = 'noopener noreferrer';
  fab.textContent = '🐙  share this review on modSUTD';
  document.body.appendChild(fab);
}

function shouldInject() {
  return isSubmittedThankYouPage() && looksLikeSUTDEval();
}

function check() {
  if (shouldInject()) injectButton();
}

// Forms is a SPA - submit doesn't reload, the thank-you message replaces
// the form in-place. Watch for DOM changes.
const obs = new MutationObserver(() => check());
obs.observe(document.body, { childList: true, subtree: true });
check();
