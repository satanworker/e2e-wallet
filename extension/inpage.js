(() => {
  'use strict';

  const REQUEST = 'e2e-wallet:request';
  const RESPONSE = 'e2e-wallet:response';
  const pending = new Map();
  const listeners = new Map();
  let sequence = 0;
  let state = {
    wallet: 'default',
    chainId: 42161,
    chainIdHex: '0xa4b1',
    connected: true,
    authorized: true,
    address: null,
  };

  class ProviderRpcError extends Error {
    constructor(error) {
      super(error?.message || 'Wallet request failed.');
      this.code = error?.code ?? -32603;
      if (error?.data !== undefined) this.data = error.data;
    }
  }

  function bridge(payload) {
    const id = `${Date.now()}:${++sequence}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      window.postMessage({ type: REQUEST, id, payload }, '*');
    });
  }

  function emit(event, ...args) {
    for (const listener of listeners.get(event) || []) {
      try {
        listener(...args);
      } catch (error) {
        queueMicrotask(() => { throw error; });
      }
    }
  }

  function applyResponse(response) {
    if (response.state) state = response.state;
    for (const item of response.events || []) emit(item.event, ...(item.args || []));
    provider.chainId = state.chainIdHex;
    provider.networkVersion = String(state.chainId);
    provider.selectedAddress = state.authorized ? state.address : null;
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.type !== RESPONSE) return;
    const callback = pending.get(event.data.id);
    if (!callback) return;
    pending.delete(event.data.id);
    const response = event.data.response || {};
    if (!response.ok) {
      callback.reject(new ProviderRpcError(response.error));
      return;
    }
    applyResponse(response);
    callback.resolve(response.result);
  });

  const provider = {
    isMetaMask: true,
    isRabby: true,
    chainId: state.chainIdHex,
    networkVersion: String(state.chainId),
    selectedAddress: null,
    _metamask: { isUnlocked: async () => true },
    request({ method, params = [] }) {
      if (typeof method !== 'string') return Promise.reject(new ProviderRpcError({ code: -32600, message: 'A method is required.' }));
      return bridge({ kind: 'provider', method, params });
    },
    on(event, listener) {
      if (typeof listener !== 'function') throw new TypeError('Listener must be a function.');
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(listener);
      return this;
    },
    removeListener(event, listener) {
      listeners.get(event)?.delete(listener);
      return this;
    },
    isConnected() {
      return Boolean(state.connected);
    },
    enable() {
      return this.request({ method: 'eth_requestAccounts' });
    },
    sendAsync(payload, callback) {
      this.request(payload).then(
        (result) => callback(null, { id: payload.id, jsonrpc: payload.jsonrpc || '2.0', result }),
        (error) => callback(error, { id: payload.id, jsonrpc: payload.jsonrpc || '2.0', error }),
      );
    },
    send(methodOrPayload, paramsOrCallback) {
      if (typeof methodOrPayload === 'string') {
        return this.request({ method: methodOrPayload, params: Array.isArray(paramsOrCallback) ? paramsOrCallback : [] });
      }
      if (typeof paramsOrCallback === 'function') return this.sendAsync(methodOrPayload, paramsOrCallback);
      return this.request(methodOrPayload);
    },
  };

  const control = Object.freeze({
    getState: () => bridge({ kind: 'control', command: 'getState' }),
    set: (patch) => bridge({ kind: 'control', command: 'setState', params: patch }),
    changeWallet: (wallet) => bridge({ kind: 'control', command: 'changeWallet', params: { wallet } }),
    changeChain: (chainId) => bridge({ kind: 'control', command: 'changeChain', params: { chainId } }),
    connect: () => bridge({ kind: 'control', command: 'connect' }),
    disconnect: () => bridge({ kind: 'control', command: 'disconnect' }),
    reset: () => bridge({ kind: 'control', command: 'reset' }),
  });

  try {
    Object.defineProperty(window, 'testWallet', { value: control, configurable: false, writable: false });
    Object.defineProperty(window, 'ethereum', { value: provider, configurable: true, writable: true });
  } catch {
    window.testWallet = control;
    window.ethereum = provider;
  }

  const info = Object.freeze({
    uuid: crypto.randomUUID(),
    name: 'E2E Wallet',
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%232563eb'/%3E%3Cpath d='M17 21h30v24H17z' fill='white'/%3E%3Ccircle cx='42' cy='33' r='4' fill='%232563eb'/%3E%3C/svg%3E",
    rdns: 'io.rabby',
  });
  const detail = Object.freeze({ info, provider });
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();

  control.getState().then((current) => {
    state = current;
    applyResponse({ state, events: [] });
    emit('connect', { chainId: state.chainIdHex });
  }).catch(() => emit('disconnect', new ProviderRpcError({ code: 4900, message: 'Wallet coordinator is unavailable.' })));
})();
