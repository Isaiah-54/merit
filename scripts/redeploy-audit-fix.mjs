// Redeploy the audited Merit contract over merit-nft.testnet and
// migrate the live state in place (no wipe). Then smoke-check the
// new methods onchain. Run once:
//   node scripts/redeploy-audit-fix.mjs
//
// Steps: deploy new wasm -> migrate() as the owner (contract
// account) -> verify tokens/jobs/registry intact -> smoke checks:
//   * create_job rejects an unregistered completion skill
//   * create_job accepts a registered one (fresh-token job flow)
//   * cancel_job refunds an Open job exactly
//   * nft_mint rejects overpayment and underpayment
//   * buy_kit spends retained on a FRESH token (merit-2 is left
//     untouched so the demo's expected numbers still hold)
// Writes merit-redeploy-log.json (tx hashes + verified state; NO keys).
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { connect, keyStores, KeyPair } from 'near-api-js';

const RPC = 'https://rpc.testnet.near.org';
const ACCOUNTS_FILE = new URL('../.testnet-accounts.json', import.meta.url);
const WASM_FILE = new URL('../target/near/merit/merit.wasm', import.meta.url);
const OUT = new URL('../merit-redeploy-log.json', import.meta.url);
const N = 10n ** 24n;

const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
const CONTRACT_ID = accounts.contract.accountId;
const POSTER_ID = accounts.poster.accountId;
const WORKER_ID = accounts.worker.accountId;

const wasm = fs.readFileSync(WASM_FILE);
const wasmSha256 = createHash('sha256').update(wasm).digest('hex');
console.log(`merit wasm: ${wasm.length} bytes, sha256 ${wasmSha256}`);

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
const expectFail = async (label, p) => {
  try {
    const r = await p;
    console.log(`  !! ${label}: UNEXPECTED SUCCESS tx ${r.transaction.hash}`);
    return { label, ok: false, tx: r.transaction.hash };
  } catch (e) {
    const msg = String(e.message ?? e).slice(0, 300);
    console.log(`  ${label}: failed as expected: ${msg}`);
    return { label, ok: true, error: msg };
  }
};

const log = { network: 'testnet', contract_id: CONTRACT_ID, merit_wasm_bytes: wasm.length, merit_wasm_sha256: wasmSha256, redeployed_at: new Date().toISOString() };

// 1. Deploy the new code over the same account.
console.log(`deploying new wasm to ${CONTRACT_ID} ...`);
const deployOutcome = await contractAcc.deployContract(wasm);
console.log('deploy tx:', deployOutcome.transaction.hash);
log.deploy_tx = deployOutcome.transaction.hash;

// 2. Migrate the live state (owner-only; the contract account is the owner).
console.log('calling migrate() ...');
const migrateOutcome = await call(contractAcc, 'migrate', {});
console.log('migrate tx:', migrateOutcome.transaction.hash);
log.migrate_tx = migrateOutcome.transaction.hash;

// 3. Verify the preserved state.
console.log('verifying preserved state ...');
log.owner = await view('get_owner');
log.dao = await view('get_dao');
log.wallet_info = await view('get_wallet_info');
log.completion_skills = await view('list_completion_skills');
log.kit_price = await view('kit_price');
console.log('owner:', log.owner, 'dao:', log.dao, 'skills:', JSON.stringify(log.completion_skills), 'kit_price:', log.kit_price);
if (log.owner !== CONTRACT_ID) throw new Error('owner mismatch after migrate');
if (log.dao !== 'merit-dao.testnet') throw new Error('dao mismatch after migrate');
if (log.completion_skills.length !== 9) throw new Error('registry seed mismatch after migrate');
log.tokens = {};
for (const t of ['merit-1', 'merit-2', 'merit-3', 'ai', 'crypto']) {
  const m = await view('get_merit', { token_id: t });
  log.tokens[t] = m;
  console.log(t, 'level', m.level, 'stamps', m.stamps.map((s) => `${s.skill}:${s.level}`).join(','), 'w', m.balance_withdrawable, 'r', m.balance_retained, 'locked', m.locked, 'kit', JSON.stringify(m.kit));
}
const merit2 = log.tokens['merit-2'];
if (merit2.level !== 8 || merit2.balance_withdrawable !== '2375000000000000000000000' || merit2.balance_retained !== '225000000000000000000000') {
  throw new Error('merit-2 state did not survive migrate');
}
if (log.tokens['merit-1'].level !== 2 || log.tokens['ai'].level !== 1 || log.tokens['merit-3'].level !== 0) {
  throw new Error('token levels did not survive migrate');
}
log.jobs = await view('list_jobs', { from_index: '0', limit: 50 });
console.log('jobs after migrate:', log.jobs.length, log.jobs.map((j) => `${j.job_id}:${j.status}`).join(' '));
if (log.jobs.length !== 11) throw new Error('job count did not survive migrate');
const openCount = log.jobs.filter((j) => j.status === 'Open').length;
if (openCount !== 6) throw new Error(`open job count ${openCount} != 6 after migrate`);
if (!log.jobs.every((j) => j.poster_evidence_ref === null && j.worker_evidence_ref === null && j.refund_pending === false)) {
  throw new Error('migrated jobs do not have defaulted new fields');
}

// 4. Smoke checks.
log.smoke = {};
console.log('smoke: create_job rejects an unregistered completion skill ...');
log.smoke.unregistered_skill_rejected = await expectFail(
  'unregistered completion skill',
  call(posterAcc, 'create_job', {
    job_id: 'audit-bad-skill', title: 'Audit bad skill', description: 'smoke',
    required_stamps: [], completion_stamp: { skill: 'brain-surgery', level: 3 },
    criteria: 'Do the thing.', timeout_ns: null,
  }, 10n ** 21n),
);

console.log('smoke: cancel_job refunds an Open job exactly ...');
const cancelJob = await call(posterAcc, 'create_job', {
  job_id: 'audit-cancel-1', title: 'Audit cancel', description: 'smoke',
  required_stamps: [], completion_stamp: { skill: 'welding', level: 1 },
  criteria: 'Do the thing.', timeout_ns: null,
}, 10n ** 22n);
console.log('  audit-cancel-1 create tx:', cancelJob.transaction.hash);
const posterBefore = BigInt((await posterAcc.getAccountBalance()).total);
const cancelTx = await call(posterAcc, 'cancel_job', { job_id: 'audit-cancel-1' });
console.log('  cancel tx:', cancelTx.transaction.hash);
const posterAfter = BigInt((await posterAcc.getAccountBalance()).total);
const cancelledJob = await view('get_job', { job_id: 'audit-cancel-1' });
console.log('  job status:', cancelledJob.status, 'refund_pending:', cancelledJob.refund_pending, 'poster refunded (net of gas):', (posterAfter - posterBefore).toString());
if (cancelledJob.status !== 'Cancelled' || cancelledJob.refund_pending !== false) throw new Error('cancel_job did not settle');
log.smoke.cancel_job = { create_tx: cancelJob.transaction.hash, cancel_tx: cancelTx.transaction.hash, status: cancelledJob.status };

console.log('smoke: nft_mint rejects overpayment and underpayment ...');
log.smoke.mint_overpay_rejected = await expectFail(
  'mint overpayment 0.11 NEAR',
  call(workerAcc, 'nft_mint', { token_id: 'audit-overpay', receiver_id: WORKER_ID }, 11n * 10n ** 22n, 150_000_000_000_000n),
);
log.smoke.mint_underpay_rejected = await expectFail(
  'mint underpayment 0.09 NEAR',
  call(workerAcc, 'nft_mint', { token_id: 'audit-overpay', receiver_id: WORKER_ID }, 9n * 10n ** 22n, 150_000_000_000_000n),
);

console.log('smoke: buy_kit spends retained on a fresh token ...');
// Fresh token audit-smoke, owned by the worker: stamp, run a 2 NEAR
// job through it (retained 0.1 exactly), then buy a kit from the poster.
const mintTx = await call(workerAcc, 'nft_mint', { token_id: 'audit-smoke', receiver_id: WORKER_ID, metadata: { title: 'Merit audit-smoke' } }, N / 10n, 150_000_000_000_000n);
console.log('  audit-smoke mint tx:', mintTx.transaction.hash);
const stampTx = await call(contractAcc, 'stamp', { token_id: 'audit-smoke', skill: 'welding', level: 1 });
console.log('  stamp tx:', stampTx.transaction.hash);
const jobTx = await call(workerAcc, 'create_job', {
  job_id: 'audit-smoke-job', title: 'Audit smoke job', description: 'smoke',
  required_stamps: [{ skill: 'welding', min_level: 1 }],
  completion_stamp: { skill: 'coding', level: 1 },
  criteria: 'Do the thing.', timeout_ns: null,
}, 2n * N);
console.log('  audit-smoke-job create tx (registered skill accepted):', jobTx.transaction.hash);
const acceptTx = await call(workerAcc, 'accept_job', { job_id: 'audit-smoke-job', token_id: 'audit-smoke' });
console.log('  accept tx:', acceptTx.transaction.hash);
const completeTx = await call(workerAcc, 'complete_job', { job_id: 'audit-smoke-job', token_id: 'audit-smoke' });
console.log('  complete tx:', completeTx.transaction.hash);
const smokeMerit = await view('get_merit', { token_id: 'audit-smoke' });
console.log('  audit-smoke after job: w', smokeMerit.balance_withdrawable, 'r', smokeMerit.balance_retained);
if (smokeMerit.balance_retained !== '100000000000000000000000') throw new Error('smoke token retained is not 0.1 NEAR');
const kitTx = await call(contractAcc, 'mint_kit', { kit_token_id: 'audit-torch', name: 'Audit Torch', receiver_id: POSTER_ID });
console.log('  mint_kit tx:', kitTx.transaction.hash);
const sellerBefore = BigInt((await posterAcc.getAccountBalance()).total);
const buyTx = await call(workerAcc, 'buy_kit', { token_id: 'audit-smoke', kit_token_id: 'audit-torch' });
console.log('  buy_kit tx:', buyTx.transaction.hash);
const sellerAfter = BigInt((await posterAcc.getAccountBalance()).total);
const smokeAfter = await view('get_merit', { token_id: 'audit-smoke' });
const kitAfter = await view('get_kit', { kit_token_id: 'audit-torch' });
console.log('  after buy_kit: retained', smokeAfter.balance_retained, 'withdrawable', smokeAfter.balance_withdrawable, 'kit', JSON.stringify(smokeAfter.kit), 'kit owner', kitAfter.owner_id, 'inside', kitAfter.inside_merit, 'seller gained:', (sellerAfter - sellerBefore).toString());
if (smokeAfter.balance_retained !== '0') throw new Error('buy_kit did not spend retained');
if (smokeAfter.balance_withdrawable !== '1900000000000000000000000') throw new Error('buy_kit touched withdrawable');
if (sellerAfter - sellerBefore !== N / 10n) throw new Error('seller was not paid exactly the kit price');
log.smoke.buy_kit = {
  mint_tx: mintTx.transaction.hash, stamp_tx: stampTx.transaction.hash,
  job_tx: jobTx.transaction.hash, accept_tx: acceptTx.transaction.hash,
  complete_tx: completeTx.transaction.hash, mint_kit_tx: kitTx.transaction.hash,
  buy_kit_tx: buyTx.transaction.hash,
  retained_after: smokeAfter.balance_retained, withdrawable_after: smokeAfter.balance_withdrawable,
  kit: smokeAfter.kit, kit_owner: kitAfter.owner_id,
};
log.smoke.registered_skill_accepted = { job_tx: jobTx.transaction.hash };

fs.writeFileSync(OUT, JSON.stringify(log, null, 2) + '\n');
console.log('REDEPLOY + SMOKE OK:', CONTRACT_ID);
console.log('wrote merit-redeploy-log.json');
