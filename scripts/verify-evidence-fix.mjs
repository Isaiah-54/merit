// Verify the evidence fix is live on merit-nft.testnet after the
// wasm redeploy (deploy succeeded; migrate() was correctly skipped
// because the v2 migration flag is already set and this change does
// not alter the state shape). Run once:
//   node scripts/verify-evidence-fix.mjs
//
// Verifies state is intact, then on a fresh test job (poster
// merit-poster.testnet, worker merit-worker.testnet with merit-1):
//   * create_job "evidence-fix-test" requiring welding 1, 0.01 NEAR
//   * accept_job with merit-1 (job becomes Accepted)
//   * submit_evidence as the worker on the Accepted job -> MUST SUCCEED
//   * submit_evidence on a Completed job -> MUST FAIL
// The test job is left Accepted (merit-1 stamps/balance untouched).
// Writes merit-evidence-fix-log.json (tx hashes + verified state;
// NO keys).
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { connect, keyStores, KeyPair } from 'near-api-js';

const RPC = 'https://rpc.testnet.fastnear.com';
const ACCOUNTS_FILE = new URL('../.testnet-accounts.json', import.meta.url);
const OUT = new URL('../merit-evidence-fix-log.json', import.meta.url);
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

const log = { network: 'testnet', contract_id: CONTRACT_ID, verified_at: new Date().toISOString() };

// 1. Verify the preserved state (no migrate needed: state shape unchanged).
console.log('verifying preserved state ...');
log.owner = await view('get_owner');
log.dao = await view('get_dao');
log.wallet_info = await view('get_wallet_info');
log.completion_skills = await view('list_completion_skills');
log.kit_price = await view('kit_price');
console.log('owner:', log.owner, 'dao:', log.dao, 'skills:', JSON.stringify(log.completion_skills), 'kit_price:', log.kit_price);
if (log.owner !== CONTRACT_ID) throw new Error('owner mismatch');
if (log.dao !== 'merit-dao.testnet') throw new Error('dao mismatch');
if (log.completion_skills.length !== 9) throw new Error('registry seed mismatch');
log.tokens = {};
for (const t of ['merit-1', 'merit-2', 'merit-3', 'ai', 'crypto']) {
  const m = await view('get_merit', { token_id: t });
  log.tokens[t] = m;
  console.log(t, 'level', m.level, 'stamps', m.stamps.map((s) => `${s.skill}:${s.level}`).join(','), 'w', m.balance_withdrawable, 'r', m.balance_retained, 'locked', m.locked, 'kit', JSON.stringify(m.kit));
}
const merit2 = log.tokens['merit-2'];
if (merit2.level !== 8 || merit2.balance_withdrawable !== '2375000000000000000000000' || merit2.balance_retained !== '125000000000000000000000') {
  throw new Error('merit-2 state did not survive redeploy');
}
if (log.tokens['merit-1'].level !== 2 || log.tokens['ai'].level !== 1 || log.tokens['merit-3'].level !== 0) {
  throw new Error('token levels did not survive redeploy');
}
log.jobs_before = await view('list_jobs', { from_index: '0', limit: 50 });
console.log('jobs after redeploy:', log.jobs_before.length, log.jobs_before.map((j) => `${j.job_id}:${j.status}`).join(' '));
const known = ['twowalletjob', 'codingjobone', 'audit-smoke-job', 'audit-evidence-ref'];
for (const id of known) {
  if (!log.jobs_before.some((j) => j.job_id === id)) throw new Error(`known job ${id} missing after redeploy`);
}

// 2. Evidence fix verification on a fresh test job.
const evidenceHash = createHash('sha256').update('evidence-fix-test: gate welded, beads continuous', 'utf8').digest('hex');
const jobId = 'evidence-fix-test';
console.log('creating test job', jobId, '...');
const createTx = await call(posterAcc, 'create_job', {
  job_id: jobId, title: 'Evidence fix test', description: 'Test that submit_evidence works on an Accepted job.',
  required_stamps: [{ skill: 'welding', min_level: 1 }],
  completion_stamp: { skill: 'welding', level: 1 },
  criteria: 'Weld it clean and strong.', timeout_ns: null,
}, 10n ** 22n); // 0.01 NEAR escrow
console.log('  create tx:', createTx.transaction.hash);
log.evidence_test = { job_id: jobId, create_tx: createTx.transaction.hash };

console.log('worker accepts with merit-1 ...');
const acceptTx = await call(workerAcc, 'accept_job', { job_id: jobId, token_id: 'merit-1' });
console.log('  accept tx:', acceptTx.transaction.hash);
log.evidence_test.accept_tx = acceptTx.transaction.hash;
let job = await view('get_job', { job_id: jobId });
if (job.status !== 'Accepted') throw new Error(`test job status ${job.status} != Accepted after accept`);
console.log('  job status:', job.status);

console.log('worker submits evidence on the ACCEPTED job (must succeed after the fix) ...');
const evTx = await call(workerAcc, 'submit_evidence', {
  job_id: jobId, evidence_hash: evidenceHash, evidence_ref: 'https://example.com/evidence-fix-test.txt',
});
console.log('  submit_evidence tx:', evTx.transaction.hash);
log.evidence_test.submit_evidence_tx = evTx.transaction.hash;
job = await view('get_job', { job_id: jobId });
if (job.worker_evidence !== evidenceHash) throw new Error('worker_evidence not recorded after submit_evidence');
if (job.worker_evidence_ref !== 'https://example.com/evidence-fix-test.txt') throw new Error('worker_evidence_ref not recorded');
console.log('  worker_evidence recorded:', job.worker_evidence, 'ref:', job.worker_evidence_ref);
log.evidence_test.worker_evidence = job.worker_evidence;
log.evidence_test.worker_evidence_ref = job.worker_evidence_ref;
log.evidence_test.job_status_after_evidence = job.status;

console.log('negative check: submit_evidence on a Completed job must still fail ...');
log.evidence_test.completed_job_rejected = await expectFail(
  'submit_evidence on Completed job twowalletjob',
  call(workerAcc, 'submit_evidence', { job_id: 'twowalletjob', evidence_hash: evidenceHash, evidence_ref: null }),
);
if (!log.evidence_test.completed_job_rejected.ok) throw new Error('submit_evidence on a Completed job unexpectedly succeeded');

console.log('evidence fix verified onchain. Test job left Accepted (merit-1 stamps/balance untouched).');
fs.writeFileSync(OUT, JSON.stringify(log, null, 2));
console.log('log written to', OUT.pathname);
