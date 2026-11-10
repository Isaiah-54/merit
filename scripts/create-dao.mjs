// Create the Merit DAO at merit-dao.testnet (Sputnik v2).
// Direct deploy of the Sputnik v2 WASM (local file
// contract/tests/sputnik-v2.wasm, sha256
// 6e3f1814d40769d8f57b9a7af689d22aaab96d3232cec4d861311829c1d2318f).
// NOT the factory (a factory-created DAO is keyless; the deploy
// scripts sign as the DAO itself, so the DAO needs a key we hold).
//
// Council (3, threshold 2 = strict majority):
//   clearsite587.testnet — Isaiah (lead; key NOT held here)
//   james54.testnet      — James54 (key NOT held here)
//   joseph-merit.testnet — Joseph seat, STAND-IN until Joseph takes
//                          it over at launch (key handover then;
//                          key held here, see .testnet-accounts.json)
// Proposal bond 1 NEAR, period 7 days.
//
// Signing constraint: only the Joseph stand-in vote can be cast
// from here. The second vote to reach threshold 2 must come from
// Isaiah (site DAO voting UI, on his phone) or James54.
//
// Run: node scripts/create-dao.mjs
// Writes merit-dao-log.json (tx hashes + verified policy; NO keys).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { connect, keyStores, KeyPair } from 'near-api-js';

const RPC = 'https://rpc.testnet.near.org';
const HELPER = 'https://helper.testnet.near.org/account';
const ACCOUNTS_FILE = new URL('../.testnet-accounts.json', import.meta.url);
const WASM_FILE = new URL('../contract/tests/sputnik-v2.wasm', import.meta.url);
const OUT = new URL('../merit-dao-log.json', import.meta.url);
const KEY_DIR = path.join(os.homedir(), '.near-credentials', 'testnet');

const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
const DAO_ID = accounts.dao.accountId;
const JOSEPH_ID = accounts.joseph.accountId;
const MEMBERS = ['clearsite587.testnet', 'james54.testnet', JOSEPH_ID];
const THRESHOLD = '2'; // strict majority of 3

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpcView(accountId) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'merit-dao-check', method: 'query',
      params: { request_type: 'view_account', finality: 'final', account_id: accountId },
    }),
  });
  return res.json();
}

// The DAO account is created by scripts/create-accounts.mjs; its key
// must already be saved. Refuse to proceed without it.
const daoKey = accounts.dao.privateKey;
if (!daoKey) throw new Error('no key for the DAO account in .testnet-accounts.json — run create-accounts.mjs first');
const existing = await rpcView(DAO_ID);
if (!existing.result) throw new Error(`${DAO_ID} does not exist onchain — run create-accounts.mjs first`);
console.log(`${DAO_ID} exists onchain, balance ${existing.result.amount} yoctoNEAR`);

// Deploy the Sputnik v2 wasm from the local file (hash-checked).
const wasm = fs.readFileSync(WASM_FILE);
const wasmSha256 = createHash('sha256').update(wasm).digest('hex');
console.log(`DAO wasm: ${wasm.length} bytes, sha256 ${wasmSha256}`);
if (wasmSha256 !== '6e3f1814d40769d8f57b9a7af689d22aaab96d3232cec4d861311829c1d2318f') {
  throw new Error('local sputnik-v2.wasm hash mismatch — refusing to deploy');
}
if (!wasm.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d]))) {
  throw new Error('downloaded bytes are not a wasm module');
}

const keyStore = new keyStores.InMemoryKeyStore();
await keyStore.setKey('testnet', DAO_ID, KeyPair.fromString(daoKey));
const near = await connect({
  networkId: 'testnet',
  nodeUrl: RPC,
  walletUrl: 'https://testnet.mynearwallet.com/',
  helperUrl: 'https://helper.testnet.near.org',
  keyStore,
});
const account = await near.account(DAO_ID);

// Skip deploy if the DAO is already initialised (get_policy works).
let alreadyInit = false;
try {
  const p = await account.viewFunction({ contractId: DAO_ID, methodName: 'get_policy', args: {} });
  if (Array.isArray(p?.roles)) alreadyInit = true;
} catch { /* not initialised */ }

let deployTx = null;
let initTx = null;
if (alreadyInit) {
  console.log(`SKIP deploy+init: ${DAO_ID} already has a DAO policy`);
} else {
  console.log(`deploying ${wasm.length} bytes to ${DAO_ID} ...`);
  const deployOutcome = await account.deployContract(wasm);
  deployTx = deployOutcome.transaction.hash;
  console.log('deploy tx:', deployTx);

  const policy = {
    roles: [
      { name: 'all', kind: 'Everyone', permissions: ['*:AddProposal'], vote_policy: {} },
      {
        name: 'council',
        kind: { Group: MEMBERS },
        permissions: ['*:*'],
        vote_policy: {},
      },
    ],
    default_vote_policy: { weight_kind: 'RoleWeight', quorum: '0', threshold: THRESHOLD },
    proposal_bond: '1000000000000000000000000',
    proposal_period: '604800000000000',
    bounty_bond: '1000000000000000000000000',
    bounty_forgiveness_period: '86400000000000',
  };
  const initArgs = {
    config: {
      name: 'merit-dao',
      purpose: 'Merit DAO — judges Merit job disputes by council proposal and vote',
      metadata: '',
    },
    policy,
  };
  console.log(`calling new() with council ${MEMBERS.join(', ')} ...`);
  const initOutcome = await account.functionCall({
    contractId: DAO_ID,
    methodName: 'new',
    args: initArgs,
    gas: 100_000_000_000_000n,
    attachedDeposit: 0n,
  });
  initTx = initOutcome.transaction.hash;
  console.log('init tx:', initTx);
}

// Verify live: get_policy must show council = exactly the 3 members, threshold Weight 2.
async function viewPoll(methodName, args, pred, label, timeoutMs = 90000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = await account.viewFunction({ contractId: DAO_ID, methodName, args });
    if (pred(last)) return last;
    await sleep(3000);
  }
  throw new Error(`timed out waiting for ${label}; last view: ${JSON.stringify(last)}`);
}
const policyOut = await viewPoll('get_policy', {}, (v) => Array.isArray(v?.roles), 'get_policy');
console.log('get_policy:', JSON.stringify(policyOut).slice(0, 600));
const council = policyOut.roles.find((r) => r.name === 'council');
if (!council) throw new Error('no council role in DAO policy');
const group = council.kind?.Group;
if (!Array.isArray(group)) throw new Error('council role is not a Group');
const sortedGroup = [...group].sort();
const sortedMembers = [...MEMBERS].sort();
if (JSON.stringify(sortedGroup) !== JSON.stringify(sortedMembers)) {
  throw new Error(`council group mismatch: got ${JSON.stringify(sortedGroup)}, expected ${JSON.stringify(sortedMembers)}`);
}
const dvp = policyOut.default_vote_policy;
if (dvp?.threshold !== '2' && dvp?.threshold !== 2) {
  throw new Error(`vote threshold mismatch: got ${JSON.stringify(dvp)}, expected Weight 2`);
}
const config = await account.viewFunction({ contractId: DAO_ID, methodName: 'get_config', args: {} });
console.log('get_config:', JSON.stringify(config));
if (config.name !== 'merit-dao') throw new Error('DAO config name mismatch');
const daoBalance = await account.getAccountBalance();

const log = {
  network: 'testnet',
  dao_id: DAO_ID,
  dao_name: 'merit-dao',
  wasm_bytes: wasm.length,
  wasm_sha256: wasmSha256,
  deploy_tx: deployTx,
  init_tx: initTx,
  council: sortedGroup,
  council_notes: {
    'clearsite587.testnet': 'Isaiah (lead) — key NOT held here',
    'james54.testnet': 'James54 — key NOT held here',
    [JOSEPH_ID]: 'Joseph seat, STAND-IN until Joseph takes it over at launch (key handover then)',
  },
  vote_threshold: 'Weight 2 (2 of 3 council approvals pass a proposal)',
  config,
  dao_balance_yocto: daoBalance.total,
  created_at: new Date().toISOString(),
};
fs.writeFileSync(OUT, JSON.stringify(log, null, 2) + '\n');
console.log('DAO OK:', DAO_ID);
console.log('wrote merit-dao-log.json');
