// One-off recovery for Merit demo phase 9 (2026-11-10).
// The lend job (demo-lend-gate) already completed onchain — the
// delegate accept and poster confirm both landed — but the demo's
// post-tx view read stale state, so the run exited before recording
// the step. This script finishes the remaining phase-9 work
// (expiry wait, post-expiry refusal, revoke) and records the step
// with the REAL tx hashes recovered from the explorer, so the demo
// can resume at phase 10. Run once, then delete.
import {
  loadConfig, loadAccounts, accountFor, rpcView, rpcBalance, call, callExpectFail,
  loadLog, saveLog, markStep, sleep, nowNs, nearToYocto, yoctoToNear, N,
} from './demo-common.mjs';

const cfg = loadConfig();
const accounts = loadAccounts(cfg);
const log = loadLog(cfg);
const CONTRACT_ID = cfg.contract_id;
const TOKEN = cfg.token_id;
const POSTER_ID = accounts.poster.accountId;
const SUB = `${TOKEN}.${CONTRACT_ID}`;
const worker = await accountFor(accounts, cfg, 'worker');
const poster = await accountFor(accounts, cfg, 'poster');

// Tx hashes recovered from the Nearblocks explorer for
// merit-poster.testnet (accept_job + complete_job on the lend job),
// and the lend tx printed by the failed run.
const LEND_TX = '9CTL8nmrEyYqzyqtHmVuAnFmiXnj3cszbVjYYBSNVrqD';
const LEND_EXPIRES_AT_NS = '1794292633719000000';
const DELEGATE_ACCEPT_TX = 'AskxMY2tEYVhCEJ2z4AKL9gdqfUEdzMxCcRt4pakZTHG';
const DELEGATE_COMPLETE_TX = 'Dj8Snkjgfgs8Crgxmd9NtZ6chmg8xCiksB7QDFQ99ApE';

async function getMerit() {
  return rpcView(cfg, CONTRACT_ID, 'get_merit', { token_id: TOKEN });
}
async function subBalance() {
  return rpcBalance(cfg, SUB);
}

const j = cfg.jobs.lend;
const checkJob = cfg.jobs.lend_check;

// Confirm the lend job really is Completed onchain before recording it.
const job = await rpcView(cfg, CONTRACT_ID, 'get_job', { job_id: j.job_id });
if (job.status !== 'Completed') throw new Error(`lend job is ${job.status}, not Completed — aborting recovery`);
console.log(`lend job ${j.job_id} is Completed onchain (accepted_by ${job.accepted_by})`);

// Confirm the resulting state (withdrawable 0.475, torch-work 1).
const merit = await getMerit();
const expectedWithdrawable = (95n * nearToYocto(j.payment_near) / 100n).toString();
if (merit.balance_withdrawable !== expectedWithdrawable) throw new Error(`withdrawable ${yoctoToNear(merit.balance_withdrawable)} != 0.475`);
const s = (merit.stamps || []).find((x) => x.skill === j.completion_stamp.skill);
if (!s || s.level !== j.completion_stamp.level) throw new Error('torch-work completion stamp missing');
console.log(`withdrawable 0.475 NEAR, torch-work ${s.level} issued — completion confirmed`);

// Wait for the lend to expire (same window as phase 9).
console.log('waiting for the lend to expire ...');
const deadlineMs = Date.now() + (cfg.lend_seconds + 30) * 1000;
let expired = false;
while (Date.now() < deadlineMs) {
  const can = await rpcView(cfg, CONTRACT_ID, 'can_access', { token_id: TOKEN, job_id: checkJob.job_id, account_id: POSTER_ID });
  if (can === false) { expired = true; break; }
  await sleep(10000);
}
if (!expired) throw new Error('lend did not expire onchain within the wait window');
console.log('lend expired onchain (can_access false)');

// Post-expiry refusal: delegate tries to accept the check job.
const failure = await callExpectFail(poster, cfg, CONTRACT_ID, 'accept_job', { job_id: checkJob.job_id, token_id: TOKEN });
if (!/neither the holder nor a live lend delegate/i.test(failure)) throw new Error(`post-expiry refusal should be about access, got: ${failure.slice(0, 300)}`);
console.log(`EXPIRED: delegate accept REFUSED: ${failure.slice(0, 200)}`);

// Revoke the lend (idempotent: sets lend to None even if already revoked).
const revokeTx = await call(worker, cfg, CONTRACT_ID, 'revoke_lend', { token_id: TOKEN });
// The view can lag the finalized revoke on a flaky RPC node; poll
// until the lend reads null before concluding.
let after = await getMerit();
for (let attempt = 1; attempt <= 6 && after.lend !== null && after.lend !== undefined; attempt++) {
  await sleep(3000);
  after = await getMerit();
}
if (after.lend !== null && after.lend !== undefined) throw new Error('lend should be revoked (null)');
console.log(`lend revoked (tx ${revokeTx}); access is back with the holder only`);

// Record the jobs and the step, exactly as phase 9 would have.
log.jobs[j.job_id] = {
  ...(log.jobs[j.job_id] || {}),
  accept_tx: DELEGATE_ACCEPT_TX, complete_tx: DELEGATE_COMPLETE_TX, status: 'Completed',
};
log.jobs[checkJob.job_id] = {
  ...(log.jobs[checkJob.job_id] || {}),
  accept_refusal_after_expiry: failure,
};
saveLog(cfg, log);
markStep(log, cfg, '9-lend', {
  lend_tx: LEND_TX, expires_at_ns: LEND_EXPIRES_AT_NS,
  delegate_accept_tx: DELEGATE_ACCEPT_TX,
  delegate_complete_tx: DELEGATE_COMPLETE_TX,
  post_expiry_refusal: failure, revoke_tx: revokeTx,
  sub_balance_yocto: (await subBalance()).toString(),
});
console.log('phase 9 recorded in the log. Demo can now resume at phase 10.');
