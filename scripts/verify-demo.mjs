// Verify pass for the Merit live demo. Runs AFTER scripts/demo.mjs,
// against the live deployed contract on testnet. Read-only: no keys
// needed beyond the accounts file (only for account ids, never
// printed), no transactions sent.
//
//   node scripts/verify-demo.mjs
//
// Two kinds of checks, counted separately:
//   live    — current onchain state (get_merit, get_job, sub-account
//             balance via view_account, DAO proposal state)
//   receipt — the demo log's own records (tx hashes present, refusal
//             texts recorded, per-phase expected numbers)
// Exits 0 when every check passes, 1 otherwise, printing
// "X live + Y receipt checks passed".
//
// Expected final numbers (derived from the log, not hardcoded):
//   completed jobs: main 2 + lend 0.5 + timeout 1 + dispute 1 = 4.5 NEAR
//   gross withdrawable 4.275, retained 0.225, withdrawn in phase 8: 1.9
//   final withdrawable 2.375 NEAR, retained 0.225 NEAR
//   sub-account: 0.05 init + 4.5 paid - 1.9 withdrawn = 2.65 NEAR
//   final stamps: merit-basics 1, welding 3, torch-work 1,
//   gate-welding 1, repair-welding 2 (level = sum = 8)
//   NOTE the DAO attestation (welding 2, issuer "Merit DAO") is
//   overwritten in live state by the job-1 completion stamp
//   (welding 3, "Job completion"): it is proven from the phase-4
//   receipt, not from live get_merit.
import fs from 'node:fs';
import {
  N,
  nearToYocto, yoctoToNear,
  loadConfig, loadAccounts, rpcView, rpcAccount, logPath, loadLog,
} from './demo-common.mjs';

const cfg = loadConfig();
const CONTRACT_ID = cfg.contract_id;
const DAO_ID = cfg.dao_id;
const TOKEN = cfg.token_id;
const SUB = `${TOKEN}.${CONTRACT_ID}`;
const accounts = loadAccounts(cfg);
const log = loadLog(cfg);
if (!log) throw new Error(`no demo log found at ${logPath(cfg).pathname} — run scripts/demo.mjs first`);

const results = [];
function check(kind, name, ok, detail = '') {
  results.push({ kind, name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${kind}] ${name}${detail ? `  (${detail})` : ''}`);
}
const live = (n, ok, d) => check('live', n, ok, d);
const receipt = (n, ok, d) => check('receipt', n, ok, d);

const getMerit = () => rpcView(cfg, CONTRACT_ID, 'get_merit', { token_id: TOKEN });
const getJob = (jobId) => rpcView(cfg, CONTRACT_ID, 'get_job', { job_id: jobId });
const stampOf = (merit, skill) => (merit.stamps || []).find((s) => s.skill === skill);
const txPresent = (v) => typeof v === 'string' && v.length >= 20;
const jobCfg = (key) => cfg.jobs[key];

try {
  // ---- Identity / deployment --------------------------------------
  const owner = await rpcView(cfg, CONTRACT_ID, 'get_owner', {});
  live('contract owner is the contract account', owner === accounts.contract.accountId, String(owner));
  const dao = await rpcView(cfg, CONTRACT_ID, 'get_dao', {});
  live('contract dao is the Merit DAO', dao === DAO_ID, String(dao));
  const walletInfo = await rpcView(cfg, CONTRACT_ID, 'get_wallet_info', {});
  live('wallet global contract deployed', walletInfo.deployed === true, JSON.stringify(walletInfo));
  live('wallet uses the global contract, not embedded', walletInfo.embedded === false, JSON.stringify(walletInfo));
  const token = await rpcView(cfg, CONTRACT_ID, 'nft_token', { token_id: TOKEN });
  live('nft_token owner is the worker', token.owner_id === accounts.worker.accountId, String(token.owner_id));

  // ---- Money: derive expectations from the log's job receipts -----
  const completedKeys = ['main', 'lend', 'timeout', 'dispute'];
  const completed = completedKeys.map((k) => ({
    key: k, cfg: jobCfg(k), logged: log.jobs?.[jobCfg(k).job_id],
  }));
  let paidTotal = 0n;
  for (const { key, cfg: j, logged } of completed) {
    const p = nearToYocto(j.payment_near);
    paidTotal += p;
    receipt(`job ${j.job_id} receipt: payment + Completed status recorded`,
      logged?.status === 'Completed' && logged?.payment_yocto === p.toString(),
      `logged status=${logged?.status} payment=${logged?.payment_yocto}`);
  }
  const withdrawn = BigInt(log.steps['8-withdraw']?.amount_yocto || '0');
  const grossWithdrawable = paidTotal * 9500n / 10000n;
  const expectedRetained = paidTotal - grossWithdrawable;
  const expectedWithdrawable = grossWithdrawable - withdrawn;
  const expectedSub = N / 20n + paidTotal - withdrawn;

  const merit = await getMerit();
  live('Merit is locked (has stamps)', merit.locked === true);
  live('Merit level is 8 (sum of stamp levels)', merit.level === 8, `level=${merit.level}`);
  live('withdrawable is 2.375 NEAR', merit.balance_withdrawable === expectedWithdrawable.toString(),
    `${yoctoToNear(merit.balance_withdrawable)} NEAR`);
  live('retained is 0.225 NEAR', merit.balance_retained === expectedRetained.toString(),
    `${yoctoToNear(merit.balance_retained)} NEAR`);
  live('withdrawable + retained equals paid minus withdrawn',
    BigInt(merit.balance_withdrawable) + BigInt(merit.balance_retained) === paidTotal - withdrawn);

  const sub = await rpcAccount(cfg, SUB);
  // NOTE: a sub-account using the global wallet contract reports the
  // EMPTY code_hash in view_account (its code is referenced by hash,
  // not stored on the account), so code_hash cannot prove the wallet
  // is attached. Prove it functionally: the wallet's get_parent must
  // return the Merit contract.
  const walletParent = await rpcView(cfg, SUB, 'get_parent', {});
  live('sub-account wallet is live (get_parent returns the Merit contract)', walletParent === CONTRACT_ID, String(walletParent));
  live('sub-account balance is 2.65 NEAR', BigInt(sub.amount) === expectedSub, `${yoctoToNear(sub.amount)} NEAR`);
  live('sub-account balance equals withdrawable + retained + 0.05 init',
    BigInt(sub.amount) === BigInt(merit.balance_withdrawable) + BigInt(merit.balance_retained) + N / 20n);
  live('lend is revoked (null) after expiry', merit.lend === null || merit.lend === undefined, JSON.stringify(merit.lend));

  // ---- Stamps (live) ----------------------------------------------
  const expectStamp = (skill, level, issuerName) => {
    const s = stampOf(merit, skill);
    live(`stamp ${skill} ${level} (${issuerName})`, !!s && s.level === level && s.issuer_name === issuerName,
      s ? `level=${s.level} issuer=${s.issuer_name}` : 'missing');
  };
  expectStamp('merit-basics', 1, 'Merit Test');
  expectStamp('welding', 3, 'Job completion');
  expectStamp('torch-work', 1, 'Job completion');
  expectStamp('gate-welding', 1, 'Job completion');
  expectStamp('repair-welding', 2, 'Job completion');
  const kitView = await rpcView(cfg, CONTRACT_ID, 'get_kit', { kit_token_id: cfg.kit.kit_token_id });
  live('kit welding torch is inside merit-1', kitView.inside_merit === TOKEN, JSON.stringify(kitView));
  live('get_merit kit list contains the torch', (merit.kit || []).includes(cfg.kit.kit_token_id));

  // ---- Jobs (live) -------------------------------------------------
  for (const key of ['main', 'lend', 'timeout', 'dispute']) {
    const j = jobCfg(key);
    const job = await getJob(j.job_id);
    live(`job ${j.job_id} is Completed`, job.status === 'Completed', `status=${job.status}`);
    live(`job ${j.job_id} payment is ${j.payment_near} NEAR`, job.payment === nearToYocto(j.payment_near).toString());
    live(`job ${j.job_id} accepted by merit-1`, job.accepted_by === TOKEN);
  }
  const refusalJob = await getJob(jobCfg('refusal').job_id);
  live('refusal job stayed Open (never accepted)', refusalJob.status === 'Open', `status=${refusalJob.status}`);
  const checkJob = await getJob(jobCfg('lend_check').job_id);
  live('lend-expiry check job stayed Open (never accepted)', checkJob.status === 'Open', `status=${checkJob.status}`);
  const disputeJob = await getJob(jobCfg('dispute').job_id);
  live('dispute job carries both evidence hashes',
    disputeJob.poster_evidence === log.jobs?.[jobCfg('dispute').job_id]?.poster_evidence_hash &&
    disputeJob.worker_evidence === log.jobs?.[jobCfg('dispute').job_id]?.worker_evidence_hash);
  const canAfter = await rpcView(cfg, CONTRACT_ID, 'can_access', {
    token_id: TOKEN, job_id: jobCfg('lend_check').job_id, account_id: accounts.poster.accountId,
  });
  live('delegate access is refused after lend expiry', canAfter === false);

  // ---- DAO proposal (live) -----------------------------------------
  const proposalId = log.steps['11-dispute']?.proposal_id;
  live('dispute proposal id recorded in the log', Number.isInteger(proposalId), String(proposalId));
  if (Number.isInteger(proposalId)) {
    const proposal = await rpcView(cfg, DAO_ID, 'get_proposal', { id: proposalId });
    live('DAO proposal is Approved', proposal.status === 'Approved', `status=${proposal.status}`);
    const counts = proposal.vote_counts || {};
    const approves = Object.values(counts).map((c) => Number(Array.isArray(c) ? c[0] : 0));
    const maxApproves = approves.length ? Math.max(...approves) : 0;
    live('proposal reached threshold: at least 2 Approve votes', maxApproves >= 2, `vote_counts=${JSON.stringify(counts)}`);
    const kind = proposal.kind?.FunctionCall;
    live('proposal calls resolve_dispute on the Merit contract',
      kind?.receiver_id === CONTRACT_ID && kind?.actions?.[0]?.method_name === 'resolve_dispute',
      JSON.stringify(kind || proposal.kind));
  }
  const policy = await rpcView(cfg, DAO_ID, 'get_policy', {});
  const council = (policy.roles || []).find((r) => r.name === 'council');
  const members = council?.kind?.Group || [];
  live('DAO council is the 3 expected members', members.length === 3 &&
    members.includes(accounts.joseph.accountId) &&
    members.includes('clearsite587.testnet') && members.includes('james54.testnet'),
    members.join(', '));
  const threshold = policy.default_vote_policy?.threshold;
  live('DAO vote threshold is 2', threshold === '2' || threshold === 2, JSON.stringify(threshold));

  // ---- Receipts -----------------------------------------------------
  const stepTx = (step, ...fields) => fields.some((f) => txPresent(log.steps[step]?.[f]));
  receipt('phase 1 mint tx recorded', stepTx('1-mint', 'tx'), log.steps['1-mint']?.tx || 'none');
  receipt('phase 1 sub-account balance 0.05 NEAR recorded',
    log.steps['1-mint']?.sub_balance_yocto === (N / 20n).toString());
  receipt('phase 2 refusal recorded with stamp error text',
    typeof log.steps['2-refusal']?.accept_failure === 'string' &&
    /does not satisfy|required stamp/i.test(log.steps['2-refusal'].accept_failure));
  receipt('phase 3 pass_test tx + merit-basics 1 (Merit Test) recorded',
    stepTx('3-pass-test', 'tx') && log.steps['3-pass-test']?.stamp?.issuer_name === 'Merit Test');
  receipt('phase 4 DAO stamp receipt: welding 2, issuer "Merit DAO"',
    stepTx('4-dao-stamp', 'tx') && log.steps['4-dao-stamp']?.stamp?.skill === 'welding' &&
    log.steps['4-dao-stamp']?.stamp?.level === 2 &&
    log.steps['4-dao-stamp']?.stamp?.issuer_name === 'Merit DAO');
  receipt('phase 5 kit mint + deposit txs recorded',
    stepTx('5-kit', 'mint_tx') && stepTx('5-kit', 'deposit_tx'));
  receipt('phase 6 main job create + accept txs recorded',
    stepTx('6-main-job', 'create_tx') && stepTx('6-main-job', 'accept_tx'));
  receipt('phase 7 completion tx + 1.9 / 0.1 split recorded',
    stepTx('7-complete', 'tx') &&
    log.steps['7-complete']?.withdrawable_yocto === (95n * nearToYocto('2') / 100n).toString() &&
    log.steps['7-complete']?.retained_yocto === (5n * nearToYocto('2') / 100n).toString());
  receipt('phase 8 withdraw tx + holder received ~1.9 NEAR recorded',
    stepTx('8-withdraw', 'tx') && BigInt(log.steps['8-withdraw']?.holder_delta_yocto || '0') > 189n * N / 100n);
  receipt('phase 9 lend, delegate accept/complete, expiry refusal, revoke txs recorded',
    stepTx('9-lend', 'lend_tx') && stepTx('9-lend', 'delegate_accept_tx') &&
    stepTx('9-lend', 'delegate_complete_tx') && stepTx('9-lend', 'revoke_tx') &&
    /neither the holder nor a live lend delegate/i.test(log.steps['9-lend']?.post_expiry_refusal || ''));
  receipt('phase 10 timeout release tx recorded',
    stepTx('10-timeout', 'release_tx') && stepTx('10-timeout', 'accept_tx'));
  receipt('phase 11 dispute, evidence, proposal + Joseph vote txs recorded',
    stepTx('11-dispute', 'dispute_tx') && stepTx('11-dispute', 'propose_tx') &&
    stepTx('11-dispute', 'joseph_vote_tx') &&
    typeof log.steps['11-dispute']?.poster_evidence_hash === 'string' &&
    typeof log.steps['11-dispute']?.worker_evidence_hash === 'string');
  receipt('phase 11 manual second vote recorded (not faked: proposal Approved onchain)',
    log.steps['11-dispute']?.status === 'done' && Number.isInteger(proposalId));
  receipt('all 11 phases done in the log',
    ['1-mint', '2-refusal', '3-pass-test', '4-dao-stamp', '5-kit', '6-main-job',
     '7-complete', '8-withdraw', '9-lend', '10-timeout', '11-dispute']
      .every((s) => log.steps[s]?.status === 'done'));
} catch (e) {
  console.log(`FAIL  [error] verify aborted: ${e.message}`);
  process.exit(1);
}

const livePassed = results.filter((r) => r.kind === 'live' && r.ok).length;
const liveTotal = results.filter((r) => r.kind === 'live').length;
const recPassed = results.filter((r) => r.kind === 'receipt' && r.ok).length;
const recTotal = results.filter((r) => r.kind === 'receipt').length;
console.log(`\n${livePassed} live + ${recPassed} receipt checks passed (${livePassed + recPassed}/${results.length} total).`);
if (livePassed !== liveTotal || recPassed !== recTotal) {
  for (const r of results.filter((r) => !r.ok)) console.log(`FAILED: [${r.kind}] ${r.name} ${r.detail}`);
  process.exit(1);
}
console.log('VERIFY-DEMO OK — live demo proven against onchain state.');
