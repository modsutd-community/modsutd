const DEFAULT_ORIGIN = 'https://modsutd.tech';

(async () => {
  const stored = await chrome.storage.sync.get('origin');
  const origin = stored.origin || DEFAULT_ORIGIN;
  document.getElementById('open').href = `${origin}/share`;

  document.getElementById('settings').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
})();
