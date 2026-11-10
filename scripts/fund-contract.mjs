// One-off: fund merit-nft.testnet for the global wallet deploy.
// 6.5 NEAR from joseph-merit.testnet + 6.5 NEAR from merit-worker.testnet.
// The DAO cannot fund this: it hosts the 469,723-byte Sputnik code and
// must keep ~4.71 NEAR staked for storage (only ~5.29 NEAR spendable).
// Leaves Joseph ~3.5 NEAR (vote gas) and worker ~3.5 NEAR (mints).
import fs from 'node:fs';
import { connect, keyStores, KeyPair, utils } from 'near-api-js';
const RPC = 'https://rpc.testnet.near.org';
const accounts = JSON.parse(fs.readFileSync('/home/hatch/workspace/merit/.testnet-accounts.json', 'utf8'));
const N = 10n ** 24n;
async function accountFor(role) {
  const e = accounts[role];
  const ks = new keyStores.InMemoryKeyStore();
  await ks.setKey('testnet', e.accountId, KeyPair.fromString(e.privateKey));
  const near = await connect({ networkId: 'testnet', nodeUrl: RPC, keyStore: ks });
  return near.account(e.accountId);
}
const target = accounts.contract.accountId;
for (const [role, amount] of [['joseph', 65n * N / 10n], ['worker', 65n * N / 10n]]) {
  const sender = await accountFor(role);
  console.log(`sending ${Number(amount) / 1e24} NEAR from ${sender.accountId} to ${target} ...`);
  const out = await sender.sendMoney(target, amount);
  console.log(`  tx: ${out.transaction.hash}`);
}
console.log('FUND OK');
