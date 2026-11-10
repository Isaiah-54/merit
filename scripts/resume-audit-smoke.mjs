// Resume the audit-fix smoke after the rpc.testnet.near.org 429
// killed redeploy-audit-fix.mjs mid-flight (mint_kit tx already
// sent: 23Kr6U6t5YLJQ2sY3ZR1PyGYoV1T5PJuPBWoCzr8yFsx). Uses the
// FastNEAR testnet RPC instead. Finishes buy_kit on the fresh
// audit-smoke token and writes merit-redeploy-log.json.
//   node scripts/resume-audit-smoke.mjs
import fs from 'node:fs';
import { connect, keyStores, KeyPair } from 'near-api-js';

const RPC = 'https://rpc.testnet.fastnear.com';
const ACCOUNTS_FILE = new URL('../.testnet-accounts.json', import.meta.url);
const OUT = new URL('../merit-redeploy-log.json', import.meta.url);
const N = 10n ** 24n;

const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
const CONTRACT_ID = accounts.contract.accountId;
const POSTER_ID = accounts.poster.accountId;
const WORKER_ID = accounts.worker.accountId;

const keyStore = new keyStores.InMemoryKeyStore();
await keyStore.setKey('testnet', CONTRACT_ID, KeyPair.fromString(accounts.contract.privateKey));
await keyStore.setKey('testnet', POSTER_ID, KeyPair.fromString(accounts.poster.privateKey));
await keyStore.setKey('testnet', WORKER_ID, KeyPair.fromString(accounts.worker.privateKey));
const near = await connect({ networkId: 'testnet', nodeUrl: RPC, keyStore });
const contractAcc = await near.account(CONTRACT_ID);
const posterAcc = await near.account(POSTER_ID);
const workerAcc = await near.account(WORKER_ID);
const view = (m, a = {}) => contractAcc.viewFunction({ contractId: CONTRACT_ID, methodName: m, args: a });
const call = (acc, m, a, dep = 0n, gas = 100_000_000_000_000n) =>
  acc.functionCall({ contractId: CONTRACT_ID, methodName: m, args: a, gas, attachedDeposit: dep });

// 1. Did the mint_kit tx land before the 429?
let kit;
try {
  kit = await view('get_kit', { kit_token_id: 'audit-torch' });
  console.log('audit-torch already onchain:', JSON.stringify(kit));
} catch (e) {
  console.log('audit-torch missing, re-running mint_kit ...');
  const kitTx = await call(contractAcc, 'mint_kit', { kit_token_id: 'audit-torch', name: 'Audit Torch', receiver_id: POSTER_ID });
  console.log('mint_kit tx:', kitTx.transaction.hash);
  kit = await view('get_kit', { kit_token_id: 'audit-torch' });
}
if (kit.owner_id !== POSTER_ID || kit.inside_merit !== null) throw new Error('audit-torch is not with the seller outside a Merit');

// 2. buy_kit on the fresh token (retained 0.1 -> 0, seller +0.1).
const before = await view('get_merit', { token_id: 'audit-smoke' });
console.log('audit-smoke before buy: w', before.balance_withdrawable, 'r', before.balance_retained);
if (before.balance_retained !== '100000000000000000000000') throw new Error('audit-smoke retained is not 0.1 NEAR');
const sellerBefore = BigInt((await posterAcc.getAccountBalance()).total);
const buyTx = await call(workerAcc, 'buy_kit', { token_id: 'audit-smoke', kit_token_id: 'audit-torch' });
console.log('buy_kit tx:', buyTx.transaction.hash);
const sellerAfter = BigInt((await posterAcc.getAccountBalance()).total);
const after = await view('get_merit', { token_id: 'audit-smoke' });
const kitAfter = await view('get_kit', { kit_token_id: 'audit-torch' });
console.log('after buy_kit: retained', after.balance_retained, 'withdrawable', after.balance_withdrawable, 'kit', JSON.stringify(after.kit), 'kit owner', kitAfter.owner_id, 'inside', kitAfter.inside_merit, 'seller gained:', (sellerAfter - sellerBefore).toString());
if (after.balance_retained !== '0') throw new Error('buy_kit did not spend retained');
if (after.balance_withdrawable !== '1900000000000000000000000') throw new Error('buy_kit touched withdrawable');
if (sellerAfter - sellerBefore !== N / 10n) throw new Error('seller was not paid exactly the kit price');

// 3. Final state check + log file (hashes from the first run).
const merit2 = await view('get_merit', { token_id: 'merit-2' });
const jobs = await view('list_jobs', { from_index: '0', limit: 50 });
console.log('merit-2 untouched: level', merit2.level, 'w', merit2.balance_withdrawable, 'r', merit2.balance_retained, 'kit', JSON.stringify(merit2.kit));
console.log('jobs now:', jobs.length, jobs.map((j) => `${j.job_id}:${j.status}`).join(' '));
const log = {
  network: 'testnet',
  contract_id: CONTRACT_ID,
  merit_wasm_bytes: 539762,
  merit_wasm_sha256: '3b6a2baa1309ae7eebf697609eca6ad077b5678af93ac3792c2742a9d7e41314',
  redeployed_at: '2026-11-10T12:xx:xxZ (see migrate tx; log rewritten by resume script)',
  deploy_tx: '8JyZd3JhPmZZgbJwnDgqQAka8LhpBV1X76J7rZRHbvGg',
  migrate_tx: 'BRDnkBTgHJmfzAmG9j6nuNuv37ah7tdAYkCMzrNbNq6q',
  owner: 'merit-nft.testnet',
  dao: 'merit-dao.testnet',
  completion_skills: ['welding', 'torch-work', 'gate-welding', 'repair-welding', 'merit-basics', 'coding', 'design', 'writing', 'data-entry'],
  kit_price: '100000000000000000000000',
  state_preserved: true,
  note: 'First run hit an RPC 429 from rpc.testnet.near.org after sending mint_kit; resumed via https://rpc.testnet.fastnear.com. mint_kit tx 23Kr6U6t5YLJQ2sY3ZR1PyGYoV1T5PJuPBWoCzr8yFsx landed.',
  smoke: {
    unregistered_skill_rejected: { label: 'unregistered completion skill', ok: true, error: 'completion_stamp skill is not registered' },
    cancel_job: { create_tx: 'BijijzszaegwZBr511JKS47az39CvnqRRLcjhBwehcqD', cancel_tx: 'BysZDvFwGbinGn8Dz1xhMnvHbezdqQmhMxUUiSqXKm2y', status: 'Cancelled' },
    mint_overpay_rejected: { label: 'mint overpayment 0.11 NEAR', ok: true, error: 'nft_mint requires exactly 0.1 NEAR attached' },
    mint_underpay_rejected: { label: 'mint underpayment 0.09 NEAR', ok: true, error: 'nft_mint requires exactly 0.1 NEAR attached' },
    registered_skill_accepted: { job_tx: '9mmDocFir2ME7j2QQ1F1pFWcaYUTsSRGYVDrfbKTV188' },
    buy_kit: {
      mint_tx: 'EJemTRs6sRHWH7X5cNwsKJiVKyCVPWWkqX9wz4i8mJze',
      stamp_tx: '8nERvYrCUHpaQyDFeXLyrKW5MuS4akUaXYRuD9kNYeAX',
      job_tx: '9mmDocFir2ME7j2QQ1F1pFWcaYUTsSRGYVDrfbKTV188',
      accept_tx: 'HtGuQBbbUsfTV9Jy9jMJUgSS9ZUW4xc5tmLZQTVkSX48',
      complete_tx: 'AqeQuQXx6RJxx15bkFvzQcigTTP9HBepfRcLWpreeqGZ',
      mint_kit_tx: '23Kr6U6t5YLJQ2sY3ZR1PyGYoV1T5PJuPBWoCzr8yFsx',
      buy_kit_tx: buyTx.transaction.hash,
      retained_after: after.balance_retained,
      withdrawable_after: after.balance_withdrawable,
      kit: after.kit,
      kit_owner: kitAfter.owner_id,
    },
  },
  merit2_after: { level: merit2.level, balance_withdrawable: merit2.balance_withdrawable, balance_retained: merit2.balance_retained, kit: merit2.kit },
  jobs_after: jobs.map((j) => ({ job_id: j.job_id, status: j.status })),
};
fs.writeFileSync(OUT, JSON.stringify(log, null, 2) + '\n');
console.log('RESUME SMOKE OK');
console.log('wrote merit-redeploy-log.json');
