The NFT that proves what you can do.

Credentials you earn. Doors only proof can open.

## What Merit is

Merit is an NFT that carries earned credentials and opens doors only that proof can open. You mint a blank Merit. You earn stamps on it by doing real things: passing a test, completing a job, being attested by a DAO. Your Merit computes its level from those stamps, onchain. A paid job, a bounty, a DAO role or a gated room checks your Merit, not your wallet history and not a PDF. No stamp, no entry. And your Merit owns its own account, so the money your work earns lands in the Merit itself.

## The five behaviours

All five are work based. The first three are earned through work, not through trading.

### 1. Own money

Each Merit owns its own real NEAR subaccount, created when the Merit is minted. Job payments land in the Merit's own account, and the holder withdraws from it. The money comes from work the credentials unlock, not from gifts or speculation. The NFT earns by doing.

### 2. Earn

The Merit earns by working. Every time its stamps unlock a job, the Merit keeps 5% of that job's pay in its own account. That 5% is the Merit's royalty: not a resale royalty, a working royalty. A stamped Merit locks and cannot be sold, so there is no resale to take a cut from and no resale royalty to pay. Instead the NFT earns each time its credentials open a door. The work is the royalty. On a 2 NEAR job, 1.9 NEAR is withdrawable by the holder and 0.1 NEAR stays retained in the Merit, earned by unlocking that job. The retained balance is spendable on kit: the holder buys a named tool with it through `buy_kit` at 0.1 NEAR a tool, and the tool lands in the Merit. The demo Merit spent 0.1 NEAR of its retained balance this way, on a Demo Hammer.

### 3. Hold inventory

The Merit carries its own kit: the specific tools tied to its credentials. Each tool is a record in the Merit contract itself, not a separate NFT: an issuer mints a named tool to an account, and the holder deposits it into a Merit they hold. The account keeps owning the tool while it sits inside the Merit, and can take it back out at any time. The holder can also buy a tool with the Merit's retained balance through `buy_kit`: the price is fixed at 0.1 NEAR, read live from `kit_price`, the tool lands in the Merit, and the seller is paid that 0.1 NEAR from the Merit's own subaccount through its wallet. The kit is the visible proof of what the credential certifies the holder to use. The job gate is the stamp, not the kit: removing a tool takes it out of the Merit, but it does not close a job the stamps already unlock. The demo deposits a named Welding torch into merit-2, the tool for its welding credential, and later buys a named Demo Hammer with retained balance, and the Merit page shows both by name.

### 4. Carry credentials

Stamps are the heart of Merit. An issuer stamps a credential onto the Merit onchain, bound to the token, with skill, level, issuer account and issuer display name recorded. Only named issuers on the whitelist can stamp. The Merit computes its level from its stamps, onchain: the level is the sum of its stamp levels. Stamps are the proof, and they travel with the token.

### 5. Memberships and access

Access is enforced by the Merit itself. A paid job, a bounty, a DAO role or a gated room checks the Merit's stamps onchain. No stamp, no entry. Membership is not a chat invite or a role in a server. It is a gate the Merit either opens or does not.

## Status

Deployed and demoed live on testnet. Not submitted yet.

Contract: `merit-nft.testnet` (deploy tx `F6VrR4SUyBT6tx58yXd42sWKeRhD2DMCs3EJrja9kExq`, redeployed with the audit fix on 2026-11-10, deploy tx `8JyZd3JhPmZZgbJwnDgqQAka8LhpBV1X76J7rZRHbvGg`, state preserved). DAO: `merit-dao.testnet` (Sputnik v2, deploy tx `7vro3VpcRqWrSLShhHvawhzUyB5KrbSVANaDqm4pvoRm`). The account `merit.testnet` belongs to someone else, so Merit deploys as `merit-nft.testnet`. The site is wired to the live contract and DAO ids.

Hackathon deadline: 14 November 2026, 23:59 UTC. Testnet only.

## Try it yourself (no build needed)

Everything below uses the live site and the live testnet contracts. You do not need to build, deploy, or ask anyone anything.

Live site: https://merit-black.vercel.app/

1. Open the live site → you see the home page, the six-step journey (Mint, Pass the test, Earn a stamp, Take a job, Get paid, Withdraw), and the Merits minted so far (7 at the time of writing).
2. Open merit-2 → you see Level 8, five stamps (merit-basics 1, welding 3, torch-work 1, gate-welding 1, repair-welding 2), sub-account balance 2.550 NEAR, withdrawable 2.375 NEAR, retained 0.125 NEAR, mint deposit 0.050 NEAR. The three money lines add up to the balance. Its kit holds two named tools, a Welding torch and a Demo Hammer, the second bought with retained balance.
3. Open Jobs → you see 4 open offers, 7 completed jobs, 4 cancelled jobs and 1 refunded job. Type "logo" in the search → you see "Showing 1 of 4" (Design a logo only). Each offer card leads with "Pay: X NEAR · held in escrow".
4. Open Badges → you see 6 held badges with their level explanations and "Held by" lists, plus 3 earnable badges (design, writing, data-entry), each naming the job that earns it and marked "Not held yet".
5. Open the DAO → you see proposal #0, APPROVED 2-0, outcome "Pay in full and issue the stamp", 1.0 NEAR paid to merit-2, and proposal #1, APPROVED 2-0, outcome "Refund", 0.01 NEAR back to the poster and no stamp. No proposals are open.
6. To try the flow yourself, connect a NEAR testnet wallet and mint a blank Merit for 0.1 NEAR → you see a blank Merit, level 0, no stamps, with its own sub-account. Pass the test with the answer `merit` → you see the merit-basics stamp at level 1 and the Merit locks. Take a job your stamps unlock → the job is assigned to your Merit. When the poster confirms completion (or the deadline passes with no dispute) → the payment lands in your Merit's sub-account, 95% withdrawable and 5% retained, and the completion stamp is issued. Withdraw → the withdrawable NEAR moves to your wallet.

To verify any of it onchain, the contract is `merit-nft.testnet` and the DAO is `merit-dao.testnet`. Every step above is a real onchain read or transaction; nothing is mocked.

## Reproduce the full demo (one command)

The 11-step demo that produced the numbers above is a script you can run yourself. It mints a blank Merit, gets refused on a gated job, earns two stamps, deposits kit, takes a paid job, gets paid, withdraws, lends, hits a timeout, and resolves a dispute through the DAO. Every step is a real onchain transaction, and the verifier checks the result against the chain.

```sh
git clone https://github.com/Isaiah-54/merit.git
cd merit
bash scripts/run-demo.sh
```

That is the whole command. It installs dependencies if needed, runs all 11 phases, then runs the verifier. A pass looks like this at the end:

```text
50 live + 21 receipt checks passed (71/71 total).
== DEMO PASSED: all 11 phases ran and the verifier passed (expect 71/71) ==
```

If it stops partway, resume one phase with:

```sh
bash scripts/run-demo.sh --only 11
```

(replace 11 with the phase number 1-11). To start over from scratch:

```sh
bash scripts/run-demo.sh --fresh
```

Two things to know: the demo needs the demo accounts and the deployed contract (the script stops and tells you the exact setup commands if they are missing), and phase 11 needs a manual second DAO vote — the script cannot sign for Isaiah or James, so it waits onchain for that vote (up to 30 minutes) and then continues. The vote is real and recorded onchain, never faked.

## Lead and the other project

Lead: Isaiah.

Merit is Isaiah's second hackathon project. His other project is Genesis, and this README names Genesis as the other project, as the hackathon rule requires: the two projects are independent and each README names the other. Submission payout: `otoyo4real.near`, unless Isaiah says otherwise at submission time.

## Lock and lend

Two rules keep Merit honest.

**Lock.** Once a Merit earns its first stamp it locks. It cannot be sold, because credentials cannot be bought. A buyer cannot purchase a record they did not earn. A blank Merit with no stamps can still transfer. A transfer clears any active lend.

**Lend.** A locked Merit can be lent. The holder delegates its access to another wallet until an onchain expiry, and the delegation expires onchain. The delegate can open gates and do jobs, but cannot transfer the Merit and cannot withdraw its money. Proof stays honest and access stays flexible. You can let someone borrow your record without giving it away. The holder can cancel a lend at any time.

## The subaccount wallet

Each mint creates `{token_id}.{contract}`, a real NEAR account running a small wallet contract. The wallet contract has two methods: `init(parent)` and `payout(receiver, amount)`. It pays only when the caller is the parent Merit contract, and it pays whoever the parent names. Job payments are plain transfers into the subaccount. Withdraw works as a contract to contract call: the holder calls `withdraw` on the parent, the parent calls `payout(holder, amount)` on the wallet, and if the payout fails the parent restores the balance in a callback, so a failed payout never loses money.

The wallet code is published once as a global contract by code hash, through `deploy_wallet_global`, owner only, one time, at about 1.14 NEAR of storage. Every subaccount then references that code hash instead of carrying its own copy. The wallet wasm is 113,927 bytes, SHA256 `080cc3f9d475ff0355dfbe156fd47e3255dcbabab830c38b2a4b03b3dafce6e7`.

Mint costs 0.1 NEAR: 0.05 NEAR goes into the new subaccount and 0.05 NEAR stays in the contract for token storage. The deposit must be exactly 0.1 NEAR: overpayment and underpayment are both rejected, so a mint can never silently keep extra funds. The token record is written only once the subaccount and wallet exist, so a failed subaccount creation never leaves an orphan token; the 0.1 NEAR is refunded to the minter instead.

## How jobs work

1. Someone posts a job on Merit's board with the work, the payment locked in escrow in the contract, the stamp requirement, and clear acceptance criteria. The payment is the attached deposit in full. Minimum job payment is 0.001 NEAR. The description holds at most 2000 characters and the job asks for at most 10 required stamps. The completion stamp must name a skill from the DAO governed registry (see Issuers and stamps below); a job naming an unregistered skill is rejected at posting.
2. The holder browses the board. Each job shows its requirement and which jobs their Merit unlocks. The gate check happens onchain. The board reads jobs in pages of at most 50.
3. The holder takes a job their stamps unlock, in one transaction. The job is now assigned to their Merit.
4. The holder does the work.
5. The poster confirms completion onchain. That confirmation is the trust point: the poster must say the work is done. Completing the job pays the escrow into the Merit's own account, 95% withdrawable and 5% retained, and issues the job's completion stamp, which raises the Merit's level and unlocks bigger jobs.

A poster can cancel a job nobody has taken yet. `cancel_job` is poster only and Open jobs only: the job is marked Cancelled before the refund is sent, the exact escrow goes back to the poster, and if the refund fails the job records the refund as pending and the poster retries it with `retry_cancel_refund`. The demo cancelled its two stuck Open jobs this way and recovered both 0.01 NEAR escrows in full.

## Poster timeout

Every job has a timeout, set at posting, default 7 days. Accepting a job records the accept time, and the deadline is accept time plus timeout. If the poster never confirms and never disputes, anyone may call `release_job` after the deadline. The escrow pays the worker's Merit, 95% withdrawable and 5% retained, and the completion stamp is issued too, because the work stands unchallenged. Silence is not a dispute.

## Issuers and stamps

Only whitelisted issuers stamp. Stamps store skill, level 1 to 3, issuer account, issuer display name, and stamp time. Issuer control is DAO only: `add_issuer` and `remove_issuer` accept calls only from the Merit DAO itself, so no single account can grant itself stamping power. The owner is seeded as an issuer at init with the display name "Merit DAO". Stamping the same skill again updates its level, issuer and time. A Merit holds at most 64 distinct stamps, and completion stamps count toward that cap too.

A stamp can be revoked with `revoke_stamp`, by the DAO or by the issuer that issued it. Revoking removes the stamp from the Merit, but the lock stays once earned: a Merit that has ever held a stamp stays locked and cannot be sold, because the record was earned even if one stamp is later taken away.

### Completion skill registry

Job completion stamps come only from a registry of skills the DAO governs. The registry holds 9 skills: welding, torch-work, gate-welding, repair-welding, merit-basics, coding, design, writing, data-entry. The DAO adds and removes skills with `add_completion_skill` and `remove_completion_skill`, and anyone reads the list with `list_completion_skills`. A job whose completion stamp names a skill outside the registry is rejected at posting, so no poster can award an arbitrary credential by posting a job. On the site, an unregistered skill is never sent to `create_job`: the form offers a one-tap "Request this job type" that creates a DAO proposal to add the skill, and the skill is usable only after the DAO council approves it. The demo jobs earn welding, torch-work, gate-welding and repair-welding; the online jobs earn coding, design, writing and data-entry.

The demo test is built in: `pass_test` with the answer `merit` stamps skill `merit-basics` at level 1. The issuer is the contract itself, with display name "Merit Test". The answer is a demo test, not a secret, and the test is demo only: it proves the stamping path works, it is not a real assessment and the merit-basics stamp is not a real credential. Each Merit can pass the test once.

## Disputes: DAO proposal and vote only

There is no AI arbiter, no TEE verification, and no AI key anywhere in Merit. A dispute is judged by the Merit DAO, by proposal and vote.

Each job is arbitrated by the Merit DAO, always. There is no arbiter field on a job and no poster chosen arbiter: `create_job` takes no arbiter parameter, and the contract records the DAO id on every job. The contract stores the DAO id at init, and the owner can change it with `set_dao`. Every job must carry acceptance criteria at posting, non empty and at most 2000 characters. The council can only judge fairly against what was written, so clear criteria at posting matter.

The dispute flow:

1. `raise_dispute`, by the poster or the worker, while the job is Accepted and before the deadline. The job becomes Disputed, which blocks `complete_job` and `release_job`. Nothing moves until the dispute is resolved.
2. `submit_evidence`, by the poster or the worker, while the job is Accepted or Disputed. Each side records a SHA256 hash of its evidence, and may also store a content reference alongside the hash, such as a link or a content id, so the council can find the exact evidence each side submitted. The evidence itself stays offchain, only the hash and the reference are recorded. The DAO page shows the reference as a View evidence link and verifies the hash against the linked content. A side may submit again; the latest hash and reference count.
3. Proposal creation is a separate step, not automatic when a dispute is raised. The disputer, or anyone, calls the DAO's `add_proposal` with a FunctionCall proposal to `resolve_dispute` carrying one proposed outcome. The proposal description carries the job id, the outcome, the criteria, and both sides' evidence hashes. Proposal bond is 1 NEAR.
4. The council votes Approve or Reject. The deciding vote executes the FunctionCall automatically. `resolve_dispute` is callable only by the Merit DAO; any other caller is rejected.
5. Outcomes: `pay_full` pays the full escrow to the worker's Merit, 95% withdrawable and 5% retained, and issues the completion stamp. `refund` returns the full escrow to the poster, with no stamp. `partial` pays an arbiter set amount, at most the escrow and above zero, to the worker's Merit, 95% withdrawable and 5% retained, refunds the remainder to the poster, and issues no stamp.
6. The first executed verdict wins. A rejected proposal leaves the dispute open for a new proposal with a different outcome.

## The Merit DAO

DAO account: `merit-dao.testnet` (Sputnik v2, deployed). The dispute in the live demo was decided here: proposal #0 passed 2-0 and executed.

Council of three, threshold 2, a strict majority. Proposal bond 1 NEAR. Proposal period 7 days.

| Seat | Account | Note |
| --- | --- | --- |
| Isaiah, lead | `clearsite587.testnet` | Key not held by the build |
| James54 | `james54.testnet` | Key not held by the build |
| Joseph seat | `joseph-merit.testnet` | Stand in account. Joseph takes it over at launch through a key handover |

Signing constraint: the build holds no keys for `clearsite587.testnet` or `james54.testnet`. In the live demo, the dispute vote needs Isaiah's tap on the site, or James's, as the second vote after the Joseph stand in vote.

## The demo

The demo ran live on testnet on 2026-11-10 and verified 71 of 71 checks (50 live reads plus 21 receipt checks, `scripts/verify-demo.mjs`, log `merit-demo-log.json`). The full flow, all on testnet, with every step a real onchain transaction:

1. Mint a blank Merit.
2. Try to open a paid job and get refused onchain.
3. Pass the test and earn the `merit-basics` stamp.
4. Earn a DAO attestation stamp.
5. Deposit kit into the Merit: a named Welding torch, the tool for the welding credential, recorded in the contract and held inside merit-2.
6. Accept a paid job, now that the gates open.
7. The poster confirms completion. Payment lands in the Merit's subaccount: on a 2 NEAR job, 1.9 NEAR withdrawable and 0.1 NEAR retained. The completion stamp is issued.
8. Withdraw from the subaccount to the holder.
9. Lend the Merit to a second wallet and show access moving, then expiring.
10. A short timeout job auto releases on silence after its deadline, paying the worker and issuing the stamp.
11. A dispute is resolved by DAO proposal and council vote.
12. Audit fix pass: cancel the two stuck Open jobs and recover both escrows, buy a Demo Hammer with retained balance, and verify the evidence reference on a fresh test job.

Outcome: `merit-2` finished level 8 and locked, holding 5 stamps (`merit-basics` 1, `welding` 3, `torch-work` 1, `gate-welding` 1, `repair-welding` 2) and carrying two named tools in its kit, a Welding torch and a Demo Hammer. Its subaccount holds 2.55 NEAR, of which 2.375 NEAR is withdrawable and 0.125 NEAR is retained by Merit. That retained 0.125 NEAR is what is left of the 0.225 NEAR the Merit earned by working, 5% of each of the four paid jobs its stamps unlocked, after spending 0.1 NEAR of it on the Demo Hammer. Four paid jobs totalled 4.5 NEAR. The dispute job was resolved by DAO proposal #0, which passed 2-0 and executed `pay_full` with the `repair-welding` stamp issued. The two jobs that stayed Open after the demo, the refusal gate and the lend expiry check, were cancelled by the poster in step 12 and their 0.01 NEAR escrows refunded in full. The evidence reference check left one fresh test job, `audit-evidence-ref`, Disputed on purpose, with both sides' references stored onchain. It has since been resolved: DAO proposal #1 passed 2-0 and executed `refund`, returning its 0.01 NEAR escrow to the poster with no stamp issued. The redeploy also left its own smoke artefacts onchain: token `audit-smoke`, jobs `audit-cancel-1` (Cancelled) and `audit-smoke-job` (Completed), and kit `audit-torch`.

The live smoke check that already exists is `scripts/smoke.mjs`. It mints `merit-1`, stamps welding level 1, posts a 1 NEAR job, accepts, confirms, then checks the subaccount balance is 0.05 NEAR init plus 1 NEAR payment, `get_merit` shows 0.95 NEAR withdrawable and 0.05 NEAR retained plus the completion stamp, and the worker withdraws 0.95 NEAR, leaving 0.05 NEAR init plus 0.05 NEAR retained in the subaccount.

## Build evidence

Reproducible build, from `scripts/build.sh`: build the wallet, copy it into `contract/src/wallet.wasm`, build the main contract, run the unit tests.

```sh
cargo near build non-reproducible-wasm
```

Build command for the full sequence:

```sh
bash scripts/build.sh
```

Verified build output:

| Artifact | Size | SHA256 |
| --- | --- | --- |
| Main contract wasm | 539,762 bytes | `3b6a2baa1309ae7eebf697609eca6ad077b5678af93ac3792c2742a9d7e41314` |
| Wallet contract wasm | 113,927 bytes | `080cc3f9d475ff0355dfbe156fd47e3255dcbabab830c38b2a4b03b3dafce6e7` |

Tests: unit tests 18 of 18 pass. Integration tests 27 of 27 pass, run in a near workspaces sandbox, including 4 tests against a real Sputnik v2 DAO contract covering the dispute proposal and vote paths.

Site: `site/` in this repo. A headless verifier pass, `site/verify/verify.mjs`, passed 180 of 180 checks covering mint, Merit detail, the jobs board, and gate refusal rendering. The site config is wired to the live contract id `merit-nft.testnet` and DAO `merit-dao.testnet`.

## Audit fix

A security audit on 2026-11-10 found 9 issues, all verified real and all fixed in one contract update, redeployed the same day with state preserved (deploy tx `8JyZd3JhPmZZgbJwnDgqQAka8LhpBV1X76J7rZRHbvGg`, migrate tx `BRDnkBTgHJmfzAmG9j6nuNuv37ah7tdAYkCMzrNbNq6q`, wasm in the table above). The fixes: the completion skill registry; the DAO always arbitrates; `cancel_job` with exact refund and retry; the exact 0.1 NEAR mint deposit; the stamp cap enforced on completion stamps; the evidence reference; input bounds and paginated lists; `buy_kit` spending retained on kit; DAO only issuer control plus `revoke_stamp`; and the demo test labelled demo only. The demo log and the verifier were updated to the new numbers in step 12 above, and the site verifier was rerun clean at 180 of 180. The audit report is `Merit_Security_Audit_Report_2026-11-10_17_stj6.pdf`.

## How to run it

Prerequisites: a Rust toolchain with the `cargo near` extension, Node.js, and a NEAR testnet account with testnet NEAR. Keys for the demo accounts live only in `.testnet-accounts.json` at the repo root, chmod 600, and in `~/.near-credentials/testnet`. Never print or commit those files.

Build:

```sh
bash scripts/build.sh
```

Deploy, in order, after the build. Each script writes a log file with transaction hashes and verified state, and no keys:

```sh
node scripts/create-accounts.mjs
node scripts/create-dao.mjs
node scripts/deploy.mjs
node scripts/smoke.mjs
```

`create-accounts.mjs` creates the fresh Merit only testnet accounts through the testnet helper faucet, 10 testnet NEAR each: contract, DAO, Joseph seat, poster, worker. `create-dao.mjs` deploys a Sputnik v2 DAO at `merit-dao.testnet` with the three member council and threshold 2. `deploy.mjs` deploys the Merit wasm, calls `new` with owner and DAO id, publishes the wallet once as a global contract, and verifies the result. `smoke.mjs` runs the live money path described above and writes `merit-smoke-log.json`.

The full demo is `scripts/demo.mjs`. Run it with `node scripts/demo.mjs`; to resume from a single phase use `node scripts/demo.mjs --only <phase>`. It writes `merit-demo-log.json`. The site is served from `site/`; its config is already wired to the deployed contract and DAO.

## Files

| Path | What it is |
| --- | --- |
| `contract/src/lib.rs` | The Merit contract |
| `wallet/src/lib.rs` | The subaccount wallet contract |
| `contract/tests/integration.rs` | Sandbox integration tests, including the DAO dispute tests |
| `scripts/build.sh` | Wallet build, main build, unit tests |
| `scripts/create-accounts.mjs` | Fresh testnet accounts |
| `scripts/create-dao.mjs` | Merit DAO creation |
| `scripts/deploy.mjs` | Contract deploy and wallet publish |
| `scripts/smoke.mjs` | Live money path check |
| `scripts/demo.mjs` | Full live demo, 11 phases, writes `merit-demo-log.json` |
| `scripts/run-demo.sh` | One-click demo + verifier wrapper (npm install, demo, verify, pass/fail summary) |
| `scripts/verify-demo.mjs` | Verifies the demo, 71 of 71 checks |
| `package.json` | Node dependencies (near-api-js 5.1.1) for the demo scripts |
| `site/` | Mint, Merit detail, jobs board, lend |
| `site/verify/verify.mjs` | Headless site verifier, 180 of 180 checks |
| `PITCH.md` | The pitch |
| `skill.md` | The agent skill for Merit |
