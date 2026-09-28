# e2e-wallet

E2E browser wallet: a local coordinator (`src/coordinator.mjs`, HTTP on
`127.0.0.1:8547`) plus an MV3 extension (`extension/`) that injects
`window.ethereum` and the test control object `window.testWallet`.

```sh
npm ci
npm test        # node --test
npm run build   # dist/coordinator.mjs + dist/extension
nix build
```

## Wallets

- `E2E_KEYS`: JSON array of private keys ("configured" wallets). Every key is
  reachable by its zero-based position in the array (number or decimal string)
  and by its address. The first key is also `default`.
- Any other wallet name is a "stored" wallet: a key file under
  `<stateDir>/wallets/<name>`, imported with `e2e-wallet-import <name>` or
  generated on first use. Names use letters, numbers, `.`, `_`, `-` (up to 64
  characters) and must not be all digits: those are positions.

```sh
E2E_KEYS='["0x…", "0x…"]'
```

```js
await window.testWallet.changeWallet(1);   // second key; same as changeWallet('1')
await window.testWallet.changeWallet(5);
// rejects: { code: -32602, message: 'Unknown wallet 5. E2E_KEYS has 2 keys.' }
```

A position that does not exist always fails and never generates a wallet.

### Listing wallets

`listWallets` works in any tab, connected or not, never returns private keys
and never creates a wallet.

```js
await window.testWallet.listWallets();
// [
//   { wallet: '0', address: '0x1111…', source: 'configured', aliases: ['default', '0x1111…'], index: 0 },
//   { wallet: '1', address: '0x2222…', source: 'configured', aliases: ['0x2222…'], index: 1 },
//   { wallet: 'imported', address: '0x4444…', source: 'stored', aliases: [] },
// ]
```

### Refusing wallet creation

`changeWallet(name)` generates a key for an unknown (non-position) name. Pass
`{ create: false }` to fail instead:

```js
await window.testWallet.changeWallet('typo', { create: false });
// rejects: { code: -32602, message: 'Unknown wallet typo.' }
```
