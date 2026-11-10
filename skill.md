---
name: merit
description: Use Merit, the NEAR testnet NFT that carries earned credentials and opens doors only that proof can open. Mint a blank Merit, earn stamps, take gated jobs, withdraw from the Merit's own subaccount, lend access, and resolve disputes through the Merit DAO.
---

# Merit skill

## What Merit is

Merit is an NFT that carries earned credentials and opens doors only that proof can open. A blank Merit earns stamps by doing real things: passing a test, completing a job, being attested by a DAO. Its level is the sum of its stamp levels, computed onchain. Gates check the Merit's stamps. No stamp, no entry.

Five behaviours, all work based. The first three are earned through work, not through trading.

1. **Own money.** Each Merit owns its own real NEAR subaccount, `{token_id}.{contract}`, created at mint. Job payments land in it.
2. **Earn.** The Merit takes a 5% cut of every job it unlocks into its own account. On a 2 NEAR job, 1.9 NEAR is withdrawable and 0.1 NEAR stays retained.
3. **Hold inventory.** The Merit carries its own kit, tools tied to its credentials, held inside it as NFTs.
4. **Carry credentials.** Issuers stamp credentials onto it onchain. Only whitelisted issuers can stamp.
5. **Memberships and access.** Gates enforce access from its stamps onchain.

**Lock.** Once stamped, a Merit locks. It cannot be sold, because credentials cannot be bought. A blank Merit with no stamps can still transfer.

**Lend.** A locked Merit can be lent to another wallet until an onchain expiry. The delegate can open gates and do jobs, but cannot transfer the Merit and cannot withdraw its money. The holder can cancel a lend at any time.

**Disputes are DAO proposal and vote only.** There is no AI arbiter, no TEE verification, and no AI key anywhere in Merit. Never present any other dispute route.

## Status and accounts

Build complete. Ready to deploy. Not deployed. Not submitted. Testnet only.

Planned contract account: `merit-nft.testnet`. Planned DAO account: `merit-dao.testnet`. Both are planned, not live. The account `merit.testnet` already exists and belongs to someone else. The site config still carries the placeholder `merit.testnet` until the deploy wires the real id. Never claim a deployed id until the deploy log says so.

Lead: Isaiah. Merit is his second hackathon project. His other project is Genesis. Submission payout: `otoyo4real.near`, unless Isaiah says otherwise at submission time.

## Contract methods

Contract id is the placeholder until deploy. All amounts are in yoctoNEAR unless stated. Gas: use 100 TGas for ordinary calls, 150 TGas for `nft_mint`.

### Views

| Method | Args | Returns |
| --- | --- | --- |
| `nft_token` | `token_id` | Token record, or null |
| `nft_tokens` | `from_index`, `limit` | Token records |
| `nft_metadata` | | NFT metadata |
| `get_owner` | | Owner account |
| `get_dao` | | DAO account, the default arbiter |
| `is_issuer` | `account_id` | Whether the account is a whitelisted issuer |
| `list_issuers` | | Issuers with display names |
| `get_wallet_info` | | Wallet publish state and code hash |
| `get_merit` | `token_id` | Owner, stamps, level, withdrawable and retained balances, kit list, lend state |
| `can_access` | `token_id`, `job_id`, `account_id` | Whether that account can use that Merit for that job |
| `get_job` | `job_id` | Job record: poster, payment, required stamps, completion stamp, criteria, arbiter, status, evidence hashes, deadline |
| `list_jobs` | | All jobs |
| `get_kit` | `kit_token_id` | Kit record: name, owner, which Merit holds it, if any |

### Change methods

**Mint and transfer**

- `nft_mint(token_id, receiver_id, metadata?)`, 0.1 NEAR attached. Creates the token and its subaccount. Token id: 1 to 32 chars, lowercase letters, digits, and hyphens, never starting or ending with a hyphen. 0.05 NEAR goes into the new subaccount, 0.05 NEAR stays in the contract for storage. If subaccount creation fails, the minter is refunded and no token is left behind.
- `nft_transfer(receiver_id, token_id, approval_id?, memo?)`, exactly 1 yoctoNEAR attached. Owner only. Fails on a stamped Merit. Clears any active lend.

**Stamps**

- `stamp(token_id, skill, level)`, whitelisted issuer only. Level 1 to 3. Skill at most 64 chars. Stamping the same skill again updates its level, issuer and time. The first stamp locks the Merit. At most 64 distinct stamps per Merit.
- `pass_test(token_id, answer)`, holder only. The answer is `merit`. Stamps skill `merit-basics` at level 1, issuer the contract, display name `Merit Test`. Once per Merit. The answer is a demo test, not a secret.

**Jobs**

- `create_job(job_id, title, description, required_stamps, completion_stamp, criteria, timeout_ns?, arbiter?)`, payment attached in full, minimum 0.001 NEAR. Anyone may post. Job id 1 to 64 chars. Title 1 to 128 chars. Criteria is required, 1 to 2000 chars. `timeout_ns` is optional, default 7 days. `arbiter` is optional, a DAO account id, default the contract's DAO id. `required_stamps` is a list of `{skill, min_level}`, min level 1 to 3. `completion_stamp` is `{skill, level}`, level 1 to 3.
- `accept_job(job_id, token_id)`. Caller must hold the Merit or hold a live lend of it, and the Merit must satisfy the job's required stamps. Records the accept time; the deadline is accept time plus timeout.
- `complete_job(job_id, token_id)`, poster only, while the job is Accepted and not Disputed. Pays the escrow into the worker's Merit, 95% withdrawable and 5% retained, and issues the completion stamp.
- `release_job(job_id)`, anyone, after the deadline, while the job is Accepted and not Disputed. Same payout and stamp as a normal completion. Silence is not a dispute.

**Disputes**

- `raise_dispute(job_id)`, poster or worker, while the job is Accepted and before the deadline. The job becomes Disputed, which blocks `complete_job` and `release_job`.
- `submit_evidence(job_id, evidence_hash)`, poster or worker, while the job is Disputed. The hash is a 64 char lowercase hex SHA256 of the evidence bytes. Evidence itself stays offchain. Submitting again replaces the earlier hash.
- `resolve_dispute(job_id, outcome, partial_amount?)`, callable only by the job's recorded arbiter DAO. Any other caller is rejected. Outcomes: `pay_full` pays the full escrow to the worker's Merit, 95% withdrawable and 5% retained, and issues the completion stamp; `refund` returns the full escrow to the poster, no stamp; `partial` pays `partial_amount`, at most the escrow and above zero, to the worker's Merit, 95% withdrawable and 5% retained, refunds the remainder to the poster, no stamp. The first executed verdict wins. A rejected DAO proposal leaves the dispute open for a new proposal.

Proposal creation is a separate step, not automatic on `raise_dispute`. The disputer, or anyone, calls the DAO's `add_proposal` with a FunctionCall proposal to `resolve_dispute` carrying one proposed outcome. The proposal description carries the job id, the outcome, the criteria, and both sides' evidence hashes. Proposal bond is 1 NEAR. The council votes Approve or Reject, and the deciding vote executes the FunctionCall automatically.

**Money**

- `withdraw(token_id, amount)`, holder only. Pays from the Merit's own subaccount wallet to the holder. A lend delegate cannot withdraw. If the wallet payout fails, the parent restores the balance.

**Kit**

- `mint_kit(kit_token_id, name, receiver_id)`, whitelisted issuer only.
- `deposit_kit(token_id, kit_token_id)`, holder only. Caller must own the kit token, and the kit must not already sit inside a Merit.
- `withdraw_kit(token_id, kit_token_id)`, holder only. The tool stays owned by the same account, just no longer inside the Merit.

**Lend**

- `lend(token_id, to, expires_at)`, holder only. `expires_at` is a nanosecond timestamp in the future. The delegate can open gates and do jobs, but cannot transfer or withdraw.
- `revoke_lend(token_id)`, holder only. Cancels any active lend.

**Owner only**

- `deploy_wallet_global()`, once only. Publishes the wallet code as a global contract by code hash, about 1.14 NEAR of storage. Must run before the first mint.
- `set_use_embedded_wallet(use_embedded)`, fallback switch. When true, each mint deploys the wallet code into the subaccount instead of referencing the global contract.
- `add_issuer(account_id, name)`, `remove_issuer(account_id)`. The owner is seeded as an issuer at init with display name `Merit DAO`.
- `set_dao(dao_id)`. Changes the default arbiter for new jobs. Existing jobs keep their recorded arbiter.

### The subaccount wallet

Each subaccount runs a small wallet contract with `init(parent)` and `payout(receiver, amount)`. It pays only when the caller is the parent Merit contract, and it pays whoever the parent names. Never call the wallet directly as a user; always go through the parent contract's `withdraw`.

## The Merit DAO

Planned DAO: `merit-dao.testnet`, a Sputnik v2 DAO. Not deployed yet. Council of three, threshold 2, proposal bond 1 NEAR, proposal period 7 days.

- `clearsite587.testnet`, Isaiah, lead. Key not held by the build.
- `james54.testnet`, James54. Key not held by the build.
- `joseph-merit.testnet`, Joseph seat, stand in account. Joseph takes it over at launch through a key handover.

The live demo dispute vote needs Isaiah's tap on the site, or James's, as the second vote after the Joseph stand in vote. Do not invent a second vote and do not claim the dispute path ran live until it has.

## Demo flow

The demo has not run yet. The demo scripts are being written in parallel. The planned flow, all on testnet:

1. Mint a blank Merit.
2. Try to open a paid job and get refused onchain.
3. Pass the test and earn the `merit-basics` stamp.
4. Earn a DAO attestation stamp.
5. Deposit kit into the Merit.
6. Accept a paid job, now that the gates open.
7. The poster confirms completion. Payment lands in the Merit's subaccount: on a 2 NEAR job, 1.9 NEAR withdrawable and 0.1 NEAR retained. The completion stamp is issued.
8. Withdraw from the subaccount to the holder.
9. Lend the Merit to a second wallet and show access moving, then expiring.
10. A short timeout job releases on its own after its deadline on silence, paying the worker and issuing the stamp.
11. A dispute is resolved by DAO proposal and council vote.

The live smoke check that already exists is `scripts/smoke.mjs`: mint `merit-1`, stamp welding level 1, post a 1 NEAR job, accept, confirm, check the subaccount holds 0.05 NEAR init plus 1 NEAR payment, check `get_merit` shows 0.95 NEAR withdrawable and 0.05 NEAR retained plus the completion stamp, then withdraw 0.95 NEAR.

## How to use Merit

Build:

```sh
bash scripts/build.sh
```

Deploy, in order:

```sh
node scripts/create-accounts.mjs
node scripts/create-dao.mjs
node scripts/deploy.mjs
node scripts/smoke.mjs
```

`create-accounts.mjs` creates the fresh Merit only testnet accounts, 10 testnet NEAR each. `create-dao.mjs` deploys the Sputnik v2 DAO with the three member council and threshold 2. `deploy.mjs` deploys the Merit wasm, calls `new` with owner and DAO id, publishes the wallet once as a global contract, and verifies the result. `smoke.mjs` runs the live money path and writes `merit-smoke-log.json`. Each script writes a log file with transaction hashes and verified state, and no keys. Keys live only in `.testnet-accounts.json` at the repo root, chmod 600, and in `~/.near-credentials/testnet`. Never print or commit those files.

The full demo script is not written yet. Its file name and exact command will be added to the README once the demo scripts land.

The site lives in `site/`: mint, Merit detail with stamps, level, balance and kit, the jobs board, and lend. Update `site/config.js` with the deployed contract id before use. A headless verifier, `site/verify/verify.mjs`, passed 27 of 27 checks covering mint, Merit detail, the jobs board, and gate refusal rendering.

## Rules for agents

- Never claim Merit is deployed, the demo has run, or any live balance exists, until a deploy or demo log proves it. Mark planned work as planned.
- Never name other projects in Merit copy, and never claim Merit fills a gap no one else fills. Say what Merit does and let the demo do the comparing.
- Never invent a contract id, token id, balance, transaction hash, or vote. Read it from the contract, a log file, or the deploy output.
- Never connect a wallet or sign on the user's behalf. Show the real call with its attached deposit and wait for explicit approval.
- Keep visible prose free of hyphens and dashes. Use code spans for identifiers that contain them, such as token ids, account ids, and command names.
