// Create the fresh Merit-only testnet accounts via the NEAR testnet
// helper faucet (10 testnet NEAR each). No other project's wallets,
// keys, or funds are involved.
//
//   node scripts/create-accounts.mjs
//
// Accounts:
//   contract — merit.testnet (fallbacks: merit-nft.testnet, merit-own.testnet)
//   dao      — merit-dao.testnet (the Merit DAO account)
//   joseph   — joseph-merit.testnet (fallbacks: joseph-merit-seat.testnet)
//              The Joseph council seat, held as a STAND-IN until Joseph
//              takes it over at launch (key handover then). Labelled
//              as such in every record.
//   poster   — merit-poster.testnet (demo poster)
//   worker   — merit-worker.testnet (demo worker / Merit holder)
//
// Keys are written ONLY to .testnet-accounts.json (chmod 600) and to
// ~/.near-credentials/testnet (near-cli layout). NEVER print or commit
// those files. clearsite587.testnet (Isaiah) and james54.testnet
// (James) are council members whose keys we do NOT hold — they are
// NOT created here and must never be signed for.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KeyPair } from 'near-api-js';

const RPC = 'https://rpc.testnet.near.org';
const HELPER = 'https://helper.testnet.near.org/account';
const OUT = new URL('../.testnet-accounts.json', import.meta.url);
const KEY_DIR = path.join(os.homedir(), '.near-credentials', 'testnet');

// Each role tries its names in order: the first name that is either
// already saved here or does not exist onchain yet.
const ACCOUNTS = [
  { role: 'contract', names: ['merit.testnet', 'merit-nft.testnet', 'merit-own.testnet'] },
  { role: 'dao', names: ['merit-dao.testnet'] },
  { role: 'joseph', names: ['joseph-merit.testnet', 'joseph-merit-seat.testnet'] },
  { role: 'poster', names: ['merit-poster.testnet'] },
  { role: 'worker', names: ['merit-worker.testnet'] },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpcView(accountId) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'merit-check', method: 'query',
      params: { request_type: 'view_account', finality: 'final', account_id: accountId },
    }),
  });
  return res.json();
}

// Persist keys to disk BEFORE any network call that depends on them,
// so a crash can never lose a key for a live account.
function saveProgress(out) {
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
  fs.mkdirSync(KEY_DIR, { recursive: true });
  for (const entry of Object.values(out)) {
    fs.writeFileSync(
      path.join(KEY_DIR, `${entry.accountId}.json`),
      JSON.stringify({ account_id: entry.accountId, public_key: entry.publicKey, private_key: entry.privateKey }, null, 2) + '\n',
      { mode: 0o600 },
    );
  }
}

async function waitVerified(accountId, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const check = await rpcView(accountId);
    if (check.result) return check.result;
    await sleep(5000);
  }
  return null;
}

const out = {};
try {
  Object.assign(out, JSON.parse(fs.readFileSync(OUT, 'utf8')));
} catch {
  // fresh file
}
for (const { role, names } of ACCOUNTS) {
  let done = false;
  for (const accountId of names) {
    if (out[role]?.accountId === accountId) {
      const check = await rpcView(accountId);
      if (check.result) {
        console.log(`SKIP ${accountId}: already created and key saved`);
        done = true;
        break;
      }
      // Saved but not onchain (stale record): fall through and create it.
    }
    const existing = await rpcView(accountId);
    if (existing.result) {
      console.log(`SKIP ${accountId}: already exists onchain (key not held here) — trying next name`);
      continue;
    }
    const keyPair = KeyPair.fromRandom('ed25519');
    const publicKey = keyPair.getPublicKey().toString();
    out[role] = { accountId, publicKey, privateKey: keyPair.toString() };
    saveProgress(out);
    console.log(`creating ${accountId} with ${publicKey} ...`);
    let lastText = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await fetch(HELPER, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: publicKey }),
      });
      lastText = await res.text();
      console.log(`helper HTTP ${res.status} (attempt ${attempt}): ${lastText.slice(0, 200)}`);
      if (res.ok) break;
      await sleep(5000);
    }
    const verified = await waitVerified(accountId);
    if (!verified) {
      throw new Error(`account ${accountId} not verified onchain after 90s (helper said: ${lastText.slice(0, 200)}). Key is saved in .testnet-accounts.json — retry verification before reusing the name.`);
    }
    console.log(`VERIFIED ${accountId}: balance ${verified.amount} yoctoNEAR`);
    done = true;
    await sleep(1000);
    break;
  }
  if (!done) throw new Error(`no usable name for role ${role} (tried: ${names.join(', ')})`);
}

saveProgress(out);
console.log('wrote .testnet-accounts.json (chmod 600) and ~/.near-credentials/testnet/*.json');
