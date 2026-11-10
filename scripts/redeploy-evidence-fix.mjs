// Redeploy the Merit contract over merit-nft.testnet after the
// submit_evidence fix (Accepted OR Disputed, was Disputed only),
// and migrate the live state in place (no wipe). Then verify the
// fix onchain with a real Accepted job. Run once:
//   node scripts/redeploy-evidence-fix.mjs
//
// Steps: deploy new wasm -> migrate() as the owner (contract
// account) -> verify tokens/jobs/registry intact -> evidence fix
// verification on a fresh test job (poster merit-poster.testnet,
// worker merit-worker.testnet with merit-1, which holds welding 1):
//   * create_job "evidence-fix-test" requiring welding 1, 0.01 NEAR
//   * accept_job with merit-1 (job becomes Accepted)
//   * submit_evidence as the worker on the Accepted job -> MUST SUCCEED
//   * submit_evidence on a Completed job -> MUST FAIL
// The test job is left Accepted (not completed) so merit-1's stamps
// and balance are untouched. Writes merit-evidence-fix-log.json
// (tx hashes + verified state; NO keys).
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { connect, keyStores, KeyPair } from 'near-api-js';

const RPC = 'https://rpc.testnet.fastnear.com';
const ACCOUNTS_FILE = new URL('../.testnet-accounts.json', import.meta.url);
const WASM_FILE = new URL('../target/near/merit/merit.wasm', import.meta.url);
const OUT = new URL('../merit-evidence-fix-log.json', import.meta.url);
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
if (merit2.level !== 8 || merit2.balance_withdrawable !== '2375000000000000000000000' || merit2.balance_retained !== '125000000000000000000000') {
  throw new Error('merit-2 state did not survive migrate');
}
if (log.tokens['merit-1'].level !== 2 || log.tokens['ai'].level !== 1 || log.tokens['merit-3'].level !== 0) {
  throw new Error('token levels did not survive migrate');
}
log.jobs_before = await view('list_jobs', { from_index: '0', limit: 50 });
console.log('jobs after migrate:', log.jobs_before.length, log.jobs_before.map((j) => `${j.job_id}:${j.status}`).join(' '));
const known = ['twowalletjob', 'codingjobone', 'audit-smoke-job', 'audit-evidence-ref'];
for (const id of known) {
  if (!log.jobs_before.some((j) => j.job_id === id)) throw new Error(`known job ${id} missing after migrate`);
}

// 4. Evidence fix verification on a fresh test job.
// A valid SHA-256 hex (64 hex chars) of the evidence text.
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
