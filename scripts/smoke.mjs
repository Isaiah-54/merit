// Live smoke test of the deployed Merit contract on testnet.
// Run after deploy.mjs:
//   node scripts/smoke.mjs
//
// Flow (poster + worker are the fresh demo accounts):
//   1. worker mints merit-1 (0.1 NEAR) — sub-account created
//   2. owner stamps welding 1 on merit-1 (whitelisted issuer)
//   3. poster posts a 1 NEAR job requiring welding 1
//   4. worker accepts; poster confirms completion
//   5. check: sub-account balance = 0.05 init + 1 NEAR payment;
//      get_merit shows 0.95 withdrawable / 0.05 retained and the
//      gate-welding completion stamp ("Job completion")
//   6. worker withdraws 0.95 NEAR from the sub-account wallet;
//      check: holder received ~0.95, sub-account keeps 0.05 + 0.05
// Writes merit-smoke-log.json (amounts + balances; NO keys).
//
// This proves the money path live. The dispute path is proven in
// the sandbox integration tests (real Sputnik DAO); a live dispute
// needs a second council vote from Isaiah or James54, which cannot
// be cast from here (only the Joseph stand-in key is held).
import fs from 'node:fs';
import { connect, keyStores, KeyPair, utils } from 'near-api-js';

const RPC = 'https://rpc.testnet.near.org';
const ACCOUNTS_FILE = new URL('../.testnet-accounts.json', import.meta.url);
const OUT = new URL('../merit-smoke-log.json', import.meta.url);
const N = 10n ** 24n;
const GAS = 100_000_000_000_000n;
const MINT_GAS = 150_000_000_000_000n;

const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
const CONTRACT_ID = accounts.contract.accountId;

async function accountFor(role) {
  const entry = accounts[role];
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey('testnet', entry.accountId, KeyPair.fromString(entry.privateKey));
  const near = await connect({ networkId: 'testnet', nodeUrl: RPC, keyStore });
  return near.account(entry.accountId);
}

async function view(contractId, method, args) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'merit-smoke', method: 'query',
      params: { request_type: 'call_function', finality: 'final', account_id: contractId, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') },
    }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`view ${method} failed: ${JSON.stringify(j.error)}`);
  return JSON.parse(Buffer.from(j.result.result).toString('utf8'));
}

async function balance(accountId) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'merit-smoke-bal', method: 'query',
      params: { request_type: 'view_account', finality: 'final', account_id: accountId },
    }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`balance ${accountId} failed: ${JSON.stringify(j.error)}`);
  return BigInt(j.result.amount);
}

const owner = await accountFor('contract');
const poster = await accountFor('poster');
const worker = await accountFor('worker');
const SUB = `merit-1.${CONTRACT_ID}`;

console.log('1. worker mints merit-1 ...');
const mintTx = await worker.functionCall({
  contractId: CONTRACT_ID, methodName: 'nft_mint',
  args: { token_id: 'merit-1', receiver_id: worker.accountId, metadata: { title: 'Merit merit-1' } },
  gas: MINT_GAS, attachedDeposit: N / 10n,
});
console.log('   mint tx:', mintTx.transaction.hash);
const subBalAfterMint = await balance(SUB);
console.log(`   sub-account ${SUB} balance: ${subBalAfterMint} yocto (${Number(subBalAfterMint) / 1e24} NEAR)`);

console.log('2. owner stamps welding 1 ...');
const stampTx = await owner.functionCall({
  contractId: CONTRACT_ID, methodName: 'stamp',
  args: { token_id: 'merit-1', skill: 'welding', level: 1 },
  gas: GAS, attachedDeposit: 0n,
});
console.log('   stamp tx:', stampTx.transaction.hash);

console.log('3. poster posts a 1 NEAR job ...');
const jobTx = await poster.functionCall({
  contractId: CONTRACT_ID, methodName: 'create_job',
  args: {
    job_id: 'smoke-weld-1', title: 'Smoke weld', description: 'Live smoke test job',
    required_stamps: [{ skill: 'welding', min_level: 1 }],
    completion_stamp: { skill: 'gate-welding', level: 1 },
    criteria: 'Weld the gate: continuous beads, no porosity, ground flush.',
  },
  gas: GAS, attachedDeposit: N,
});
console.log('   create_job tx:', jobTx.transaction.hash);

console.log('4. worker accepts; poster confirms ...');
const acceptTx = await worker.functionCall({
  contractId: CONTRACT_ID, methodName: 'accept_job',
  args: { job_id: 'smoke-weld-1', token_id: 'merit-1' },
  gas: GAS, attachedDeposit: 0n,
});
console.log('   accept tx:', acceptTx.transaction.hash);
const completeTx = await poster.functionCall({
  contractId: CONTRACT_ID, methodName: 'complete_job',
  args: { job_id: 'smoke-weld-1', token_id: 'merit-1' },
  gas: GAS, attachedDeposit: 0n,
});
console.log('   complete tx:', completeTx.transaction.hash);

const subBalAfterJob = await balance(SUB);
const merit = await view(CONTRACT_ID, 'get_merit', { token_id: 'merit-1' });
const job = await view(CONTRACT_ID, 'get_job', { job_id: 'smoke-weld-1' });
console.log(`5. sub-account balance: ${Number(subBalAfterJob) / 1e24} NEAR (expect 1.05)`);
console.log('   get_merit:', JSON.stringify(merit));
console.log('   job status:', job.status);
if (subBalAfterJob !== N / 20n + N) throw new Error(`sub-account balance wrong: ${subBalAfterJob}`);
if (merit.balance_withdrawable !== (95n * N / 100n).toString()) throw new Error('withdrawable wrong');
if (merit.balance_retained !== (5n * N / 100n).toString()) throw new Error('retained wrong');
if (job.status !== 'Completed') throw new Error('job not Completed');
const stamp = merit.stamps.find((s) => s.skill === 'gate-welding');
if (!stamp || stamp.issuer_name !== 'Job completion') throw new Error('completion stamp missing');

console.log('6. worker withdraws 0.95 NEAR from the sub-account ...');
const holderBefore = await balance(worker.accountId);
const withdrawTx = await worker.functionCall({
  contractId: CONTRACT_ID, methodName: 'withdraw',
  args: { token_id: 'merit-1', amount: (95n * N / 100n).toString() },
  gas: GAS, attachedDeposit: 0n,
});
console.log('   withdraw tx:', withdrawTx.transaction.hash);
const holderAfter = await balance(worker.accountId);
const subBalAfterWithdraw = await balance(SUB);
console.log(`   holder delta: ${Number(holderAfter - holderBefore) / 1e24} NEAR (expect ~0.95 minus gas)`);
console.log(`   sub-account after withdraw: ${Number(subBalAfterWithdraw) / 1e24} NEAR (expect 0.1)`);
if (subBalAfterWithdraw !== N / 20n + N / 20n) throw new Error(`sub-account after withdraw wrong: ${subBalAfterWithdraw}`);
if (holderAfter <= holderBefore + 94n * N / 100n) throw new Error('holder did not receive ~0.95 NEAR');

const log = {
  network: 'testnet',
  contract_id: CONTRACT_ID,
  token_id: 'merit-1',
  sub_account: SUB,
  mint_tx: mintTx.transaction.hash,
  stamp_tx: stampTx.transaction.hash,
  create_job_tx: jobTx.transaction.hash,
  accept_tx: acceptTx.transaction.hash,
  complete_tx: completeTx.transaction.hash,
  withdraw_tx: withdrawTx.transaction.hash,
  sub_balance_after_mint_yocto: subBalAfterMint.toString(),
  sub_balance_after_job_yocto: subBalAfterJob.toString(),
  sub_balance_after_withdraw_yocto: subBalAfterWithdraw.toString(),
  merit_after_job: merit,
  job_status: job.status,
  checked_at: new Date().toISOString(),
};
fs.writeFileSync(OUT, JSON.stringify(log, null, 2) + '\n');
console.log('SMOKE OK — money path proven live.');
console.log('wrote merit-smoke-log.json');
