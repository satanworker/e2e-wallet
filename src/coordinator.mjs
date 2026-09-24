import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  isAddress,
  keccak256,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

export const EXTENSION_ID = 'cmbjeccmjanmbnongoeapdnhhfdpnkjb';
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;

const DEFAULT_CHAIN_ID = 42161;
const DEFAULT_STATE = Object.freeze({
  wallet: 'default',
  chainId: DEFAULT_CHAIN_ID,
  connected: true,
  authorized: true,
});

const builtInChains = [
  defineChain({
    id: 1,
    name: 'Ethereum',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [process.env.TEST_WALLET_ETHEREUM_RPC || 'https://ethereum-rpc.publicnode.com'] } },
    blockExplorers: { default: { name: 'Etherscan', url: 'https://etherscan.io' } },
  }),
  defineChain({
    id: 42161,
    name: 'Arbitrum One',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [process.env.TEST_WALLET_ARBITRUM_RPC || 'https://arb1.arbitrum.io/rpc'] } },
    blockExplorers: { default: { name: 'Arbiscan', url: 'https://arbiscan.io' } },
  }),
  defineChain({
    id: 999,
    name: 'HyperEVM',
    nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
    rpcUrls: { default: { http: [process.env.TEST_WALLET_HYPEREVM_RPC || 'https://rpc.hyperliquid.xyz/evm'] } },
    blockExplorers: { default: { name: 'HyperEVM Scan', url: 'https://hyperevmscan.io' } },
  }),
];

class ProviderError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

class RpcResponseError extends Error {
  constructor(error) {
    super(error?.message || 'RPC request failed');
    this.code = error?.code ?? -32603;
    this.data = error?.data;
  }
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const hexChainId = (chainId) => `0x${chainId.toString(16)}`;
const quantity = (value) => value === undefined || value === null ? undefined : BigInt(value);
const normalizeWalletName = (name) => {
  if (typeof name !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
    throw new ProviderError(-32602, 'Wallet names may contain only letters, numbers, dot, underscore, and dash.');
  }
  return name;
};
const normalizePrivateKey = (privateKey) => {
  if (typeof privateKey !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new ProviderError(-32602, 'Private key must be 32 bytes encoded as 0x-prefixed hex.');
  }
  return privateKey;
};
function parsePrivateKeys(value) {
  if (value === undefined) return [];
  let privateKeys;
  try {
    privateKeys = JSON.parse(value);
  } catch {
    throw new Error('E2E_KEYS must be a JSON array of private keys.');
  }
  if (!Array.isArray(privateKeys)) throw new Error('E2E_KEYS must be a JSON array of private keys.');
  return privateKeys.map(normalizePrivateKey);
}




function normalizeTransactionType(value) {
  if (value === undefined) return undefined;
  return ({
    '0x0': 'legacy',
    '0x1': 'eip2930',
    '0x2': 'eip1559',
    '0x3': 'eip4844',
    '0x4': 'eip7702',
  })[value] || value;
}

function providerError(error) {
  return {
    code: Number.isInteger(error?.code) ? error.code : -32603,
    message: error?.message || String(error),
    ...(error?.data === undefined ? {} : { data: error.data }),
  };
}

export class WalletService {
  constructor({ stateDir, chains = builtInChains, privateKeys = [] }) {
    this.stateDir = stateDir;
    this.walletDir = join(stateDir, 'wallets');
    this.accounts = new Map();
    privateKeys.map(privateKeyToAccount).forEach((account, index) => {
      this.accounts.set(account.address.toLowerCase(), account);
      if (index === 0) this.accounts.set('default', account);
    });
    this.chains = new Map(chains.map((chain) => [chain.id, chain]));
    this.clients = new Map();
    this.contexts = new Map();
    this.lanes = new Map();
    this.rpcId = 0;
    this.database = new DatabaseSync(join(stateDir, 'transactions.sqlite'));
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS transactions (
        chain_id INTEGER NOT NULL,
        address TEXT NOT NULL,
        nonce INTEGER NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        raw_transaction TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (chain_id, address, nonce)
      );
    `);
  }

  static async create(options = {}) {
    const stateDir = options.stateDir
      || process.env.TEST_WALLET_STATE_DIR
      || join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'e2e-wallet');
    const privateKeys = options.privateKeys ?? parsePrivateKeys(process.env.E2E_KEYS);
    await mkdir(join(stateDir, 'wallets'), { recursive: true, mode: 0o700 });
    await chmod(stateDir, 0o700);
    return new WalletService({ ...options, privateKeys, stateDir });
  }

  async close() {
    this.database.close();
  }

  async ensureWallet(rawName) {
    const name = normalizeWalletName(rawName);
    const configuredAccount = this.accounts.get(name) || this.accounts.get(name.toLowerCase());
    if (configuredAccount) return configuredAccount;

    const path = join(this.walletDir, name);
    let privateKey;
    try {
      privateKey = (await readFile(path, 'utf8')).trim();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      privateKey = generatePrivateKey();
      try {
        await writeFile(path, `${privateKey}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      } catch (writeError) {
        if (writeError.code !== 'EEXIST') throw writeError;
        privateKey = (await readFile(path, 'utf8')).trim();
      }
    }
    await chmod(path, 0o600);
    const account = privateKeyToAccount(privateKey);
    this.accounts.set(name, account);
    return account;
  }
  async addWallet(rawName, rawPrivateKey) {
    const name = normalizeWalletName(rawName);
    const privateKey = normalizePrivateKey(rawPrivateKey);
    const account = privateKeyToAccount(privateKey);
    const path = join(this.walletDir, name);
    try {
      await writeFile(path, `${privateKey}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    } catch (error) {
      if (error.code === 'EEXIST') throw new ProviderError(-32602, `Wallet ${name} already exists.`);
      throw error;
    }
    this.accounts.set(name, account);
    return { wallet: name, address: account.address };
  }


  context(contextId) {
    if (typeof contextId !== 'string' || contextId.length > 200) {
      throw new ProviderError(-32602, 'Invalid wallet context.');
    }
    if (!this.contexts.has(contextId)) this.contexts.set(contextId, { ...DEFAULT_STATE });
    return this.contexts.get(contextId);
  }

  chain(chainId) {
    const chain = this.chains.get(Number(chainId));
    if (!chain) throw new ProviderError(4902, `Unknown chain ${chainId}.`);
    return chain;
  }

  publicClient(chainId) {
    const chain = this.chain(chainId);
    if (!this.clients.has(chain.id)) {
      this.clients.set(chain.id, createPublicClient({ chain, transport: http(chain.rpcUrls.default.http[0]) }));
    }
    return this.clients.get(chain.id);
  }

  async state(contextId) {
    const context = this.context(contextId);
    const account = await this.ensureWallet(context.wallet);
    return {
      ...context,
      address: account.address,
      chainIdHex: hexChainId(context.chainId),
    };
  }

  async setState(contextId, patch) {
    const context = this.context(contextId);
    const previous = await this.state(contextId);

    if (patch.wallet !== undefined) {
      context.wallet = normalizeWalletName(patch.wallet);
      await this.ensureWallet(context.wallet);
    }
    if (patch.chainId !== undefined) {
      context.chainId = Number(typeof patch.chainId === 'string' ? BigInt(patch.chainId) : patch.chainId);
      this.chain(context.chainId);
    }
    if (patch.connected !== undefined) context.connected = Boolean(patch.connected);
    if (patch.authorized !== undefined) context.authorized = Boolean(patch.authorized);

    const current = await this.state(contextId);
    const events = [];
    if (previous.chainId !== current.chainId) {
      events.push({ event: 'chainChanged', args: [current.chainIdHex] });
    }
    if (previous.address !== current.address || previous.authorized !== current.authorized) {
      events.push({ event: 'accountsChanged', args: [current.authorized ? [current.address] : []] });
    }
    if (previous.connected && !current.connected) {
      events.push({ event: 'disconnect', args: [{ code: 4900, message: 'Disconnected by test control.' }] });
    } else if (!previous.connected && current.connected) {
      events.push({ event: 'connect', args: [{ chainId: current.chainIdHex }] });
    }
    return { state: current, events };
  }

  async control(contextId, command, params = {}) {
    switch (command) {
      case 'getState':
        return { result: await this.state(contextId), events: [] };
      case 'setState': {
        const changed = await this.setState(contextId, params);
        return { result: changed.state, events: changed.events };
      }
      case 'changeWallet': {
        const changed = await this.setState(contextId, { wallet: params.wallet });
        return { result: changed.state, events: changed.events };
      }
      case 'changeChain': {
        const changed = await this.setState(contextId, { chainId: params.chainId });
        return { result: changed.state, events: changed.events };
      }
      case 'connect': {
        const changed = await this.setState(contextId, { connected: true, authorized: true });
        return { result: changed.state, events: changed.events };
      }
      case 'disconnect': {
        const changed = await this.setState(contextId, { connected: false });
        return { result: changed.state, events: changed.events };
      }
      case 'reset': {
        const changed = await this.setState(contextId, DEFAULT_STATE);
        return { result: changed.state, events: changed.events };
      }
      default:
        throw new ProviderError(-32601, `Unknown test wallet command: ${command}`);
    }
  }

  assertAvailable(context, method) {
    if (!context.connected) throw new ProviderError(4900, `Cannot call ${method}: wallet is disconnected.`);
  }

  async assertSigner(context, requestedAddress) {
    const account = await this.ensureWallet(context.wallet);
    if (!context.authorized) throw new ProviderError(4100, 'The account is not authorized for this tab.');
    if (requestedAddress && requestedAddress.toLowerCase() !== account.address.toLowerCase()) {
      throw new ProviderError(4100, `Wallet ${context.wallet} does not control ${requestedAddress}.`);
    }
    return account;
  }

  async request(contextId, method, params = []) {
    const context = this.context(contextId);
    if (!Array.isArray(params)) throw new ProviderError(-32602, 'JSON-RPC params must be an array.');

    switch (method) {
      case 'eth_accounts': {
        if (!context.connected || !context.authorized) return { result: [], events: [] };
        const account = await this.ensureWallet(context.wallet);
        return { result: [account.address], events: [] };
      }
      case 'eth_requestAccounts': {
        this.assertAvailable(context, method);
        const wasAuthorized = context.authorized;
        context.authorized = true;
        const account = await this.ensureWallet(context.wallet);
        return {
          result: [account.address],
          events: wasAuthorized ? [] : [{ event: 'accountsChanged', args: [[account.address]] }],
        };
      }
      case 'eth_chainId':
        this.assertAvailable(context, method);
        return { result: hexChainId(context.chainId), events: [] };
      case 'net_version':
        this.assertAvailable(context, method);
        return { result: String(context.chainId), events: [] };
      case 'wallet_switchEthereumChain': {
        this.assertAvailable(context, method);
        const chainId = Number(BigInt(params[0]?.chainId));
        const changed = await this.setState(contextId, { chainId });
        return { result: null, events: changed.events };
      }
      case 'wallet_addEthereumChain': {
        this.assertAvailable(context, method);
        const value = params[0] || {};
        const chainId = Number(BigInt(value.chainId));
        const rpcUrl = value.rpcUrls?.[0];
        if (!Number.isSafeInteger(chainId) || !/^https?:\/\//.test(rpcUrl || '')) {
          throw new ProviderError(-32602, 'A valid chainId and HTTP RPC URL are required.');
        }
        this.chains.set(chainId, defineChain({
          id: chainId,
          name: value.chainName || `Chain ${chainId}`,
          nativeCurrency: value.nativeCurrency || { name: 'Native token', symbol: 'ETH', decimals: 18 },
          rpcUrls: { default: { http: [rpcUrl] } },
          ...(value.blockExplorerUrls?.[0]
            ? { blockExplorers: { default: { name: 'Explorer', url: value.blockExplorerUrls[0] } } }
            : {}),
        }));
        this.clients.delete(chainId);
        return { result: null, events: [] };
      }
      case 'wallet_getPermissions':
        return {
          result: context.authorized ? [{ parentCapability: 'eth_accounts', caveats: [] }] : [],
          events: [],
        };
      case 'wallet_requestPermissions': {
        this.assertAvailable(context, method);
        const wasAuthorized = context.authorized;
        context.authorized = true;
        const account = await this.ensureWallet(context.wallet);
        return {
          result: [{ parentCapability: 'eth_accounts', caveats: [] }],
          events: wasAuthorized ? [] : [{ event: 'accountsChanged', args: [[account.address]] }],
        };
      }
      case 'wallet_revokePermissions': {
        const wasAuthorized = context.authorized;
        context.authorized = false;
        return {
          result: null,
          events: wasAuthorized ? [{ event: 'accountsChanged', args: [[]] }] : [],
        };
      }
      case 'personal_sign': {
        this.assertAvailable(context, method);
        const firstIsAddress = typeof params[0] === 'string' && isAddress(params[0]);
        const address = firstIsAddress ? params[0] : params[1];
        const message = firstIsAddress ? params[1] : params[0];
        const account = await this.assertSigner(context, address);
        return {
          result: await account.signMessage({
            message: typeof message === 'string' && /^0x[0-9a-f]*$/i.test(message)
              ? { raw: message }
              : String(message ?? ''),
          }),
          events: [],
        };
      }
      case 'eth_signTypedData_v3':
      case 'eth_signTypedData_v4': {
        this.assertAvailable(context, method);
        const firstIsAddress = typeof params[0] === 'string' && isAddress(params[0]);
        const address = firstIsAddress ? params[0] : params[1];
        const encoded = firstIsAddress ? params[1] : params[0];
        const typedData = typeof encoded === 'string' ? JSON.parse(encoded) : encoded;
        const account = await this.assertSigner(context, address);
        const types = { ...typedData.types };
        delete types.EIP712Domain;
        const domain = { ...typedData.domain };
        if (typeof domain.chainId === 'string') domain.chainId = Number(BigInt(domain.chainId));
        return {
          result: await account.signTypedData({
            domain,
            types,
            primaryType: typedData.primaryType,
            message: typedData.message,
          }),
          events: [],
        };
      }
      case 'eth_sign': {
        this.assertAvailable(context, method);
        const account = await this.assertSigner(context, params[0]);
        if (!/^0x[0-9a-f]{64}$/i.test(params[1] || '')) {
          throw new ProviderError(-32602, 'eth_sign requires a 32-byte hash.');
        }
        return { result: await account.sign({ hash: params[1] }), events: [] };
      }
      case 'eth_sendTransaction':
        this.assertAvailable(context, method);
        return { result: await this.sendTransaction(context, params[0] || {}), events: [] };
      case 'eth_signTransaction':
      case 'eth_sendRawTransaction':
      case 'wallet_sendCalls':
        throw new ProviderError(4200, `${method} bypasses the coordinated transaction queue.`);
      case 'wallet_watchAsset':
        return { result: true, events: [] };
      case 'wallet_getCapabilities':
        return { result: {}, events: [] };
      default:
        this.assertAvailable(context, method);
        return {
          result: await this.publicClient(context.chainId).request({ method, params }),
          events: [],
        };
    }
  }

  enqueue(key, task) {
    const previous = this.lanes.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    this.lanes.set(key, current);
    current.finally(() => {
      if (this.lanes.get(key) === current) this.lanes.delete(key);
    }).catch(() => {});
    return current;
  }

  async rpc(chain, method, params) {
    const response = await fetch(chain.rpcUrls.default.http[0], {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.rpcId, method, params }),
    });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.error) throw new RpcResponseError(payload.error);
    return payload.result;
  }

  async latestNonce(chain, address) {
    return Number(BigInt(await this.rpc(chain, 'eth_getTransactionCount', [address, 'latest'])));
  }

  async recoverSigned(chain, address) {
    const rows = this.database.prepare(`
      SELECT nonce, hash, raw_transaction
      FROM transactions
      WHERE chain_id = ? AND address = ? AND state = 'signed'
      ORDER BY nonce
    `).all(chain.id, address);

    for (const row of rows) {
      try {
        await this.rpc(chain, 'eth_sendRawTransaction', [row.raw_transaction]);
        this.database.prepare("UPDATE transactions SET state = 'accepted' WHERE hash = ?").run(row.hash);
      } catch (error) {
        if (error instanceof RpcResponseError && /already known|known transaction/i.test(error.message)) {
          this.database.prepare("UPDATE transactions SET state = 'accepted' WHERE hash = ?").run(row.hash);
          continue;
        }
        if (error instanceof RpcResponseError) {
          this.database.prepare("UPDATE transactions SET state = 'rejected' WHERE hash = ?").run(row.hash);
        }
        throw error;
      }
    }
  }

  async nextNonce(chain, address) {
    for (;;) {
      const latest = await this.latestNonce(chain, address);
      this.database.prepare(`
        UPDATE transactions SET state = 'confirmed'
        WHERE chain_id = ? AND address = ? AND nonce < ? AND state = 'accepted'
      `).run(chain.id, address, latest);
      const row = this.database.prepare(`
        SELECT MAX(nonce) AS nonce FROM transactions
        WHERE chain_id = ? AND address = ? AND state IN ('signed', 'accepted')
      `).get(chain.id, address);
      const next = Math.max(latest, row?.nonce === null || row?.nonce === undefined ? latest : Number(row.nonce) + 1);
      if (next - latest < 8) return next;
      await delay(1_000);
    }
  }

  async sendTransaction(context, transaction) {
    const account = await this.assertSigner(context, transaction.from);
    const chain = this.chain(context.chainId);
    if (transaction.chainId !== undefined && Number(BigInt(transaction.chainId)) !== chain.id) {
      throw new ProviderError(4901, `Transaction chain does not match active chain ${chain.id}.`);
    }
    const address = account.address.toLowerCase();
    const lane = `${chain.id}:${address}`;

    return this.enqueue(lane, async () => {
      await this.recoverSigned(chain, address);
      const nonce = await this.nextNonce(chain, address);
      if (transaction.nonce !== undefined && Number(BigInt(transaction.nonce)) !== nonce) {
        throw new ProviderError(-32602, `Explicit nonce ${transaction.nonce} does not match coordinated nonce ${nonce}.`);
      }

      const client = createWalletClient({ account, chain, transport: http(chain.rpcUrls.default.http[0]) });
      const request = await client.prepareTransactionRequest({
        account,
        chain,
        nonce,
        to: transaction.to || undefined,
        data: transaction.data ?? transaction.input,
        value: quantity(transaction.value),
        gas: quantity(transaction.gas ?? transaction.gasLimit),
        gasPrice: quantity(transaction.gasPrice),
        maxFeePerGas: quantity(transaction.maxFeePerGas),
        maxPriorityFeePerGas: quantity(transaction.maxPriorityFeePerGas),
        accessList: transaction.accessList,
        type: normalizeTransactionType(transaction.type),
      });
      const rawTransaction = await account.signTransaction(request);
      const hash = keccak256(rawTransaction);

      this.database.prepare(`
        DELETE FROM transactions
        WHERE chain_id = ? AND address = ? AND nonce = ? AND state = 'rejected'
      `).run(chain.id, address, nonce);
      this.database.prepare(`
        INSERT INTO transactions
          (chain_id, address, nonce, hash, raw_transaction, state, created_at)
        VALUES (?, ?, ?, ?, ?, 'signed', ?)
      `).run(chain.id, address, nonce, hash, rawTransaction, Date.now());

      try {
        const rpcHash = await this.rpc(chain, 'eth_sendRawTransaction', [rawTransaction]);
        if (rpcHash.toLowerCase() !== hash.toLowerCase()) {
          throw new Error(`RPC returned transaction hash ${rpcHash}, expected ${hash}.`);
        }
      } catch (error) {
        if (!(error instanceof RpcResponseError && /already known|known transaction/i.test(error.message))) {
          if (error instanceof RpcResponseError) {
            this.database.prepare("UPDATE transactions SET state = 'rejected' WHERE hash = ?").run(hash);
          }
          throw error;
        }
      }
      this.database.prepare("UPDATE transactions SET state = 'accepted' WHERE hash = ?").run(hash);
      return hash;
    });
  }
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_048_576) throw new ProviderError(-32600, 'Request body is too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function writeJson(response, status, body, origin) {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    ...(origin ? { 'access-control-allow-origin': origin } : {}),
  });
  response.end(JSON.stringify(body));
}

export async function createCoordinator(options = {}) {
  const service = await WalletService.create(options);
  const allowedOrigin = options.allowedOrigin ?? EXTENSION_ORIGIN;
  await service.ensureWallet('default');

  const server = createServer(async (request, response) => {
    const origin = request.headers.origin;
    if (origin && origin !== allowedOrigin) {
      writeJson(response, 403, { ok: false, error: { code: 4100, message: 'Origin is not authorized.' } });
      return;
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-origin': origin || allowedOrigin,
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
      });
      response.end();
      return;
    }

    try {
      if (request.method === 'GET' && request.url === '/health') {
        writeJson(response, 200, {
          ok: true,
          state: await service.state('health'),
        }, origin);
        return;
      }
      if (request.method === 'POST' && request.url === '/wallets') {
        if (origin) throw new ProviderError(4100, 'Wallet imports are allowed only from local tools.');
        const body = await readJson(request);
        writeJson(response, 200, {
          ok: true,
          result: await service.addWallet(body.name, body.privateKey),
        });
        return;
      }

      if (request.method !== 'POST' || request.url !== '/request') {
        writeJson(response, 404, { ok: false, error: { code: -32601, message: 'Not found.' } }, origin);
        return;
      }
      const body = await readJson(request);
      const responseBody = body.kind === 'control'
        ? await service.control(body.contextId, body.command, body.params)
        : await service.request(body.contextId, body.method, body.params);
      writeJson(response, 200, {
        ok: true,
        ...responseBody,
        state: await service.state(body.contextId),
      }, origin);
    } catch (error) {
      writeJson(response, 200, { ok: false, error: providerError(error) }, origin);
    }
  });

  return {
    service,
    server,
    async listen(port = Number(process.env.TEST_WALLET_PORT || 8547), host = '127.0.0.1') {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      return server.address();
    },
    async close() {
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      await service.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'import') {
    let privateKey = '';
    for await (const chunk of process.stdin) privateKey += chunk;
    const response = await fetch(`http://127.0.0.1:${process.env.TEST_WALLET_PORT || 8547}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: process.argv[3], privateKey: privateKey.trim() }),
    });
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.error.message);
    console.log(`${payload.result.wallet} ${payload.result.address}`);
  } else {
    const coordinator = await createCoordinator();
    const address = await coordinator.listen();
    const wallet = await coordinator.service.state('startup');
    console.log(`E2E wallet ${wallet.address} listening on http://${address.address}:${address.port}`);
  }
}
