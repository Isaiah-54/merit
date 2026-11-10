// Merit live demo, orchestrated end to end on testnet.
// DO NOT RUN until the contract and the DAO are deployed and the
// demo accounts exist (scripts/create-accounts.mjs +
// scripts/create-dao.mjs + scripts/deploy.mjs). This script only
// signs for accounts whose keys are in .testnet-accounts.json
// (contract/owner, Joseph stand-in, poster, worker). It CANNOT sign
// for clearsite587.testnet (Isaiah) or james54.testnet (James):
// the dispute's second council vote is a clearly-marked MANUAL
// step, and the script waits for it onchain instead of faking it.
//
//   node scripts/demo.mjs            # run all phases, resuming from merit-demo-log.json
//   node scripts/demo.mjs --fresh    # ignore any previous log and start over
//   node scripts/demo.mjs --only 11  # re-run one phase (e.g. resume the manual-vote wait)
//   node scripts/demo.mjs --list     # print the step list without touching the chain
//
// Every phase is a real onchain call and its receipt (tx hash,
// balances, stamps, job status) is saved to merit-demo-log.json
// after the phase finishes. Nothing in the log contains a key.
//
// Expected numbers (see the phase comments for the running totals):
//   mint 0.1 NEAR -> sub-account 0.05 NEAR
//   main job 2 NEAR -> withdrawable 1.9 / retained 0.1, sub 2.05
//   withdraw 1.9 -> sub 0.15 (0.05 init + 0.1 retained)
//   lend job 0.5 NEAR -> withdrawable 0.475 / retained 0.125, sub 0.65
//   timeout job 1 NEAR -> withdrawable 1.425 / retained 0.175, sub 1.65
//   dispute job 1 NEAR (DAO pay_full) -> withdrawable 2.375 / retained 0.225, sub 2.65
//   poster spends 4.52 NEAR escrow + 1 NEAR DAO bond + gas (10 NEAR faucet funds cover it).
//   The refusal job (0.01) and the lend-expiry check job (0.01) stay
//   Open on purpose; their escrow stays locked (no cancel method).
import fs from 'node:fs';
import {
  N, GAS, MINT_GAS, DAO_BOND,
  sleep, nearToYocto, yoctoToNear, sha256hex, nowNs,
  loadConfig, loadAccounts, accountFor, rpcView, rpcAccount, rpcBalance,
  call, callExpectFail, logPath, loadLog, saveLog, newLog, markStep, stepDone,
} from './demo-common.mjs';

const cfg = loadConfig();
const CONTRACT_ID = cfg.contract_id;
const DAO_ID = cfg.dao_id;
const TOKEN = cfg.token_id;
const SUB = `${TOKEN}.${CONTRACT_ID}`;
const args = process.argv.slice(2);
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const FRESH = args.includes('--fresh');

const PHASES = [
  ['1', `Mint a blank Merit (${cfg.token_id}) to the worker`],
  ['2', 'Blank Merit tries a gated job and is REFUSED onchain'],
  ['3', 'Earn stamp 1: pass_test (answer "merit") -> merit-basics 1'],
  ['4', 'Earn stamp 2: DAO attestation, owner stamps welding 2'],
  ['5', 'Deposit a kit item (welding torch) into the Merit'],
  ['6', 'Poster creates a 2 NEAR paid job; worker accepts and gets IN'],
  ['7', 'Poster confirms completion; payment + welding 3 land'],
  ['8', 'Holder withdraws 1.9 NEAR from the sub-account'],
  ['9', 'LEND to the poster: delegate opens a gated job, then expiry refuses'],
  ['10', 'TIMEOUT path: 60s job, poster silent, anyone releases'],
  ['11', 'DISPUTE path: DAO proposal, Joseph votes, MANUAL second vote, pay_full executes'],
];

if (args.includes('--list')) {
  console.log('Merit live demo phases (testnet only, nothing deployed yet):');
  for (const [id, title] of PHASES) console.log(`  ${id}. ${title}`);
  console.log(`contract ${CONTRACT_ID}  dao ${DAO_ID}  token ${TOKEN}  sub-account ${SUB}`);
  console.log('Run: node scripts/demo.mjs   (resumes from merit-demo-log.json)');
  process.exit(0);
}
if (ONLY && !PHASES.some(([id]) => id === ONLY)) {
  throw new Error(`--only ${ONLY} is not a phase id (1-11)`);
}

const accounts = loadAccounts(cfg);
let log = FRESH ? null : loadLog(cfg);
if (log && (log.contract_id !== CONTRACT_ID || log.token_id !== TOKEN)) {
  throw new Error(`existing log is for ${log.contract_id} / ${log.token_id}, not ${CONTRACT_ID} / ${TOKEN} — use --fresh to start over`);
}
if (!log) {
  log = newLog(cfg, accounts);
  saveLog(cfg, log);
  console.log('fresh demo log started:', logPath(cfg).pathname);
} else {
  console.log('resuming demo from log:', logPath(cfg).pathname);
}

const owner = await accountFor(accounts, cfg, 'contract'); // also the "Merit DAO" issuer
const joseph = await accountFor(accounts, cfg, 'joseph'); // Joseph seat, stand-in (key held)
const poster = await accountFor(accounts, cfg, 'poster');
const worker = await accountFor(accounts, cfg, 'worker');
const WORKER_ID = accounts.worker.accountId;
const POSTER_ID = accounts.poster.accountId;
const JOSEPH_ID = accounts.joseph.accountId;

const getMerit = () => rpcView(cfg, CONTRACT_ID, 'get_merit', { token_id: TOKEN });
const getJob = (jobId) => rpcView(cfg, CONTRACT_ID, 'get_job', { job_id: jobId });
const subBalance = () => rpcBalance(cfg, SUB);
const stampOf = (merit, skill) => (merit.stamps || []).find((s) => s.skill === skill);

function expect(cond, msg) {
  if (!cond) throw new Error(`CHECK FAILED: ${msg}`);
}

// Poll a view until it satisfies `pred`. The RPC node can serve a
// stale pre-tx state right after a finalized transaction (seen
// three times in phase 9), and can also return a malformed response
// (missing result bytes) under load, so a single read right after a
// tx is not proof. Retries both a non-matching value and a thrown
// read error. Returns the first value satisfying `pred`; throws
// after `attempts` with the last value/error seen.
async function waitForView(get, pred, what, { attempts = 10, delayMs = 3000 } = {}) {
  let last;
  let lastErr = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      last = await get();
      lastErr = null;
      if (pred(last)) return last;
    } catch (e) {
      lastErr = e;
    }
    if (i < attempts) await sleep(delayMs);
  }
  throw new Error(`CHECK FAILED: ${what} (last value: ${JSON.stringify(last)?.slice(0, 200)}; last error: ${String(lastErr?.message || lastErr || '').slice(0, 200)})`);
}

function recordJob(jobId, patch) {
  log.jobs[jobId] = { ...(log.jobs[jobId] || {}), ...patch };
  saveLog(cfg, log);
}

async function createJob(signer, jobCfg, { timeoutSeconds = null } = {}) {
  const payment = nearToYocto(jobCfg.payment_near);
  // Idempotent: if the job already exists (a previous run created it
  // but failed before recording the step), reuse it instead of
  // failing on the contract's "job already exists" assert. Retry the
  // existence read: a transient RPC error must not be mistaken for
  // "job does not exist" (that would send a duplicate create_job).
  let existing = null;
  let lastErr = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      existing = await getJob(jobCfg.job_id);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      if (/job not found/i.test(String(e.message || e))) { existing = null; lastErr = null; break; }
      if (attempt < 4) await sleep(3000);
    }
  }
  if (lastErr) throw new Error(`could not read job ${jobCfg.job_id} to check existence: ${String(lastErr.message || lastErr).slice(0, 200)}`);
  if (existing) {
    expect(existing.payment === payment.toString(), `existing job ${jobCfg.job_id} payment should be ${payment}, got ${existing.payment}`);
    recordJob(jobCfg.job_id, {
      title: jobCfg.title, payment_yocto: payment.toString(),
      payment_near: jobCfg.payment_near, criteria: jobCfg.criteria,
      required_stamps: jobCfg.required_stamps, completion_stamp: jobCfg.completion_stamp,
      status: existing.status,
    });
    console.log(`   job ${jobCfg.job_id} already exists (resuming); status ${existing.status}`);
    return { tx: null, job: existing };
  }
  const tx = await call(signer, cfg, CONTRACT_ID, 'create_job', {
    job_id: jobCfg.job_id,
    title: jobCfg.title,
    description: jobCfg.description,
    required_stamps: jobCfg.required_stamps,
    completion_stamp: jobCfg.completion_stamp,
    criteria: jobCfg.criteria,
    ...(timeoutSeconds ? { timeout_ns: String(BigInt(timeoutSeconds) * 1_000_000_000n) } : {}),
  }, { deposit: payment });
  const job = await waitForView(() => getJob(jobCfg.job_id), (x) => x.status === 'Open' && x.payment === payment.toString(), `job ${jobCfg.job_id} should be Open with payment ${payment}`);
  expect(job.status === 'Open', `job ${jobCfg.job_id} should be Open, got ${job.status}`);
  expect(job.payment === payment.toString(), `job ${jobCfg.job_id} payment should be ${payment}, got ${job.payment}`);
  recordJob(jobCfg.job_id, {
    title: jobCfg.title, payment_yocto: payment.toString(),
    payment_near: jobCfg.payment_near, criteria: jobCfg.criteria,
    required_stamps: jobCfg.required_stamps, completion_stamp: jobCfg.completion_stamp,
    create_tx: tx, status: 'Open',
  });
  return { tx, job };
}

// ---- Phase 1: mint -------------------------------------------------
async function phase1() {
  console.log(`1. worker mints a blank Merit (${TOKEN}) ...`);
  const tx = await call(worker, cfg, CONTRACT_ID, 'nft_mint', {
    token_id: TOKEN, receiver_id: WORKER_ID, metadata: { title: `Merit ${TOKEN}` },
  }, { gas: MINT_GAS, deposit: nearToYocto(cfg.mint_price_near) });
  const token = await rpcView(cfg, CONTRACT_ID, 'nft_token', { token_id: TOKEN });
  expect(token.owner_id === WORKER_ID, `nft_token owner should be ${WORKER_ID}, got ${token.owner_id}`);
  const sub = await rpcAccount(cfg, SUB);
  // NOTE: a sub-account using the global wallet contract reports the
  // EMPTY code_hash in view_account (its code is referenced by hash,
  // not stored on the account), so code_hash cannot prove the wallet
  // is attached. Prove it functionally instead: the wallet's
  // get_parent must return the Merit contract.
  const walletParent = await rpcView(cfg, SUB, 'get_parent', {});
  expect(walletParent === CONTRACT_ID, `sub-account ${SUB} wallet get_parent should be ${CONTRACT_ID}, got ${walletParent}`);
  const bal = BigInt(sub.amount);
  expect(bal === N / 20n, `sub-account balance after mint should be 0.05 NEAR, got ${yoctoToNear(bal)}`);
  const merit = await getMerit();
  expect((merit.stamps || []).length === 0, 'blank Merit should have no stamps');
  expect(merit.balance_withdrawable === '0' && merit.balance_retained === '0', 'blank Merit should hold 0');
  console.log(`   mint tx ${tx}; sub-account ${SUB} exists, balance 0.05 NEAR, no stamps`);
  markStep(log, cfg, '1-mint', { tx, sub_account: SUB, sub_balance_yocto: bal.toString(), stamps: [] });
}

// ---- Phase 2: refusal ----------------------------------------------
async function phase2() {
  const j = cfg.jobs.refusal;
  console.log('2. blank Merit tries the gated job and must be REFUSED ...');
  const { tx } = await createJob(poster, j);
  const can = await rpcView(cfg, CONTRACT_ID, 'can_access', { token_id: TOKEN, job_id: j.job_id, account_id: WORKER_ID });
  expect(can === false, 'can_access should be false for the blank Merit');
  const failure = await callExpectFail(worker, cfg, CONTRACT_ID, 'accept_job', { job_id: j.job_id, token_id: TOKEN });
  expect(/does not satisfy|required stamp/i.test(failure), `refusal should be about missing stamps, got: ${failure.slice(0, 300)}`);
  const job = await getJob(j.job_id);
  expect(job.status === 'Open', `refused job should stay Open, got ${job.status}`);
  console.log(`   REFUSED onchain as expected: ${failure.slice(0, 200)}`);
  console.log(`   (job ${j.job_id} stays Open; its 0.01 NEAR escrow stays locked, no cancel method)`);
  recordJob(j.job_id, { accept_refusal: failure });
  markStep(log, cfg, '2-refusal', { create_tx: tx, can_access_before: false, accept_failure: failure, job_status: 'Open' });
}

// ---- Phase 3: pass_test --------------------------------------------
async function phase3() {
  console.log('3. worker passes the test (answer "merit") ...');
  const tx = await call(worker, cfg, CONTRACT_ID, 'pass_test', { token_id: TOKEN, answer: cfg.test_answer });
  const merit = await getMerit();
  const s = stampOf(merit, 'merit-basics');
  expect(!!s && s.level === 1, 'merit-basics 1 stamp missing after pass_test');
  expect(s.issuer_name === 'Merit Test', `pass_test issuer should be "Merit Test", got ${s.issuer_name}`);
  expect(s.issuer === CONTRACT_ID, 'pass_test issuer should be the contract account');
  expect(merit.locked === true, 'Merit should be locked after its first stamp');
  console.log(`   pass_test tx ${tx}; stamp merit-basics 1 (Merit Test), Merit locked`);
  markStep(log, cfg, '3-pass-test', { tx, stamp: s });
}

// ---- Phase 4: DAO attestation stamp ---------------------------------
async function phase4() {
  const { skill, level } = cfg.dao_stamp;
  console.log(`4. owner ("Merit DAO" issuer) stamps ${skill} ${level} ...`);
  const tx = await call(owner, cfg, CONTRACT_ID, 'stamp', { token_id: TOKEN, skill, level });
  const merit = await getMerit();
  const s = stampOf(merit, skill);
  expect(!!s && s.level === level, `${skill} ${level} stamp missing`);
  expect(s.issuer_name === 'Merit DAO', `DAO stamp issuer should be "Merit DAO", got ${s.issuer_name}`);
  console.log(`   stamp tx ${tx}; stamp ${skill} ${level} (Merit DAO)`);
  markStep(log, cfg, '4-dao-stamp', { tx, stamp: s });
}

// ---- Phase 5: kit ----------------------------------------------------
// The kit is the named tool tied to the welding credential: a Welding
// torch (kit id "welding-torch"), minted as an NFT and deposited into
// the Merit so the Merit visibly carries the tool its welding stamp
// certifies the holder to use. The job gate is the stamp, not the kit:
// removing the torch would take it out of the Merit but would not close
// a job the stamps already unlock, so the demo does not claim otherwise.
async function phase5() {
  const kit = cfg.kit;
  console.log(`5. mint kit "${kit.name}" (the tool for the welding credential) and deposit it into the Merit ...`);
  const mintTx = await call(owner, cfg, CONTRACT_ID, 'mint_kit', {
    kit_token_id: kit.kit_token_id, name: kit.name, receiver_id: WORKER_ID,
  });
  const depositTx = await call(worker, cfg, CONTRACT_ID, 'deposit_kit', {
    token_id: TOKEN, kit_token_id: kit.kit_token_id,
  });
  const kitView = await rpcView(cfg, CONTRACT_ID, 'get_kit', { kit_token_id: kit.kit_token_id });
  expect(kitView.inside_merit === TOKEN, `kit should be inside ${TOKEN}, got ${kitView.inside_merit}`);
  const merit = await getMerit();
  expect((merit.kit || []).includes(kit.kit_token_id), 'get_merit kit list should contain the torch');
  console.log(`   mint_kit tx ${mintTx}, deposit_kit tx ${depositTx}; "${kit.name}" (${kit.kit_token_id}) inside ${TOKEN}, the tool for the welding credential`);
  markStep(log, cfg, '5-kit', { mint_tx: mintTx, deposit_tx: depositTx, kit: kitView, note: 'Welding torch is the named tool tied to the welding credential, held inside the Merit. The job gate is the stamp, not the kit.' });
}

// ---- Phase 6: main job ----------------------------------------------
async function phase6() {
  const j = cfg.jobs.main;
  console.log(`6. poster creates the ${j.payment_near} NEAR job; worker accepts ...`);
  const { tx } = await createJob(poster, j);
  const can = await rpcView(cfg, CONTRACT_ID, 'can_access', { token_id: TOKEN, job_id: j.job_id, account_id: WORKER_ID });
  expect(can === true, 'can_access should be true once stamped');
  const acceptTx = await call(worker, cfg, CONTRACT_ID, 'accept_job', { job_id: j.job_id, token_id: TOKEN });
  const job = await getJob(j.job_id);
  expect(job.status === 'Accepted', `job should be Accepted, got ${job.status}`);
  expect(job.accepted_by === TOKEN, 'job accepted_by should be the Merit');
  console.log(`   create tx ${tx}, accept tx ${acceptTx}; job Accepted, worker is IN`);
  recordJob(j.job_id, { accept_tx: acceptTx, status: 'Accepted' });
  markStep(log, cfg, '6-main-job', { create_tx: tx, accept_tx: acceptTx, job_status: 'Accepted' });
}

// ---- Phase 7: completion ---------------------------------------------
async function phase7() {
  const j = cfg.jobs.main;
  console.log('7. poster confirms completion ...');
  const tx = await call(poster, cfg, CONTRACT_ID, 'complete_job', { job_id: j.job_id, token_id: TOKEN });
  const job = await getJob(j.job_id);
  expect(job.status === 'Completed', `job should be Completed, got ${job.status}`);
  const bal = await subBalance();
  expect(bal === N / 20n + nearToYocto(j.payment_near), `sub-account should hold 0.05 + ${j.payment_near} NEAR, got ${yoctoToNear(bal)}`);
  const merit = await getMerit();
  expect(merit.balance_withdrawable === (95n * nearToYocto(j.payment_near) / 100n).toString(), `withdrawable should be 1.9 NEAR, got ${yoctoToNear(merit.balance_withdrawable)}`);
  expect(merit.balance_retained === (5n * nearToYocto(j.payment_near) / 100n).toString(), `retained should be 0.1 NEAR, got ${yoctoToNear(merit.balance_retained)}`);
  const s = stampOf(merit, j.completion_stamp.skill);
  expect(!!s && s.level === j.completion_stamp.level, 'completion stamp welding 3 missing');
  expect(s.issuer_name === 'Job completion', 'completion stamp issuer should be "Job completion"');
  console.log(`   complete tx ${tx}; sub ${yoctoToNear(bal)} NEAR, withdrawable 1.9 / retained 0.1, welding 3 issued`);
  recordJob(j.job_id, { complete_tx: tx, status: 'Completed' });
  markStep(log, cfg, '7-complete', {
    tx, sub_balance_yocto: bal.toString(),
    withdrawable_yocto: merit.balance_withdrawable, retained_yocto: merit.balance_retained,
    completion_stamp: s,
  });
}

// ---- Phase 8: withdraw -----------------------------------------------
async function phase8() {
  console.log('8. holder withdraws 1.9 NEAR from the sub-account ...');
  const holderBefore = await rpcBalance(cfg, WORKER_ID);
  const subBefore = await subBalance();
  const amount = 95n * nearToYocto(cfg.jobs.main.payment_near) / 100n; // 1.9 NEAR
  const tx = await call(worker, cfg, CONTRACT_ID, 'withdraw', { token_id: TOKEN, amount: amount.toString() });
  const holderAfter = await rpcBalance(cfg, WORKER_ID);
  const subAfter = await subBalance();
  const merit = await getMerit();
  expect(subAfter === subBefore - amount, `sub-account should fall by 1.9 NEAR, got ${yoctoToNear(subAfter)}`);
  expect(merit.balance_withdrawable === '0', 'withdrawable should be 0 after full withdrawal');
  expect(merit.balance_retained === (5n * nearToYocto(cfg.jobs.main.payment_near) / 100n).toString(), 'retained 0.1 NEAR stays');
  const delta = holderAfter - holderBefore;
  expect(delta > 189n * N / 100n, `holder should receive ~1.9 NEAR (gas aside), got ${yoctoToNear(delta)}`);
  console.log(`   withdraw tx ${tx}; holder +${yoctoToNear(delta)} NEAR, sub-account ${yoctoToNear(subAfter)} NEAR (0.05 init + 0.1 retained)`);
  markStep(log, cfg, '8-withdraw', {
    tx, amount_yocto: amount.toString(), holder_delta_yocto: delta.toString(),
    sub_balance_yocto: subAfter.toString(), holder_before_yocto: holderBefore.toString(),
    holder_after_yocto: holderAfter.toString(),
  });
}

// ---- Phase 9: lend ----------------------------------------------------
async function phase9() {
  const j = cfg.jobs.lend;
  const checkJob = cfg.jobs.lend_check;
  console.log(`9. LEND the Merit to the poster for ${cfg.lend_seconds}s ...`);
  await createJob(poster, j);
  await createJob(poster, checkJob);
  const expiresAt = nowNs() + BigInt(cfg.lend_seconds) * 1_000_000_000n;
  const lendTx = await call(worker, cfg, CONTRACT_ID, 'lend', {
    token_id: TOKEN, to: POSTER_ID, expires_at: expiresAt.toString(),
  });
  // The view can lag the finalized lend on a flaky RPC node (a
  // can_access right after the lend has read false once even though
  // the lend was onchain); retry briefly before concluding the
  // delegate cannot access. Bounded so the 90s lend window still
  // leaves room for the delegate accept + complete below.
  let canPoster = false;
  for (let attempt = 1; attempt <= 5; attempt++) {
    canPoster = await rpcView(cfg, CONTRACT_ID, 'can_access', { token_id: TOKEN, job_id: j.job_id, account_id: POSTER_ID });
    if (canPoster === true) break;
    if (attempt < 5) await sleep(2000);
  }
  expect(canPoster === true, 'can_access should be true for the lend delegate');
  console.log(`   lend tx ${lendTx}; delegate ${POSTER_ID} can open the gated job (access moved)`);
  const acceptTx = await call(poster, cfg, CONTRACT_ID, 'accept_job', { job_id: j.job_id, token_id: TOKEN });
  const completeTx = await call(poster, cfg, CONTRACT_ID, 'complete_job', { job_id: j.job_id, token_id: TOKEN });
  const job = await waitForView(() => getJob(j.job_id), (x) => x.status === 'Completed', 'lend job should be Completed');
  expect(job.status === 'Completed', `lend job should be Completed, got ${job.status}`);
  const merit = await getMerit();
  expect(merit.balance_withdrawable === (95n * nearToYocto(j.payment_near) / 100n).toString(), 'withdrawable should be 0.475 NEAR after the lend job');
  const s = stampOf(merit, j.completion_stamp.skill);
  expect(!!s && s.level === j.completion_stamp.level, 'torch-work completion stamp missing');
  console.log(`   delegate accepted (tx ${acceptTx}) and poster confirmed (tx ${completeTx}); withdrawable 0.475 NEAR, torch-work 1 issued`);
  recordJob(j.job_id, { accept_tx: acceptTx, complete_tx: completeTx, status: 'Completed' });

  console.log('   waiting for the lend to expire ...');
  const deadlineMs = Date.now() + (cfg.lend_seconds + 30) * 1000;
  let expired = false;
  while (Date.now() < deadlineMs) {
    const can = await rpcView(cfg, CONTRACT_ID, 'can_access', { token_id: TOKEN, job_id: checkJob.job_id, account_id: POSTER_ID });
    if (can === false) { expired = true; break; }
    await sleep(10000);
  }
  expect(expired, 'lend did not expire onchain within the wait window');
  const failure = await callExpectFail(poster, cfg, CONTRACT_ID, 'accept_job', { job_id: checkJob.job_id, token_id: TOKEN });
  expect(/neither the holder nor a live lend delegate/i.test(failure), `post-expiry refusal should be about access, got: ${failure.slice(0, 300)}`);
  console.log(`   EXPIRED: can_access is false and the delegate accept is REFUSED: ${failure.slice(0, 200)}`);
  const revokeTx = await call(worker, cfg, CONTRACT_ID, 'revoke_lend', { token_id: TOKEN });
  const after = await getMerit();
  expect(after.lend === null || after.lend === undefined, 'lend should be revoked (null)');
  console.log(`   lend revoked (tx ${revokeTx}); access is back with the holder only`);
  recordJob(checkJob.job_id, { accept_refusal_after_expiry: failure });
  markStep(log, cfg, '9-lend', {
    lend_tx: lendTx, expires_at_ns: expiresAt.toString(), delegate_accept_tx: acceptTx,
    delegate_complete_tx: completeTx, post_expiry_refusal: failure, revoke_tx: revokeTx,
    sub_balance_yocto: (await subBalance()).toString(),
  });
}

// ---- Phase 10: timeout -------------------------------------------------
async function phase10() {
  const j = cfg.jobs.timeout;
  console.log(`10. TIMEOUT path: ${j.payment_near} NEAR job, ${j.timeout_seconds}s deadline, poster stays silent ...`);
  await createJob(poster, j, { timeoutSeconds: j.timeout_seconds });
  const acceptTx = await call(worker, cfg, CONTRACT_ID, 'accept_job', { job_id: j.job_id, token_id: TOKEN });
  const accepted = await waitForView(() => getJob(j.job_id), (x) => x.status === 'Accepted', 'timeout job should be Accepted');
  expect(accepted.deadline, 'accepted job should carry a deadline');
  console.log(`   accepted (tx ${acceptTx}); deadline ${new Date(Number(BigInt(accepted.deadline) / 1_000_000n)).toISOString()} — waiting, poster silent ...`);
  let releaseTx = null;
  let lastErr = '';
  for (let attempt = 1; attempt <= 4; attempt++) {
    const now = nowNs();
    const waitMs = Number((BigInt(accepted.deadline) - now) / 1_000_000n) + 5000;
    if (waitMs > 0) await sleep(Math.min(waitMs, 120000));
    try {
      releaseTx = await call(worker, cfg, CONTRACT_ID, 'release_job', { job_id: j.job_id });
      break;
    } catch (e) {
      lastErr = String(e.message || e);
      if (!/deadline has not passed/i.test(lastErr)) throw e;
      console.log(`   release attempt ${attempt} too early, waiting 15s ...`);
      await sleep(15000);
    }
  }
  expect(releaseTx, `release_job never succeeded: ${lastErr.slice(0, 300)}`);
  const job = await waitForView(() => getJob(j.job_id), (x) => x.status === 'Completed', 'timeout job should be Completed after release');
  const expectedWithdrawable = (95n * (nearToYocto(cfg.jobs.lend.payment_near) + nearToYocto(j.payment_near)) / 100n).toString();
  const merit = await waitForView(getMerit, (x) => x.balance_withdrawable === expectedWithdrawable, 'withdrawable should be 1.425 NEAR after release');
  expect(merit.balance_withdrawable === expectedWithdrawable, `withdrawable should be 1.425 NEAR, got ${yoctoToNear(merit.balance_withdrawable)}`);
  const s = stampOf(merit, j.completion_stamp.skill);
  expect(!!s && s.level === j.completion_stamp.level, 'gate-welding completion stamp missing after release');
  const bal = await subBalance();
  expect(bal === N / 20n + nearToYocto(cfg.jobs.main.payment_near) + nearToYocto(cfg.jobs.lend.payment_near) + nearToYocto(j.payment_near) - nearToYocto('1.9'), `sub-account should be 1.65 NEAR, got ${yoctoToNear(bal)}`);
  console.log(`   release tx ${releaseTx}; silence was not a dispute — paid 0.95 / retained 0.05, gate-welding 1 issued, sub ${yoctoToNear(bal)} NEAR`);
  recordJob(j.job_id, { accept_tx: acceptTx, release_tx: releaseTx, status: 'Completed' });
  markStep(log, cfg, '10-timeout', {
    accept_tx: acceptTx, release_tx: releaseTx, sub_balance_yocto: bal.toString(),
    withdrawable_yocto: merit.balance_withdrawable, retained_yocto: merit.balance_retained,
    completion_stamp: s,
  });
}

// ---- Phase 11: dispute + DAO -------------------------------------------
async function daoCouncil() {
  const policy = await rpcView(cfg, DAO_ID, 'get_policy', {});
  const council = (policy.roles || []).find((r) => r.name === 'council');
  const members = council?.kind?.Group || [];
  return { policy, members };
}

function printManualVoteInstructions(proposalId, manualVoters) {
  console.log('');
  console.log('==============================================================');
  console.log('MANUAL STEP — second DAO vote (this script cannot cast it).');
  console.log(`  DAO proposal #${proposalId} on ${DAO_ID} needs 1 more Approve`);
  console.log('  to reach threshold 2 of 3. The Joseph stand-in vote is in.');
  console.log('  Who can cast it (keys NOT held here):');
  for (const v of manualVoters) console.log(`    - ${v}`);
  console.log('  How (Isaiah, on his phone): open the Merit site, go to the');
  console.log('  DAO voting page, open proposal #' + proposalId + ' (dispute ' + cfg.jobs.dispute.job_id + ', outcome pay_full), tap Approve.');
  console.log('  Or James54 votes Approve on the same proposal from his wallet.');
  console.log('  This script keeps polling the proposal state and resumes');
  console.log('  automatically once the vote lands. Do NOT re-run with --fresh.');
  console.log('==============================================================');
  console.log('');
}

async function phase11() {
  const j = cfg.jobs.dispute;
  console.log('11. DISPUTE path: poster disputes, both sides submit evidence, DAO judges ...');
  const existing = log.steps['11-dispute'];
  let proposalId = existing?.proposal_id ?? null;

  // NB: proposal ids are 0-based, so 0 is a valid id. `!proposalId`
  // would wrongly re-enter the creation branch for proposal #0.
  if (proposalId == null) {
    if (!stepDone(log, '10-timeout')) throw new Error('phase 11 needs phase 10 done first (run the full demo, or --only 10 before --only 11)');
    await createJob(poster, j);
    const acceptTx = await call(worker, cfg, CONTRACT_ID, 'accept_job', { job_id: j.job_id, token_id: TOKEN });
    const disputeTx = await call(poster, cfg, CONTRACT_ID, 'raise_dispute', { job_id: j.job_id });
    let job = await waitForView(() => getJob(j.job_id), (x) => x.status === 'Disputed', 'job should be Disputed');
    const posterEvidence = sha256hex(j.poster_evidence_text);
    const workerEvidence = sha256hex(j.worker_evidence_text);
    const posterEvTx = await call(poster, cfg, CONTRACT_ID, 'submit_evidence', { job_id: j.job_id, evidence_hash: posterEvidence });
    const workerEvTx = await call(worker, cfg, CONTRACT_ID, 'submit_evidence', { job_id: j.job_id, evidence_hash: workerEvidence });
    job = await waitForView(() => getJob(j.job_id), (x) => x.poster_evidence === posterEvidence && x.worker_evidence === workerEvidence, 'evidence hashes not recorded');
    expect(job.poster_evidence === posterEvidence, 'poster evidence hash not recorded');
    expect(job.worker_evidence === workerEvidence, 'worker evidence hash not recorded');
    console.log(`   disputed (tx ${disputeTx}); evidence hashes onchain (poster ${posterEvidence.slice(0, 12)}..., worker ${workerEvidence.slice(0, 12)}...)`);

    // DAO proposal: FunctionCall to resolve_dispute(pay_full). Anyone
    // may propose; the poster proposes and pays the 1 NEAR bond.
    const { members } = await daoCouncil();
    const nextIdRaw = await rpcView(cfg, DAO_ID, 'get_last_proposal_id', {});
    proposalId = Number(nextIdRaw);
    const callArgs = { job_id: j.job_id, outcome: j.dispute_outcome };
    const description = `Merit dispute ${j.job_id}: ${j.dispute_outcome} — criteria: ${j.criteria} | poster evidence ${posterEvidence} | worker evidence ${workerEvidence}`;
    const proposeTx = await call(poster, cfg, DAO_ID, 'add_proposal', {
      proposal: {
        description,
        kind: {
          FunctionCall: {
            receiver_id: CONTRACT_ID,
            actions: [{
              method_name: 'resolve_dispute',
              args: Buffer.from(JSON.stringify(callArgs)).toString('base64'),
              deposit: '0',
              gas: '100000000000000',
            }],
          },
        },
      },
    }, { deposit: DAO_BOND });
    const proposal = await waitForView(() => rpcView(cfg, DAO_ID, 'get_proposal', { id: proposalId }), (x) => x.status === 'InProgress', 'new proposal should be InProgress');
    expect(proposal.status === 'InProgress', `new proposal should be InProgress, got ${proposal.status}`);
    console.log(`   DAO proposal #${proposalId} created (tx ${proposeTx}), InProgress; council ${members.join(', ')}`);
    recordJob(j.job_id, {
      accept_tx: acceptTx, dispute_tx: disputeTx,
      poster_evidence_tx: posterEvTx, worker_evidence_tx: workerEvTx,
      poster_evidence_hash: posterEvidence, worker_evidence_hash: workerEvidence,
      proposal_id: proposalId, propose_tx: proposeTx, status: 'Disputed',
    });
    log.steps['11-dispute'] = {
      status: 'awaiting_manual_vote', started_at: new Date().toISOString(),
      proposal_id: proposalId, propose_tx: proposeTx,
      accept_tx: acceptTx, dispute_tx: disputeTx,
      poster_evidence_tx: posterEvTx, worker_evidence_tx: workerEvTx,
      poster_evidence_hash: posterEvidence, worker_evidence_hash: workerEvidence,
    };
    saveLog(cfg, log);

    // Joseph stand-in vote (the only council vote this script can cast).
    const voteTx = await call(joseph, cfg, DAO_ID, 'act_proposal', { id: proposalId, action: 'VoteApprove' });
    const afterOne = await waitForView(() => rpcView(cfg, DAO_ID, 'get_proposal', { id: proposalId }), (x) => x.status === 'InProgress', 'one vote must not pass the proposal (threshold 2)');
    expect(afterOne.status === 'InProgress', 'one vote must not pass the proposal (threshold 2)');
    const stillDisputed = await waitForView(() => getJob(j.job_id), (x) => x.status === 'Disputed', 'one vote must not execute the dispute');
    expect(stillDisputed.status === 'Disputed', 'one vote must not execute the dispute');
    console.log(`   Joseph stand-in voted Approve (tx ${voteTx}); 1 of 2 — proposal still InProgress, job still Disputed`);
    log.steps['11-dispute'].joseph_vote_tx = voteTx;
    log.steps['11-dispute'].votes_after_joseph = afterOne.vote_counts || null;
    saveLog(cfg, log);
  } else {
    console.log(`   resuming dispute: DAO proposal #${proposalId} already exists (Joseph vote recorded: ${existing.joseph_vote_tx ? 'yes' : 'unknown — see vote_counts'})`);
    const p = await rpcView(cfg, DAO_ID, 'get_proposal', { id: proposalId });
    if (p.status === 'Approved') {
      console.log('   proposal is already Approved — verifying the executed outcome below');
    } else if (p.status !== 'InProgress') {
      throw new Error(`proposal #${proposalId} is ${p.status}; a rejected proposal leaves the dispute open — propose a different outcome by hand, do not re-run this phase`);
    }
  }

  // MANUAL second vote: wait for it onchain, never fake it.
  const { members } = await daoCouncil();
  const manualVoters = members.filter((m) => m !== JOSEPH_ID);
  printManualVoteInstructions(proposalId, manualVoters);
  const timeoutMs = cfg.manual_vote_timeout_min * 60 * 1000;
  const pollMs = (cfg.manual_vote_poll_seconds || 30) * 1000;
  const start = Date.now();
  let lastPrinted = 0;
  while (Date.now() - start < timeoutMs) {
    const p = await rpcView(cfg, DAO_ID, 'get_proposal', { id: proposalId });
    if (p.status === 'Approved') {
      console.log(`   proposal #${proposalId} APPROVED (vote_counts ${JSON.stringify(p.vote_counts)}) — outcome executing`);
      const job = await getJob(j.job_id);
      expect(job.status === 'Completed', `dispute job should be Completed after pay_full, got ${job.status}`);
      const merit = await getMerit();
      const expectedWithdrawable = (95n * (nearToYocto(cfg.jobs.lend.payment_near) + nearToYocto(cfg.jobs.timeout.payment_near) + nearToYocto(j.payment_near)) / 100n).toString();
      expect(merit.balance_withdrawable === expectedWithdrawable, `withdrawable should be 2.375 NEAR, got ${yoctoToNear(merit.balance_withdrawable)}`);
      expect(merit.balance_retained === (5n * (nearToYocto(cfg.jobs.main.payment_near) + nearToYocto(cfg.jobs.lend.payment_near) + nearToYocto(cfg.jobs.timeout.payment_near) + nearToYocto(j.payment_near)) / 100n).toString(), `retained should be 0.225 NEAR, got ${yoctoToNear(merit.balance_retained)}`);
      const s = stampOf(merit, j.completion_stamp.skill);
      expect(!!s && s.level === j.completion_stamp.level, 'repair-welding completion stamp missing after DAO pay_full');
      const bal = await subBalance();
      expect(bal === N / 20n + nearToYocto(cfg.jobs.main.payment_near) + nearToYocto(cfg.jobs.lend.payment_near) + nearToYocto(cfg.jobs.timeout.payment_near) + nearToYocto(j.payment_near) - nearToYocto('1.9'), `sub-account should be 2.65 NEAR, got ${yoctoToNear(bal)}`);
      console.log(`   DISPUTE SETTLED pay_full: job Completed, withdrawable 2.375 / retained 0.225 NEAR, ${j.completion_stamp.skill} ${j.completion_stamp.level} issued, sub ${yoctoToNear(bal)} NEAR`);
      recordJob(j.job_id, { status: 'Completed', dao_proposal_id: proposalId });
      markStep(log, cfg, '11-dispute', {
        ...log.steps['11-dispute'],
        proposal_id: proposalId,
        final_proposal: p,
        sub_balance_yocto: bal.toString(),
        withdrawable_yocto: merit.balance_withdrawable, retained_yocto: merit.balance_retained,
        completion_stamp: s,
      });
      return;
    }
    if (p.status === 'Rejected') {
      log.steps['11-dispute'].status = 'proposal_rejected';
      log.steps['11-dispute'].final_proposal = p;
      saveLog(cfg, log);
      throw new Error(`proposal #${proposalId} was REJECTED by the council — the dispute stays open (no payment, no stamp). Either side may propose a different outcome (refund / partial) by hand; this script does not auto-repropose.`);
    }
    if (Date.now() - lastPrinted > 5 * 60 * 1000) {
      console.log(`   still waiting for the manual second vote on proposal #${proposalId} (${Math.round((Date.now() - start) / 60000)} min elapsed, ${cfg.manual_vote_timeout_min} min limit) ...`);
      lastPrinted = Date.now();
    }
    await sleep(pollMs);
  }
  log.steps['11-dispute'].status = 'awaiting_manual_vote';
  saveLog(cfg, log);
  console.log(`MANUAL VOTE NOT CAST within ${cfg.manual_vote_timeout_min} min. The log is saved; re-run "node scripts/demo.mjs --only 11" (or plain "node scripts/demo.mjs") to resume waiting — the proposal and the Joseph vote are already onchain.`);
  process.exitCode = 1;
}

// ---- Run ------------------------------------------------------------------
const run = {
  1: phase1, 2: phase2, 3: phase3, 4: phase4, 5: phase5, 6: phase6,
  7: phase7, 8: phase8, 9: phase9, 10: phase10, 11: phase11,
};
const order = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'];
for (const id of ONLY ? [ONLY] : order) {
  if (stepDone(log, { 1: '1-mint', 2: '2-refusal', 3: '3-pass-test', 4: '4-dao-stamp', 5: '5-kit', 6: '6-main-job', 7: '7-complete', 8: '8-withdraw', 9: '9-lend', 10: '10-timeout', 11: '11-dispute' }[id]) && id !== '11') {
    console.log(`SKIP phase ${id}: already done in the log`);
    continue;
  }
  if (id === '11' && stepDone(log, '11-dispute')) {
    console.log('SKIP phase 11: already done in the log');
    continue;
  }
  await run[id]();
  if (process.exitCode) break;
}

if (!process.exitCode) {
  const done = Object.values(log.steps).filter((s) => s.status === 'done').length;
  console.log(`\nDEMO OK — ${done}/11 phases done. Log: ${logPath(cfg).pathname}`);
  console.log('Next: node scripts/verify-demo.mjs');
}
