import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  keccak256,
  parseTransaction,
  recoverMessageAddress,
  recoverTypedDataAddress,
} from 'viem';
import { createCoordinator, EXTENSION_ORIGIN } from '../src/coordinator.mjs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';


async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address();
}

async function close(server) {
  if (server.listening) await new Promise((resolve) => server.close(resolve));
}

function fakeRpc() {
  const rawTransactions = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    let result;
    if (body.method === 'eth_getTransactionCount') {
      result = '0x0';
    } else if (body.method === 'eth_sendRawTransaction') {
      rawTransactions.push(body.params[0]);
      result = keccak256(body.params[0]);
    } else {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: body.method } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  });
  return { server, rawTransactions };
}

async function walletRequest(port, body) {
  const response = await fetch(`http://127.0.0.1:${port}/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: EXTENSION_ORIGIN },
    body: JSON.stringify({ contextId: 'browser:tab', ...body }),
  });
  const payload = await response.json();
  if (!payload.ok) throw Object.assign(new Error(payload.error.message), payload.error);
  return payload;
}

const privateKeys = [
  `0x${'01'.repeat(32)}`,
  `0x${'02'.repeat(32)}`,
];
const configuredAccounts = privateKeys.map((key) => privateKeyToAccount(key).address);

test('injected-wallet backend signs and serializes concurrent transactions', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'e2e-wallet-'));
  const rpc = fakeRpc();
  const rpcAddress = await listen(rpc.server);
  const previousKeys = process.env.E2E_KEYS;
  process.env.E2E_KEYS = JSON.stringify(privateKeys);
  const coordinator = await createCoordinator({ stateDir });
  const coordinatorAddress = await coordinator.listen(0);

  try {
    const port = coordinatorAddress.port;
    const rpcUrl = `http://127.0.0.1:${rpcAddress.port}`;
    await walletRequest(port, {
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: '0x7a69',
        chainName: 'Smoke Chain',
        nativeCurrency: { name: 'Test Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: [rpcUrl],
      }],
    });
    await walletRequest(port, {
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x7a69' }],
    });

    const accounts = await walletRequest(port, { method: 'eth_requestAccounts', params: [] });
    const address = accounts.result[0];
    assert.equal(address, configuredAccounts[0]);
    const message = '0x68656c6c6f';
    const signedMessage = await walletRequest(port, {
      method: 'personal_sign',
      params: [message, address],
    });
    assert.equal(
      (await recoverMessageAddress({ message: { raw: message }, signature: signedMessage.result })).toLowerCase(),
      address.toLowerCase(),
    );

    const typedData = {
      domain: { name: 'E2E Wallet', version: '1', chainId: 31337 },
      types: { Note: [{ name: 'contents', type: 'string' }] },
      primaryType: 'Note',
      message: { contents: 'enable trading' },
    };
    const signedTypedData = await walletRequest(port, {
      method: 'eth_signTypedData_v4',
      params: [address, JSON.stringify(typedData)],
    });
    assert.equal(
      (await recoverTypedDataAddress({ ...typedData, signature: signedTypedData.result })).toLowerCase(),
      address.toLowerCase(),
    );

    const transaction = {
      from: address,
      to: address,
      value: '0x0',
      gas: '0x5208',
      gasPrice: '0x1',
      type: '0x0',
    };
    const hashes = await Promise.all([
      walletRequest(port, { method: 'eth_sendTransaction', params: [transaction] }),
      walletRequest(port, { method: 'eth_sendTransaction', params: [transaction] }),
      walletRequest(port, { method: 'eth_sendTransaction', params: [transaction] }),
    ]);
    assert.equal(new Set(hashes.map(({ result }) => result)).size, 3);
    assert.deepEqual(
      rpc.rawTransactions.map((raw) => Number(parseTransaction(raw).nonce)).sort((a, b) => a - b),
      [0, 1, 2],
    );

    const importedPrivateKey = `0x${'01'.repeat(32)}`;
    const importedAccount = privateKeyToAccount(importedPrivateKey);
    const imported = await fetch(`http://127.0.0.1:${port}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'imported', privateKey: importedPrivateKey }),
    }).then((response) => response.json());
    assert.equal(imported.result.address, importedAccount.address);

    const blocked = await fetch(`http://127.0.0.1:${port}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: EXTENSION_ORIGIN },
      body: JSON.stringify({ name: 'blocked', privateKey: importedPrivateKey }),
    }).then((response) => response.json());
    assert.equal(blocked.error.code, 4100);

    const changed = await walletRequest(port, {
      contextId: 'browser:other-tab',
      kind: 'control',
      command: 'changeWallet',
      params: { wallet: 'imported' },
    });
    assert.equal(changed.result.address, importedAccount.address);
    const importedSignature = await walletRequest(port, {
      contextId: 'browser:other-tab',
      method: 'personal_sign',
      params: [message, importedAccount.address],
    });
    assert.equal(
      (await recoverMessageAddress({ message: { raw: message }, signature: importedSignature.result })).toLowerCase(),
      importedAccount.address.toLowerCase(),
    );

    const configured = await walletRequest(port, {
      contextId: 'browser:configured-wallet',
      kind: 'control',
      command: 'changeWallet',
      params: { wallet: configuredAccounts[1] },
    });
    assert.equal(configured.result.address, configuredAccounts[1]);
    assert.notEqual(configured.result.address, address);
    assert.equal((await walletRequest(port, {
      kind: 'control',
      command: 'getState',
    })).result.address, address);
  } finally {
    await coordinator.close();
    await close(rpc.server);
    await rm(stateDir, { recursive: true, force: true });
    if (previousKeys === undefined) delete process.env.E2E_KEYS;
    else process.env.E2E_KEYS = previousKeys;
  }
});

async function withCoordinator(keys, run) {
  const stateDir = await mkdtemp(join(tmpdir(), 'e2e-wallet-'));
  const previousKeys = process.env.E2E_KEYS;
  let coordinator;
  try {
    process.env.E2E_KEYS = JSON.stringify(keys);
    coordinator = await createCoordinator({ stateDir });
    const { port } = await coordinator.listen(0);
    await run({ port, stateDir });
  } finally {
    await coordinator?.close();
    await rm(stateDir, { recursive: true, force: true });
    if (previousKeys === undefined) delete process.env.E2E_KEYS;
    else process.env.E2E_KEYS = previousKeys;
  }
}

const control = (port, command, params) => walletRequest(port, { kind: 'control', command, params });
const importWallet = (port, name, privateKey) => fetch(`http://127.0.0.1:${port}/wallets`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name, privateKey }),
}).then((response) => response.json());

test('positions resolve and listWallets reports configured and stored wallets', async () => {
  const keys = [generatePrivateKey(), generatePrivateKey(), generatePrivateKey()];
  const addresses = keys.map((key) => privateKeyToAccount(key).address);
  const lower = addresses.map((address) => address.toLowerCase());

  await withCoordinator(keys, async ({ port, stateDir }) => {
    for (const [wallet, address] of [
      [0, addresses[0]],
      ['0', addresses[0]],
      ['default', addresses[0]],
      [lower[0], addresses[0]],
      [1, addresses[1]],
      [addresses[1], addresses[1]],
      ['2', addresses[2]],
    ]) {
      assert.equal((await control(port, 'changeWallet', { wallet })).result.address, address);
    }
    assert.equal((await control(port, 'getState')).result.wallet, '2');

    const stored = (await control(port, 'changeWallet', { wallet: 'stored-one' })).result.address;
    // A stray all-digit file must not shadow or imitate a position.
    await writeFile(join(stateDir, 'wallets', '1'), `${generatePrivateKey()}\n`);
    await writeFile(join(stateDir, 'wallets', '7'), `${generatePrivateKey()}\n`);
    await control(port, 'setState', { connected: false, authorized: false });
    const filesBefore = (await readdir(join(stateDir, 'wallets'))).sort();
    assert.deepEqual(filesBefore, ['1', '7', 'stored-one']);

    const listed = (await control(port, 'listWallets')).result;
    assert.deepEqual(listed, [
      { wallet: '0', address: addresses[0], source: 'configured', aliases: ['default', lower[0]], index: 0 },
      { wallet: '1', address: addresses[1], source: 'configured', aliases: [lower[1]], index: 1 },
      { wallet: '2', address: addresses[2], source: 'configured', aliases: [lower[2]], index: 2 },
      { wallet: 'stored-one', address: stored, source: 'stored', aliases: [] },
    ]);
    assert.ok(!JSON.stringify(listed).includes('privateKey'));
    for (const key of keys) assert.ok(!JSON.stringify(listed).includes(key.slice(2)));
    assert.equal((await control(port, 'changeWallet', { wallet: 1 })).result.address, addresses[1]);
    await control(port, 'changeWallet', { wallet: 'stored-one' });

    await assert.rejects(
      control(port, 'changeWallet', { wallet: 'typo', create: false }),
      { code: -32602, message: 'Unknown wallet typo.' },
    );
    for (const wallet of [5, '5', '7', '01']) {
      for (const create of [undefined, true, false]) {
        await assert.rejects(
          control(port, 'changeWallet', { wallet, create }),
          { code: -32602, message: `Unknown wallet ${wallet}. E2E_KEYS has 3 keys.` },
        );
      }
      await assert.rejects(control(port, 'setState', { wallet }), { code: -32602 });
    }
    for (const wallet of [-1, 1.5, null, {}]) {
      await assert.rejects(control(port, 'changeWallet', { wallet }), { code: -32602 });
    }
    assert.equal((await control(port, 'getState')).result.wallet, 'stored-one');

    for (const name of ['5', 5, '0']) {
      assert.deepEqual((await importWallet(port, name, generatePrivateKey())).error, {
        code: -32602,
        message: `Wallet name ${name} is reserved: all-digit names are positions in E2E_KEYS.`,
      });
    }
    assert.deepEqual((await readdir(join(stateDir, 'wallets'))).sort(), filesBefore);
  });
});

test('a single key reports the singular in the position error', async () => {
  await withCoordinator([generatePrivateKey()], async ({ port }) => {
    await assert.rejects(
      control(port, 'changeWallet', { wallet: 1 }),
      { code: -32602, message: 'Unknown wallet 1. E2E_KEYS has 1 key.' },
    );
  });
});
