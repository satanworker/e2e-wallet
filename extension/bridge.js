(() => {
  'use strict';

  const REQUEST = 'e2e-wallet:request';
  const RESPONSE = 'e2e-wallet:response';

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.type !== REQUEST) return;
    const { id, payload } = event.data;
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) {
        window.postMessage({
          type: RESPONSE,
          id,
          response: {
            ok: false,
            error: { code: 4900, message: chrome.runtime.lastError.message },
          },
        }, '*');
        return;
      }
      window.postMessage({ type: RESPONSE, id, response }, '*');
    });
  });
})();
