// Deploy the Merit contract to testnet and initialise it.
// Run after create-accounts.mjs + create-dao.mjs:
//   node scripts/deploy.mjs
//
// Steps: deploy merit.wasm to the contract account, call
// new(owner_id, dao_id) with owner = the contract account itself
// and dao_id = the Merit DAO, publish the wallet once as a global
// contract (deploy_wallet_global), then verify get_dao and
// get_wallet_info. Writes merit-deploy-log.json (tx hashes +
// verified state; NO keys).
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { connect, keyStores, KeyPair } from 'near-api-js';

const RPC = 'https://rpc.testnet.near.org';
const ACCOUNTS_FILE = new URL('../.testnet-accounts.json', import.meta.url);
const WASM_FILE = new URL('../target/near/merit/merit.wasm', import.meta.url);
const WALLET_WASM_FILE = new URL('../target/near/merit_wallet/merit_wallet.wasm', import.meta.url);
const OUT = new URL('../merit-deploy-log.json', import.meta.url);

const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
const CONTRACT_ID = accounts.contract.accountId;
const DAO_ID = accounts.dao.accountId;

const wasm = fs.readFileSync(WASM_FILE);
const wasmSha256 = createHash('sha256').update(wasm).digest('hex');
const walletWasm = fs.readFileSync(WALLET_WASM_FILE);
const walletSha256 = createHash('sha256').update(walletWasm).digest('hex');
console.log(`merit wasm: ${wasm.length} bytes, sha256 ${wasmSha256}`);
console.log(`wallet wasm: ${walletWasm.length} bytes, sha256 ${walletSha256}`);

const keyStore = new keyStores.InMemoryKeyStore();
await keyStore.setKey('testnet', CONTRACT_ID, KeyPair.fromString(accounts.contract.privateKey));
const near = await connect({ networkId: 'testnet', nodeUrl: RPC, keyStore });
const account = await near.account(CONTRACT_ID);

console.log(`deploying merit wasm to ${CONTRACT_ID} ...`);
const deployOutcome = await account.deployContract(wasm);
console.log('deploy tx:', deployOutcome.transaction.hash);

console.log(`calling new(owner_id=${CONTRACT_ID}, dao_id=${DAO_ID}) ...`);
const initOutcome = await account.functionCall({
  contractId: CONTRACT_ID,
  methodName: 'new',
  args: { owner_id: CONTRACT_ID, dao_id: DAO_ID },
  gas: 100_000_000_000_000n,
  attachedDeposit: 0n,
});
console.log('init tx:', initOutcome.transaction.hash);

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
const walletCodeHash = createHash('sha256').update(walletWasm).digest('hex');
if (walletInfo.code_hash !== walletCodeHash) throw new Error(`wallet code hash mismatch: ${walletInfo.code_hash} vs ${walletCodeHash}`);
const balance = await account.getAccountBalance();

const log = {
  network: 'testnet',
  contract_id: CONTRACT_ID,
  dao_id: DAO_ID,
  owner: CONTRACT_ID,
  merit_wasm_bytes: wasm.length,
  merit_wasm_sha256: wasmSha256,
  wallet_wasm_bytes: walletWasm.length,
  wallet_wasm_sha256: walletSha256,
  wallet_deploy_method: 'global contract by code hash (deploy_wallet_global)',
  deploy_tx: deployOutcome.transaction.hash,
  init_tx: initOutcome.transaction.hash,
  deploy_wallet_global_tx: globalOutcome.transaction.hash,
  get_owner: owner,
  get_dao: dao,
  get_wallet_info: walletInfo,
  contract_balance_yocto: balance.total,
  deployed_at: new Date().toISOString(),
};
fs.writeFileSync(OUT, JSON.stringify(log, null, 2) + '\n');
console.log('DEPLOY OK:', CONTRACT_ID);
console.log('wrote merit-deploy-log.json');
