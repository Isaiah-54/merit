// Shared helpers for the Merit live demo (demo.mjs) and its verify
// pass (verify-demo.mjs). Testnet only. Keys are read from
// .testnet-accounts.json (chmod 600) and never printed, logged, or
// hardcoded. Account ids come from demo-config.json / the accounts
// file, never from literals in the scripts (except the two council
// members whose keys are NOT held, who are named only in the manual
// vote instructions, read live from the DAO policy).
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { connect, keyStores, KeyPair } from 'near-api-js';

export const N = 10n ** 24n;
export const GAS = 100_000_000_000_000n;
export const MINT_GAS = 150_000_000_000_000n;
export const DAO_BOND = N; // 1 NEAR Sputnik proposal bond
export const EMPTY_CODE_HASH = '11111111111111111111111111111111';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const nearToYocto = (s) => BigInt(Math.round(Number(s) * 1e6)) * (N / 1_000_000n);
export const yoctoToNear = (y) => (Number(BigInt(y)) / 1e24).toFixed(4);
export const sha256hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
export const nowNs = () => BigInt(Date.now()) * 1_000_000n;

export function loadConfig() {
  const path = new URL('../demo-config.json', import.meta.url);
  const cfg = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (!cfg.contract_id || !cfg.dao_id) throw new Error('demo-config.json must set contract_id and dao_id');
  return cfg;
}

export function loadAccounts(cfg) {
  const path = new URL(`../${cfg.accounts_file || '.testnet-accounts.json'}`, import.meta.url);
  let accounts;
  try {
    accounts = JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    throw new Error(
      `accounts file not found: ${path.pathname} — run scripts/create-accounts.mjs first (nothing is deployed yet, so the demo cannot run)`,
    );
  }
  for (const role of ['contract', 'dao', 'joseph', 'poster', 'worker']) {
    if (!accounts[role]?.accountId || !accounts[role]?.privateKey) {
      throw new Error(`accounts file is missing role "${role}" — run scripts/create-accounts.mjs first`);
    }
  }
  // The config is the source of truth for the ids; warn loudly if the
  // accounts file disagrees (e.g. deploy landed on a fallback name),
  // because signing with the wrong account would fail or misdirect.
  if (accounts.contract.accountId !== cfg.contract_id) {
    console.log(`NOTE config contract_id ${cfg.contract_id} != accounts file ${accounts.contract.accountId}; using config. Edit demo-config.json if the deploy used the other name.`);
  }
  if (accounts.dao.accountId !== cfg.dao_id) {
    console.log(`NOTE config dao_id ${cfg.dao_id} != accounts file ${accounts.dao.accountId}; using config. Edit demo-config.json if the deploy used the other name.`);
  }
  return accounts;
}

export async function accountFor(accounts, cfg, role) {
  const entry = accounts[role];
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey('testnet', entry.accountId, KeyPair.fromString(entry.privateKey));
  const near = await connect({ networkId: 'testnet', nodeUrl: cfg.rpc, keyStore });
  return near.account(entry.accountId);
}

// Raw RPC view call (no signing needed), same shape as smoke.mjs.
export async function rpcView(cfg, contractId, method, args) {
  const res = await fetch(cfg.rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'merit-demo', method: 'query',
      params: {
        request_type: 'call_function', finality: 'final', account_id: contractId,
        method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
      },
    }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`view ${method} on ${contractId} failed: ${JSON.stringify(j.error)}`);
  // A view that panics (e.g. get_job on a missing job) comes back
  // HTTP 200 with the error embedded in result.error and no result
  // bytes — without this check Buffer.from(undefined) throws a
  // misleading TypeError and the panic message is lost.
  if (j.result?.error) throw new Error(`view ${method} on ${contractId} failed: ${j.result.error}`);
  return JSON.parse(Buffer.from(j.result.result).toString('utf8'));
}

export async function rpcAccount(cfg, accountId) {
  const res = await fetch(cfg.rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'merit-demo-bal', method: 'query',
      params: { request_type: 'view_account', finality: 'final', account_id: accountId },
    }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`view_account ${accountId} failed: ${JSON.stringify(j.error)}`);
  return j.result; // { amount, locked, code_hash, storage_usage, ... }
}

export async function rpcBalance(cfg, accountId) {
  return BigInt((await rpcAccount(cfg, accountId)).amount);
}

// A signed call that must succeed. Returns the tx hash.
export async function call(signer, cfg, contractId, method, args, { gas = GAS, deposit = 0n } = {}) {
  const outcome = await signer.functionCall({
    contractId, methodName: method, args, gas, attachedDeposit: deposit,
  });
  return outcome.transaction.hash;
}

// A signed call that must FAIL onchain (a recorded refusal). Returns
// the failure text. Throws if the call unexpectedly succeeds.
export async function callExpectFail(signer, cfg, contractId, method, args, { gas = GAS, deposit = 0n } = {}) {
  try {
    const outcome = await signer.functionCall({
      contractId, methodName: method, args, gas, attachedDeposit: deposit,
    });
    const status = outcome?.status;
    if (status && typeof status === 'object' && status.Failure) {
      return JSON.stringify(status.Failure);
    }
    throw new Error(`UNEXPECTED SUCCESS: ${method} succeeded (tx ${outcome?.transaction?.hash}) but a refusal was expected`);
  } catch (e) {
    if (e.message.startsWith('UNEXPECTED SUCCESS')) throw e;
    return String(e.message || e);
  }
}

export function logPath(cfg) {
  return new URL(`../${cfg.log_file || 'merit-demo-log.json'}`, import.meta.url);
}

export function loadLog(cfg) {
  try {
    return JSON.parse(fs.readFileSync(logPath(cfg), 'utf8'));
  } catch {
    return null;
  }
}

// Save after every phase so a crash or a manual-vote wait never loses
// receipts. The log holds tx hashes, amounts and balances only.
// NEVER keys.
export function saveLog(cfg, log) {
  log.updated_at = new Date().toISOString();
  fs.writeFileSync(logPath(cfg), JSON.stringify(log, null, 2) + '\n');
}

export function newLog(cfg, accounts) {
  return {
    network: 'testnet',
    contract_id: cfg.contract_id,
    dao_id: cfg.dao_id,
    token_id: cfg.token_id,
    sub_account: `${cfg.token_id}.${cfg.contract_id}`,
    worker: accounts.worker.accountId,
    poster: accounts.poster.accountId,
    owner: accounts.contract.accountId,
    joseph_stand_in: accounts.joseph.accountId,
    started_at: new Date().toISOString(),
    steps: {},
    jobs: {},
  };
}

export function markStep(log, cfg, id, record) {
  log.steps[id] = { ...record, status: 'done', finished_at: new Date().toISOString() };
  saveLog(cfg, log);
}

export function stepDone(log, id) {
  return log?.steps?.[id]?.status === 'done';
}
