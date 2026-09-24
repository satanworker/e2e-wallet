const COORDINATOR_URL = 'http://127.0.0.1:8547/request';

const instanceId = (async () => {
  const stored = await chrome.storage.local.get('instanceId');
  if (stored.instanceId) return stored.instanceId;
  const value = crypto.randomUUID();
  await chrome.storage.local.set({ instanceId: value });
  return value;
})();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    const tabId = sender.tab?.id;
    if (!Number.isInteger(tabId)) {
      throw Object.assign(new Error('Wallet requests must come from a browser tab.'), { code: 4100 });
    }
    const response = await fetch(COORDINATOR_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...message,
        contextId: `${await instanceId}:${tabId}`,
        pageOrigin: sender.origin || new URL(sender.url).origin,
      }),
    });
    if (!response.ok) throw new Error(`Wallet coordinator returned HTTP ${response.status}.`);
    return await response.json();
  })().then(sendResponse, (error) => sendResponse({
    ok: false,
    error: {
      code: Number.isInteger(error?.code) ? error.code : 4900,
      message: error?.message || String(error),
    },
  }));
  return true;
});
