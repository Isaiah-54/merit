# Merit

## The NFT that proves what you can do

Credentials you earn. Doors only proof can open.

---

## The pitch

Merit is an NFT that carries earned credentials and opens doors only that proof can open. You mint a blank Merit. You earn stamps on it by doing real things: passing a test, completing a job, being attested by a DAO. Your Merit computes its level from those stamps, on the chain. A paid job, a bounty, a DAO role or a gated room checks your Merit, not your wallet history and not a PDF. No stamp, no entry. And your Merit owns its own account, so the money your work earns lands in the Merit itself. Merit is what comes after the JPEG: ownership with behaviour.

## The problem

NFTs today are pictures and certificates. They prove you bought something. They do not prove you can do something. A hiring manager, a DAO, a client or a community cannot tell from a wallet whether the person behind it is any good. The proof lives in PDFs, screenshots and profiles that anyone can fake, and none of it travels with the asset itself. The JPEG was the first act. The next act is an NFT that does something.

## The idea

Merit turns an NFT into proof. The NFT is a record of what its holder can do, written on the chain by the people and systems that verified it, and it enforces access from that proof. It is not a badge you buy. It is a record you earn. And because it owns its own account, the value it creates through work belongs to it, and travels with it.

## The five behaviours

Merit does all five things the track asks for. The first three are earned through work, not through trading. That is the difference that makes Merit its own idea.

### 1. Own money

Each Merit owns its own NEAR account, a real sub account created when the Merit is minted, with the contract holding the only key. Job payments land in the Merit's own account, and the holder withdraws from it. The money comes from work the credentials unlock, not from gifts or speculation. The NFT earns by doing.

### 2. Earn

The Merit takes a small cut of every job it unlocks, paid into its own account. This is not a resale royalty. A stamped Merit locks and cannot be sold, so there is no resale to take a cut from. Merit earns when it works, not when it sells.

### 3. Hold inventory

The Merit carries its own kit: the specific tools tied to its credentials. A welder's Merit carries a welding torch. A photographer's Merit carries a camera. The inventory belongs to the job, not to a general bag. Each tool is a record in the Merit contract itself, not a separate NFT: an issuer mints a named tool to an account, and the holder deposits it into a Merit they hold. The account keeps owning the tool while it sits inside the Merit, and can take it back out at any time. The kit is the visible proof of what the credential certifies the holder to use. The job gate is the stamp, not the kit: taking a tool out does not close a job the stamps already unlock.

### 4. Carry credentials

Stamps are the heart of Merit. An issuer, a DAO, a course, an employer or a test, stamps a credential onto the Merit on the chain, bound to the token, with issuer, skill and level recorded. Only named issuers on the whitelist can stamp. Each issuer has a display name, and every stamp shows the issuer's name, so a stamp from a known issuer means something and a stamp from a random wallet cannot exist. The Merit computes its level from its stamps, on the chain. The stamps are the proof, and they travel with the token.

### 5. Memberships and access

Access is enforced by the Merit itself. A paid job, a bounty, a DAO role or a gated room checks the Merit's stamps on the chain. No stamp, no entry. Membership is not a chat invite or a role in a server. It is a gate the Merit either opens or does not.

## The two rules

Two rules keep Merit honest.

**Lock.** Once a Merit earns its first stamp it locks. It cannot be sold, because credentials cannot be bought. A buyer cannot purchase a record they did not earn.

**Lend.** A locked Merit can be lent. The holder delegates its access to another wallet for a set time, and the delegation expires on the chain. Proof stays honest and access stays flexible. You can let someone borrow your record without giving it away.

## How jobs work

Jobs come from the board, and the Merit is the application. There is no CV and no interview. The gate is the application.

1. Someone posts a job: an employer, a DAO or a client posts on Merit's board with the work, the payment locked in escrow in the contract, and the stamp requirement, for example Welding level 2.
2. The holder browses: the board shows each job with its requirement, and which ones their Merit unlocks. The gate check happens on the chain.
3. The holder takes a job their stamps unlock, in one transaction. The job is now assigned to their Merit.
4. The holder does the work off the chain.
5. The poster confirms completion on the chain. That confirmation is the trust point: the poster must say the work is done. If the poster never confirms and never disputes, the payment releases itself after the deadline, seven days by default, and the stamp is issued too, because the work stands unchallenged. A dispute raised inside the window blocks the release and the stamp.
6. The escrowed payment releases into the Merit's own account. The Merit keeps its small cut and the holder withdraws the rest from the Merit's account.
7. Completing the job earns a new stamp, which raises the Merit's level and unlocks bigger jobs.

## If the work is disputed

Both problems, a poster who says the job is substandard and an issuer who refuses to stamp work that was done, are the same thing: a dispute about quality. The solution is a dispute judged by the Merit DAO.

Each job names an arbiter when it is posted, by default the Merit DAO, and posts clear acceptance criteria. The poster must dispute actively inside the window. Silence is not a dispute. A dispute blocks both the payment and the stamp, and nothing moves until it is resolved.

The dispute goes to the DAO as a proposal. The proposal carries the job id, one proposed outcome, the job's acceptance criteria, and both sides' evidence hashes. The evidence itself stays off chain; only its hash is recorded, so the council judges the exact evidence each side submitted. The proposed outcome is one of three: pay in full and issue the stamp, pay partial and issue no stamp, or refund the poster and issue no stamp. The council is three members, Isaiah, James54 and Joseph, and two votes are needed to pass. The proposal is a DAO function call to the Merit contract, so when the council votes it through, the contract carries out the outcome automatically. The council judges like a jury: it reads the evidence against the criteria and votes. That is why clear criteria at posting matter, the council can only judge fairly against what was written. A proposal passes as soon as it reaches the threshold, so two quick votes can settle a dispute in minutes. If the council rejects a proposal, the dispute stays open and either side may propose a different outcome. The worker can always retry: redo the job, or take another job, and earn the stamp when the work meets the standard. A failed job costs the worker the missing stamp and the missing pay, and nothing more.

In the demo the jobs are demo jobs posted by demo accounts, and completion is confirmed by the demo employer account. In the live product the job supply comes from employers and DAOs posting real work.

## The demo

The proof, in one flow, all on the testnet. The demo ran live on testnet on 2026-11-10 and verified 61 of 61 checks (43 live reads plus 18 receipt checks, `scripts/verify-demo.mjs`, log `merit-demo-log.json`). Every step is a real on chain transaction with a receipt. Nothing is simulated.

1. Mint a blank Merit.
2. Try to open a paid job and get refused on the chain.
3. Pass the test and earn the `merit-basics` stamp.
4. Earn a DAO attestation stamp.
5. Deposit kit into the Merit: a named Welding torch, the tool for the welding credential.
6. Try again and get in. Accept the paid job.
7. The poster confirms completion. Payment lands in the Merit's own account: on a 2 NEAR job, 1.9 NEAR withdrawable and 0.1 NEAR retained, and the completion stamp is issued.
8. Withdraw from the Merit's own account to the holder.
9. Lend the Merit to a second wallet and show the access moving, then expiring.
10. A short timeout job releases on its own after its deadline on silence, paying the worker and issuing the stamp.
11. A dispute is resolved by DAO proposal and council vote.

Outcome: `merit-2` finished level 8 and locked, holding 5 stamps (`merit-basics` 1, `welding` 3, `torch-work` 1, `gate-welding` 1, `repair-welding` 2) and carrying a named Welding torch in its kit. Its subaccount holds 2.65 NEAR, of which 2.375 NEAR is withdrawable and 0.225 NEAR is retained by Merit. That 0.225 NEAR is what the Merit earned by working: 5% of each of the four paid jobs its stamps unlocked, kept in its own account. Four paid jobs totalled 4.5 NEAR. The dispute job was resolved by DAO proposal #0, which passed 2-0 and executed `pay_full` with the `repair-welding` stamp issued.

## Why it wins

**The money comes from work.** A Merit's balance grows from the jobs it unlocks. Its earnings are a cut of the work it enables. Its inventory is the kit of its trade. The value of a Merit is the work it can do.

**Credentials cannot be bought.** A Merit locks on its first stamp, so no one can purchase a record they did not earn. Stamps come only from named issuers on the whitelist, and every stamp shows its issuer. The gates check the Merit on the chain, not a screenshot.

**Honest by construction.** Every claim a Merit makes can be verified by reading the chain: the stamps and their issuers, the level, the balance in its own account, the kit it carries, the jobs it completed. Nothing in the pitch depends on trusting a screenshot or a profile.

**A real product, not a demo trick.** The same mechanism serves a hiring market, a DAO that needs proven contributors, a community that wants to gate its paid work, and any group that needs to know who can actually do the job.

## How it is built

Merit is built on NEAR testnet. A Rust contract implements the `NEP-171` NFT standard plus the five behaviours, the lock and the lend. Each token gets its own NEAR sub account, and each sub account runs a tiny wallet contract that only obeys the parent Merit contract. That is how withdrawals work: a contract cannot hold a key, so the wallet contract is the only way the sub account can move money, and it only pays out to whoever the parent says is the current holder. The money really sits in the sub account, visible on an explorer, and the payout really comes from it. A small site lets you mint, view a Merit with its stamps, level, balance and kit, browse gated jobs, and lend. The build follows the same discipline as the other projects in this set: unit tests plus integration tests for every behaviour, a live demo on testnet with a verify pass counting live state and receipts (61 of 61 passed), and a README that names the other project.

## Lead and status

Lead: Isaiah. The hackathon allows one person up to two different projects, if they are independent and each README names the other. Isaiah leads Genesis, so Merit is his second, at the cap. Merit's README names Genesis. Payout: otoyo4real.near.

Build started 9 November 2026. Deadline 14 November 2026, 23:59 UTC. Submission needs the demo post on X and explicit consent, as with the other projects.
