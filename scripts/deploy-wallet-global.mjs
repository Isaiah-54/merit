// One-off completion of the contract deploy: publish the wallet as a
// global contract (deploy_wallet_global) and verify. Used because the
// first deploy.mjs run deployed + initialised the contract fine but the
// wallet step failed on storage funds; the contract is now funded.
// Do NOT re-run deploy.mjs (new() would fail: already initialised).
// Writes merit-deploy-log.json with all three tx hashes.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { connect, keyStores, KeyPair } from 'near-api-js';

const RPC = 'https://rpc.testnet.near.org';
const ACCOUNTS_FILE = new URL('../.testnet-accounts.json', import.meta.url);
const WALLET_WASM_FILE = new URL('../target/near/merit_wallet/merit_wallet.wasm', import.meta.url);
const OUT = new URL('../merit-deploy-log.json', import.meta.url);

const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
const CONTRACT_ID = accounts.contract.accountId;
const DAO_ID = accounts.dao.accountId;
const DEPLOY_TX = 'F6VrR4SUyBT6tx58yXd42sWKeRhD2DMCs3EJrja9kExq';
const INIT_TX = 'LHjjMBgnKP18x3wyA7SqRfugpB2r1QbVou4RS27Nh6M';
const FAILED_WALLET_TX = '3JeSM7fWbHnuUsTuFEHcWvx1tEyPjYdge5s5WvFvva3e';

const walletWasm = fs.readFileSync(WALLET_WASM_FILE);
const walletSha256 = createHash('sha256').update(walletWasm).digest('hex');
console.log(`wallet wasm: ${walletWasm.length} bytes, sha256 ${walletSha256}`);

const keyStore = new keyStores.InMemoryKeyStore();
await keyStore.setKey('testnet', CONTRACT_ID, KeyPair.fromString(accounts.contract.privateKey));
const near = await connect({ networkId: 'testnet', nodeUrl: RPC, keyStore });
const account = await near.account(CONTRACT_ID);

const pre = await account.viewFunction({ contractId: CONTRACT_ID, methodName: 'get_wallet_info', args: {} });
console.log('get_wallet_info before:', JSON.stringify(pre));
if (pre.deployed) throw new Error('wallet global contract already deployed — refusing to re-run');

console.log('publishing the wallet as a global contract (deploy_wallet_global) ...');
const globalOutcome = await account.functionCall({
  contractId: CONTRACT_ID,
  methodName: 'deploy_wallet_global',
  args: {},
  gas: 100_000_000_000_000n,
  attachedDeposit: 0n,
});
console.log('deploy_wallet_global tx:', globalOutcome.transaction.hash);

const owner = await account.viewFunction({ contractId: CONTRACT_ID, methodName: 'get_owner', args: {} });
const dao = await account.viewFunction({ contractId: CONTRACT_ID, methodName: 'get_dao', args: {} });
const walletInfo = await account.viewFunction({ contractId: CONTRACT_ID, methodName: 'get_wallet_info', args: {} });
console.log('get_owner:', owner);
console.log('get_dao:', dao);
console.log('get_wallet_info:', JSON.stringify(walletInfo));
if (owner !== CONTRACT_ID) throw new Error(`owner mismatch: ${owner}`);
if (dao !== DAO_ID) throw new Error(`dao mismatch: ${dao}`);
if (!walletInfo.deployed) throw new Error('wallet global contract not deployed');
if (walletInfo.embedded) throw new Error('wallet should use the global contract, not embedded');
if (walletInfo.code_hash !== walletSha256) throw new Error(`wallet code hash mismatch: ${walletInfo.code_hash} vs ${walletSha256}`);
const balance = await account.getAccountBalance();
const issuers = await account.viewFunction({ contractId: CONTRACT_ID, methodName: 'list_issuers', args: { from_index: '0', limit: 50 } });
console.log('list_issuers:', JSON.stringify(issuers));

const log = {
  network: 'testnet',
  contract_id: CONTRACT_ID,
  dao_id: DAO_ID,
  owner: CONTRACT_ID,
  merit_wasm_bytes: 482654,
  merit_wasm_sha256: '9801e2a8b17092be27cf65f197860426149dd03f9aac304dc2f9d222304ebaf6',
  wallet_wasm_bytes: walletWasm.length,
  wallet_wasm_sha256: walletSha256,
  wallet_deploy_method: 'global contract by code hash (deploy_wallet_global)',
  deploy_tx: DEPLOY_TX,
  init_tx: INIT_TX,
  deploy_wallet_global_tx: globalOutcome.transaction.hash,
  deploy_wallet_global_first_attempt_tx: FAILED_WALLET_TX,
  deploy_wallet_global_first_attempt: 'FAILED LackBalanceForState (storage shortfall 11.3927 NEAR); contract funded with 13 NEAR from joseph-merit (6.5) + merit-worker (6.5), then retried',
  get_owner: owner,
  get_dao: dao,
  get_wallet_info: walletInfo,
  list_issuers: issuers,
  contract_balance_yocto: balance.total,
  deployed_at: new Date().toISOString(),
};
fs.writeFileSync(OUT, JSON.stringify(log, null, 2) + '\n');
console.log('DEPLOY OK:', CONTRACT_ID);
console.log('wrote merit-deploy-log.json');
