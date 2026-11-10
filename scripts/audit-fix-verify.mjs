// Audit-fix verification pass (demo + docs subagent, 2026-11-10).
// Exercises the new contract methods onchain against the redeployed
// merit-nft.testnet and records every transaction hash. Run once:
//   node scripts/audit-fix-verify.mjs
// Writes merit-audit-fix-log.json at the repo root. Uses only keys in
// .testnet-accounts.json (contract/owner, poster, worker). Never signs
// for clearsite587.testnet or james54.testnet. Creates NO DAO proposal
// and resolves NO dispute.
//
// Steps:
//   a. cancel_job on demo-refusal + demo-lend-expired (M-03), poster
//      refunds of 0.01 NEAR each.
//   b. mint_kit demo-hammer (as the contract account, the only
//      whitelisted issuer) to merit-poster.testnet, then buy_kit as
//      the holder of merit-2 (M-08): retained 0.225 -> 0.125 NEAR,
//      withdrawable untouched at 2.375 NEAR.
//   c. evidence_ref (M-06): fresh test job audit-evidence-ref, accept,
//      raise_dispute, submit_evidence with a real data: reference on
//      both sides, read the job back and confirm the refs are stored.
//      NOTE submit_evidence requires a Disputed job, so this check
//      needs a dispute; the test job is left Disputed on purpose and
//      its 0.01 NEAR escrow stays locked until a DAO refund proposal
//      resolves it (that vote is for Isaiah/James, not this script).
import fs from 'node:fs';
import {
  N, nearToYocto, yoctoToNear, sha256hex, loadConfig, loadAccounts,
  accountFor, rpcView, rpcBalance, call,
} from './demo-common.mjs';

const cfg = loadConfig();
const CONTRACT_ID = cfg.contract_id;
const TOKEN = cfg.token_id;
const SUB = `${TOKEN}.${CONTRACT_ID}`;
const accounts = loadAccounts(cfg);
const owner = await accountFor(accounts, cfg, 'contract');
const poster = await accountFor(accounts, cfg, 'poster');
const worker = await accountFor(accounts, cfg, 'worker');
const POSTER_ID = accounts.poster.accountId;
const WORKER_ID = accounts.worker.accountId;

const getMerit = () => rpcView(cfg, CONTRACT_ID, 'get_merit', { token_id: TOKEN });
const getJob = (jobId) => rpcView(cfg, CONTRACT_ID, 'get_job', { job_id: jobId });
const log = { network: 'testnet', contract_id: CONTRACT_ID, ran_at: new Date().toISOString(), steps: {} };
const out = new URL('../merit-audit-fix-log.json', import.meta.url);

async function expect(cond, msg) {
  if (!cond) throw new Error(`CHECK FAILED: ${msg}`);
  console.log(`   ok: ${msg}`);
}

// ---- a. cancel the two stuck Open escrows ---------------------------
console.log('a. cancel_job on demo-refusal + demo-lend-expired (poster refunds 0.01 NEAR each) ...');
const posterBefore = await rpcBalance(cfg, POSTER_ID);
const knownCancelTx = {
  'demo-refusal': 'FhRsy6hhsvaWRYx9jDadVQmP4DQQ1vMnCE7CSp9V6AxP',
  'demo-lend-expired': 'BAjRDa9sZQS7iZmGzBUjE3zfbHBHLtCJpiK1sNkVS8XR',
};
const cancels = {};
for (const jobId of ['demo-refusal', 'demo-lend-expired']) {
  const before = await getJob(jobId);
  if (before.status === 'Cancelled' && before.refund_pending === false) {
    console.log(`   ${jobId} already Cancelled (tx ${knownCancelTx[jobId]}), skipping`);
    cancels[jobId] = { cancel_tx: knownCancelTx[jobId], payment_yocto: before.payment, status: before.status, refund_pending: before.refund_pending };
    continue;
  }
  await expect(before.status === 'Open', `${jobId} is Open before cancel (status=${before.status})`);
  await expect(before.payment === nearToYocto('0.01').toString(), `${jobId} escrow is 0.01 NEAR`);
  const tx = await call(poster, cfg, CONTRACT_ID, 'cancel_job', { job_id: jobId });
  // The refund is a callback; poll until the job reads Cancelled with
  // no refund pending.
  let after = null;
  for (let i = 1; i <= 10; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    after = await getJob(jobId);
    if (after.status === 'Cancelled' && after.refund_pending === false) break;
  }
  await expect(after.status === 'Cancelled', `${jobId} is Cancelled after cancel_job`);
  await expect(after.refund_pending === false, `${jobId} refund_pending is false (refund landed)`);
  cancels[jobId] = { cancel_tx: tx, payment_yocto: before.payment, status: after.status, refund_pending: after.refund_pending };
  console.log(`   ${jobId}: cancel tx ${tx}, refunded 0.01 NEAR to ${POSTER_ID}`);
}
const posterAfterCancel = await rpcBalance(cfg, POSTER_ID);
log.steps.cancel_jobs = {
  ...cancels,
  poster_balance_before_yocto: posterBefore.toString(),
  poster_balance_after_yocto: posterAfterCancel.toString(),
  poster_net_delta_yocto: (posterAfterCancel - posterBefore).toString(),
  note: 'Poster net delta is 0.02 NEAR refunds minus the gas of the two cancel calls.',
};

// ---- b. buy a kit with retained --------------------------------------
console.log('b. mint kit demo-hammer to the poster, then buy_kit for merit-2 ...');
const meritBefore = await getMerit();
await expect(meritBefore.balance_retained === '225000000000000000000000', `merit-2 retained is 0.225 NEAR before buy (got ${yoctoToNear(meritBefore.balance_retained)})`);
await expect(meritBefore.balance_withdrawable === '2375000000000000000000000', `merit-2 withdrawable is 2.375 NEAR before buy`);
const kitPrice = await rpcView(cfg, CONTRACT_ID, 'kit_price', {});
await expect(kitPrice === '100000000000000000000000', `kit_price is 0.1 NEAR (got ${yoctoToNear(kitPrice)})`);
const subBefore = await rpcBalance(cfg, SUB);
const sellerBefore = await rpcBalance(cfg, POSTER_ID);
const mintKitTxKnown = 'DFeNWKHj2skmCg9rHEf5VXKvWDXB2c2ziLDqYJu1FMkj'; // recovered from Nearblocks after the first run: the mint landed but the immediate get_kit read lagged
let mintKitTx;
try {
  const existingKit = await rpcView(cfg, CONTRACT_ID, 'get_kit', { kit_token_id: 'demo-hammer' });
  if (existingKit.owner_id === POSTER_ID && existingKit.inside_merit === null) {
    console.log(`   demo-hammer already minted (tx ${mintKitTxKnown}), reusing it`);
    mintKitTx = mintKitTxKnown;
  } else {
    throw new Error(`demo-hammer already exists in an unexpected state: ${JSON.stringify(existingKit)}`);
  }
} catch (e) {
  if (!/kit not found/i.test(String(e.message || e))) throw e;
  mintKitTx = await call(owner, cfg, CONTRACT_ID, 'mint_kit', {
    kit_token_id: 'demo-hammer', name: 'Demo Hammer', receiver_id: POSTER_ID,
  });
  // The view can lag the finalized mint (seen once: get_kit read
  // "kit not found" right after the mint tx landed), so poll.
  let kitSeen = null;
  for (let i = 1; i <= 10; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    try { kitSeen = await rpcView(cfg, CONTRACT_ID, 'get_kit', { kit_token_id: 'demo-hammer' }); break; } catch (err) {
      if (!/kit not found/i.test(String(err.message || err))) throw err;
    }
  }
  if (!kitSeen) throw new Error('demo-hammer did not appear after mint_kit');
}
const kitBefore = await rpcView(cfg, CONTRACT_ID, 'get_kit', { kit_token_id: 'demo-hammer' });
await expect(kitBefore.owner_id === POSTER_ID && kitBefore.inside_merit === null, 'demo-hammer minted to the poster, outside any Merit');
const buyTx = await call(worker, cfg, CONTRACT_ID, 'buy_kit', { token_id: TOKEN, kit_token_id: 'demo-hammer' });
let meritAfter = null;
for (let i = 1; i <= 10; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  meritAfter = await getMerit();
  if ((meritAfter.kit || []).includes('demo-hammer')) break;
}
await expect((meritAfter.kit || []).includes('demo-hammer'), 'merit-2 kit list includes demo-hammer');
await expect(meritAfter.balance_retained === '125000000000000000000000', `merit-2 retained is 0.125 NEAR after buy (got ${yoctoToNear(meritAfter.balance_retained)})`);
await expect(meritAfter.balance_withdrawable === '2375000000000000000000000', 'merit-2 withdrawable still 2.375 NEAR after buy');
const kitAfter = await rpcView(cfg, CONTRACT_ID, 'get_kit', { kit_token_id: 'demo-hammer' });
await expect(kitAfter.owner_id === WORKER_ID && kitAfter.inside_merit === TOKEN, 'demo-hammer now owned by the holder, inside merit-2');
const subAfter = await rpcBalance(cfg, SUB);
const sellerAfter = await rpcBalance(cfg, POSTER_ID);
await expect(sellerAfter - sellerBefore === N / 10n, `seller (poster) gained exactly 0.1 NEAR (got ${yoctoToNear(sellerAfter - sellerBefore)})`);
await expect(subBefore - subAfter === N / 10n, `sub-account fell by exactly 0.1 NEAR (kit payout came from the sub-account)`);
console.log(`   mint_kit tx ${mintKitTx}, buy_kit tx ${buyTx}`);
console.log(`   retained 0.225 -> 0.125 NEAR, withdrawable still 2.375 NEAR, kit [${(meritAfter.kit || []).join(', ')}], sub ${yoctoToNear(subAfter)} NEAR`);
log.steps.buy_kit = {
  kit_token_id: 'demo-hammer', kit_name: 'Demo Hammer', kit_price_yocto: kitPrice,
  mint_kit_tx: mintKitTx, buy_kit_tx: buyTx, seller: POSTER_ID,
  retained_before_yocto: meritBefore.balance_retained, retained_after_yocto: meritAfter.balance_retained,
  withdrawable_before_yocto: meritBefore.balance_withdrawable, withdrawable_after_yocto: meritAfter.balance_withdrawable,
  kit_after: meritAfter.kit, sub_before_yocto: subBefore.toString(), sub_after_yocto: subAfter.toString(),
  seller_before_yocto: sellerBefore.toString(), seller_after_yocto: sellerAfter.toString(),
};

// ---- c. evidence_ref on a fresh test job -----------------------------
console.log('c. evidence_ref: fresh test job, dispute, submit evidence with real refs ...');
const JOB_ID = 'audit-evidence-ref';
const posterText = 'audit evidence: poster photo of the finished work';
const workerText = 'audit evidence: worker photo of the finished work';
const posterRef = `data:text/plain;base64,${Buffer.from(posterText).toString('base64')}`;
const workerRef = `data:text/plain;base64,${Buffer.from(workerText).toString('base64')}`;
const posterHash = sha256hex(posterText);
const workerHash = sha256hex(workerText);
let evTxs = null;
try {
  const existing = await getJob(JOB_ID);
  if (existing.status === 'Disputed' && existing.poster_evidence_ref === posterRef && existing.worker_evidence_ref === workerRef) {
    console.log('   audit-evidence-ref already Disputed with both refs stored, verifying only');
    evTxs = { create_tx: 'see first run', accept_tx: 'see first run', dispute_tx: 'see first run', poster_evidence_tx: 'see first run', worker_evidence_tx: 'see first run' };
  }
} catch (e) {
  if (!/job not found/i.test(String(e.message || e))) throw e;
}
if (!evTxs) {
const createTx = await call(poster, cfg, CONTRACT_ID, 'create_job', {
  job_id: JOB_ID,
  title: 'Audit check: evidence reference storage',
  description: 'Audit fix check job for evidence_ref (M-06). Created only to verify the reference field stores onchain.',
  required_stamps: [{ skill: 'merit-basics', min_level: 1 }],
  completion_stamp: { skill: 'coding', level: 1 },
  criteria: 'Submit evidence with a content reference and confirm it is stored onchain.',
}, { deposit: nearToYocto('0.01') });
const acceptTx = await call(worker, cfg, CONTRACT_ID, 'accept_job', { job_id: JOB_ID, token_id: TOKEN });
const disputeTx = await call(poster, cfg, CONTRACT_ID, 'raise_dispute', { job_id: JOB_ID });
const posterEvTx = await call(poster, cfg, CONTRACT_ID, 'submit_evidence', { job_id: JOB_ID, evidence_hash: posterHash, evidence_ref: posterRef });
const workerEvTx = await call(worker, cfg, CONTRACT_ID, 'submit_evidence', { job_id: JOB_ID, evidence_hash: workerHash, evidence_ref: workerRef });
  console.log(`   create ${createTx}, accept ${acceptTx}, dispute ${disputeTx}`);
  console.log(`   poster evidence ${posterEvTx}, worker evidence ${workerEvTx}`);
  evTxs = { create_tx: createTx, accept_tx: acceptTx, dispute_tx: disputeTx, poster_evidence_tx: posterEvTx, worker_evidence_tx: workerEvTx };
}
let job = null;
for (let i = 1; i <= 10; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  job = await getJob(JOB_ID);
  if (job.poster_evidence_ref === posterRef && job.worker_evidence_ref === workerRef) break;
}
await expect(job.status === 'Disputed', `test job is Disputed (status=${job.status})`);
await expect(job.poster_evidence === posterHash, 'poster evidence hash stored');
await expect(job.worker_evidence === workerHash, 'worker evidence hash stored');
await expect(job.poster_evidence_ref === posterRef, 'poster evidence_ref stored onchain');
await expect(job.worker_evidence_ref === workerRef, 'worker evidence_ref stored onchain');
console.log(`   refs stored: poster ${posterRef.slice(0, 40)}..., worker ${workerRef.slice(0, 40)}...`);
log.steps.evidence_ref = {
  job_id: JOB_ID, ...evTxs,
  poster_evidence_hash: posterHash, worker_evidence_hash: workerHash,
  poster_evidence_ref: posterRef, worker_evidence_ref: workerRef,
  status: job.status,
  note: 'Test job left Disputed on purpose: submit_evidence requires a Disputed job. Its 0.01 NEAR escrow stays locked until a DAO refund proposal resolves it; no proposal was created here.',
};

// ---- final state ------------------------------------------------------
const meritFinal = await getMerit();
const jobsFinal = await rpcView(cfg, CONTRACT_ID, 'list_jobs', { from_index: '0', limit: 50 });
const skills = await rpcView(cfg, CONTRACT_ID, 'list_completion_skills', {});
log.final = {
  merit_2: {
    level: meritFinal.level,
    balance_withdrawable_yocto: meritFinal.balance_withdrawable,
    balance_retained_yocto: meritFinal.balance_retained,
    kit: meritFinal.kit,
    stamps: meritFinal.stamps,
  },
  sub_balance_yocto: (await rpcBalance(cfg, SUB)).toString(),
  jobs: jobsFinal.map((j) => ({ job_id: j.job_id, status: j.status })),
  completion_skills: skills,
};
log.steps.registry_check = {
  note: 'Registry gating was already proven by the contract agent smoke test (unregistered skill rejected, registered accepted); not repeated here.',
  completion_skills: skills,
};
fs.writeFileSync(out, JSON.stringify(log, null, 2) + '\n');
console.log('\nAUDIT-FIX VERIFY OK');
console.log(`merit-2: level ${meritFinal.level}, withdrawable ${yoctoToNear(meritFinal.balance_withdrawable)} NEAR, retained ${yoctoToNear(meritFinal.balance_retained)} NEAR, kit [${(meritFinal.kit || []).join(', ')}]`);
console.log(`jobs: ${jobsFinal.map((j) => `${j.job_id}:${j.status}`).join(' ')}`);
console.log('wrote merit-audit-fix-log.json');
