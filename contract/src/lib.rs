//! Merit — an NFT that carries earned credentials and opens doors only
//! that proof can open.
//!
//! Five behaviours, all WORK-based (not trade-based):
//!
//! 1. OWN MONEY — each Merit owns its own real NEAR sub-account
//!    (`{token_id}.{contract}`) running a tiny wallet contract. Job
//!    payments land in the Merit's own account, visible on the
//!    explorer; the holder withdraws from it. Money comes from WORK,
//!    not trading. The wallet only obeys the parent Merit contract
//!    (see SUB-ACCOUNT WALLET below) — the sub-account holds no keys,
//!    so nothing can move its money except through the parent.
//! 2. EARN — the Merit takes a 5% cut of every job it unlocks, paid
//!    into its own account. NOT a resale royalty: a stamped Merit
//!    locks and cannot be sold, so no resale royalty can exist. It
//!    earns when it works.
//! 3. HOLD INVENTORY — the Merit carries its own kit: specific tools
//!    tied to its credentials (e.g. a welding-torch NFT), held inside
//!    the Merit as real records. The kit belongs to the job, not a
//!    general bag.
//! 4. CARRY CREDENTIALS — stamps: WHITELISTED issuers stamp a
//!    credential onto the Merit onchain, bound to the token, with
//!    issuer, issuer display name, skill and level (1-3). The Merit
//!    computes its level onchain as the sum of its stamp levels.
//! 5. MEMBERSHIPS AND ACCESS — gates enforced by the Merit: a job
//!    checks the Merit's stamps onchain. No stamp, no entry.
//!
//! LOCK: once a Merit earns its first stamp it LOCKS — `nft_transfer`
//! panics. Credentials cannot be bought. But it CAN be LENT: the
//! holder delegates access to another wallet until an expiry
//! timestamp, expiring onchain; the delegate can open gates and do
//! jobs, but cannot transfer or withdraw.
//!
//! SUB-ACCOUNT WALLET: at mint the contract creates the token's real
//! sub-account and deploys the tiny `merit-wallet` contract on it.
//! The wallet is published ONCE as a global contract by code hash
//! (`deploy_wallet_global`, owner-only, one-time ~1.14 NEAR storage
//! for the 113,927-byte wallet code, paid from the contract account's
//! balance — not from mint fees), and every sub-account references
//! that one published code via `use_global_contract`. So each mint
//! pays only account-creation storage, not a fresh copy of the code.
//! If the global route ever proves unusable, the owner can flip
//! `set_use_embedded_wallet(true)` and mints deploy the wallet wasm
//! to each sub-account instead (~1.14 NEAR of code storage per mint,
//! drawn from the contract's balance — viable only to prove the
//! mechanism, not at 0.1 NEAR mint economics).
//! The wallet's only money-moving method, `payout`, asserts the
//! predecessor is the parent Merit contract and pays whoever the
//! parent names (the current holder). Job payments are plain
//! transfers into the sub-account; withdrawals are parent-checked
//! cross-contract calls to the wallet's `payout`.
//!
//! ECONOMICS: mint price 0.1 NEAR = 0.05 NEAR sub-account init
//! (account + wallet state + buffer) + 0.05 NEAR kept by the
//! contract for token storage. Job cut: 5% retained / 95%
//! withdrawable, split exactly (the remainder of the 95% division
//! goes to the retained side, so withdrawable + retained == payment).
//! The per-token ledger (withdrawable/retained) is the record of
//! what sits in that token's sub-account: sub-account balance ==
//! withdrawable + retained + the 0.05 NEAR init.
//!
//! POSTER TIMEOUT: the poster confirms completion (`complete_job`),
//! so a poster who refuses or disappears is a trust point. Each
//! accepted job records a deadline (accepted_at + timeout; default
//! 7 days, configurable per job at posting). After the deadline, if
//! no dispute is open, ANYONE may call `release_job` and the escrow
//! pays the worker's Merit (same 95/5 split) AND the completion
//! stamp is issued — silence is not a dispute: unchallenged work
//! stands. The poster or worker may raise a dispute while the job
//! is Accepted and before the deadline; an open dispute (status
//! Disputed) blocks both `complete_job` and `release_job` and blocks
//! the payment and the stamp until resolved.
//!
//! DISPUTES — DAO PROPOSAL AND VOTE: every job's arbiter is the
//! contract's Merit DAO — no poster may name another arbiter.
//! The arbiter is recorded on the job and ONLY that DAO contract
//! may resolve a dispute on it — `resolve_dispute` checks the
//! predecessor is the job's arbiter DAO and rejects any other
//! caller, person or contract. Each job MUST post clear acceptance
//! criteria at posting (`criteria`, required, non-empty) — the DAO
//! council judges the evidence against these criteria, like a
//! jury, not an automatic check. On dispute, both sides submit
//! evidence hashes plus a content reference (`submit_evidence`)
//! where the council can retrieve the evidence and check it
//! against the hash; the evidence content itself stays offchain,
//! only its SHA-256 hash and reference are recorded onchain. The
//! dispute is judged through a DAO proposal: a proposal is created
//! on the Merit DAO (a Sputnik v2 DAO) carrying the job id, the
//! evidence, the criteria, and ONE proposed outcome — pay in full
//! + issue stamp, pay partial (a stated amount) + no stamp, or
//! refund the poster + no stamp. The proposal is a FunctionCall
//! proposal that calls this contract's `resolve_dispute` with that
//! outcome. The council votes Approve or Reject; when the vote
//! reaches the DAO threshold the proposal passes and the DAO
//! executes the call, so the contract releases the payment and
//! issues (or withholds) the stamp automatically. If the proposal
//! is rejected, the dispute stays open and either side may propose
//! a different outcome. The council is small and named, so a
//! proposal passes as soon as it reaches threshold — two quick
//! votes can settle a dispute in minutes.
//! PROPOSAL CREATION IS A SEPARATE STEP (not automatic on
//! `raise_dispute`): `raise_dispute` only marks the job Disputed;
//! the disputer (or anyone) then calls the DAO's `add_proposal`
//! directly with the FunctionCall to `resolve_dispute`. Automatic
//! creation from the contract was judged too fragile (the DAO
//! proposal bond would strand in the contract if the proposal call
//! failed). Outcomes: "pay_full" pays the full escrow to the
//! worker's Merit (95/5) and issues the completion stamp;
//! "refund" returns the full escrow to the poster, no pay, no
//! stamp; "partial" pays an arbiter-set worker amount (<= escrow,
//! 95/5 split), refunds the remainder to the poster, and issues
//! NO stamp. A failed job is closed; the worker retries by taking
//! another job — a failed job costs the Merit nothing beyond the
//! missing stamp and pay. There is no AI arbiter: the DAO arbiter
//! is the only dispute path.
//!
//! COMPLETION STAMP: each job carries a completion_stamp {skill,
//! level} set at posting. It is issued as a system stamp (issuer =
//! the contract account, issuer_name = "Job completion") on every
//! success path: poster confirm, auto-release, arbiter pay-in-full.
//! Never on refund or partial. Issuing it may lock the Merit if it
//! is its first stamp, which is intended. The skill must be in the
//! contract-maintained completion skill registry, governed by the
//! DAO — a poster cannot invent a credential for a job to award.
//! An Open job can be cancelled by its poster (`cancel_job`): the
//! job is marked Cancelled before the exact escrow is refunded,
//! and a failed refund stays retryable. A Merit may spend its
//! retained 5% balance on kit tools (`buy_kit`, 0.1 NEAR per kit),
//! paid from its own sub-account wallet to the kit seller.
//!
//! ISSUER WHITELIST: only whitelisted issuers may stamp. The
//! contract holds a whitelist of issuer accounts with human-readable
//! display names; each stamp stores the issuer account AND its
//! display name. Seeded at init with the owner as "Merit DAO".
//! The whitelist is governed by the DAO, not the owner. A stamp
//! may be revoked by the DAO or by the issuer recorded on it
//! (`revoke_stamp`); revoking the last stamp never unlocks the
//! Merit, the lock stays once earned. `pass_test` stamps are
//! system stamps: issuer = the contract account id, issuer_name
//! = "Merit Test".
//!
//! TESTNET ONLY. Never deploy to mainnet.

use near_contract_standards::non_fungible_token::events::{NftMint, NftTransfer};
use near_contract_standards::non_fungible_token::metadata::{
    NFTContractMetadata, TokenMetadata,
};
use near_contract_standards::non_fungible_token::{Token, TokenId};
use near_sdk::json_types::{U128, U64};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{
    env, ext_contract, near, AccountId, CryptoHash, Gas, NearToken, PanicOnDefault, Promise,
    PromiseResult,
};
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use schemars::JsonSchema;

/// 1 NEAR in yoctoNEAR.
pub const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
/// Mint price: 0.1 NEAR.
pub const MINT_PRICE: u128 = ONE_NEAR / 10;
/// NEAR transferred into the new sub-account at mint (account creation
/// + wallet state storage + buffer). The rest of the mint price stays
/// in the main contract for token storage.
pub const SUBACCOUNT_INIT: u128 = ONE_NEAR / 20;
/// The 1 yoctoNEAR attached deposit NEP-171 requires on nft_transfer.
pub const TRANSFER_DEPOSIT: u128 = 1;
/// The Merit's cut of every completed job, in basis points (5%).
pub const CUT_BP: u128 = 500;
/// Max distinct stamped skills per Merit (bounds storage/gas).
pub const MAX_STAMPS: usize = 64;
/// Default job timeout: 7 days, in nanoseconds.
pub const DEFAULT_TIMEOUT_NS: u64 = 7 * 24 * 60 * 60 * 1_000_000_000;
/// The demo test answer. `pass_test` hashes the submitted answer with
/// SHA-256 and compares it to the hash stored at init. This is a demo
/// test, not a secret — see README.
pub const TEST_ANSWER: &str = "merit";
/// The skill stamped by passing the demo test, at level 1.
pub const TEST_SKILL: &str = "merit-basics";
/// Display name recorded on `pass_test` (system) stamps.
pub const TEST_ISSUER_NAME: &str = "Merit Test";
/// Display name recorded on job completion stamps.
pub const COMPLETION_ISSUER_NAME: &str = "Job completion";
/// Display name seeded for the owner at init.
pub const OWNER_ISSUER_NAME: &str = "Merit DAO";
/// Max length of a job's acceptance criteria, in characters.
pub const MAX_CRITERIA_LEN: usize = 2000;
/// Max length of a job description, in characters (same as criteria).
pub const MAX_DESCRIPTION_LEN: usize = 2000;
/// Max required stamps on one job.
pub const MAX_REQUIRED_STAMPS: usize = 10;
/// Max page size for paginated list views.
pub const MAX_PAGE_SIZE: u64 = 50;
/// Max length of an evidence content reference (a URI or CID).
pub const MAX_EVIDENCE_REF_LEN: usize = 512;
/// Price of one kit tool bought with retained balance: 0.1 NEAR.
pub const KIT_PRICE: u128 = ONE_NEAR / 10;
/// Skills that may be awarded as job completion stamps. Seeded at
/// init and in migrate; only the DAO may add or remove entries.
pub const SEEDED_COMPLETION_SKILLS: [&str; 9] = [
    "welding",
    "torch-work",
    "gate-welding",
    "repair-welding",
    "merit-basics",
    "coding",
    "design",
    "writing",
    "data-entry",
];

/// Embedded wallet wasm, published once as a global contract and (as
/// a fallback) deployed to each sub-account. Copied here by
/// scripts/build.sh from the cargo-near wallet build, so the include
/// path has no `..` in it (this environment intermittently fails to
/// read `..` include paths out of target/).
const WALLET_WASM: &[u8] = include_bytes!("wallet.wasm");

/// Gas for the wallet `init` call inside the mint promise chain.
const MINT_INIT_GAS: Gas = Gas::from_tgas(20);
/// Gas for a wallet `payout` call and for the withdraw callback.
const PAYOUT_GAS: Gas = Gas::from_tgas(10);
const CALLBACK_GAS: Gas = Gas::from_tgas(10);

/// A credential stamped onto a Merit, bound to the token.
#[near(serializers = [borsh, json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stamp {
    pub skill: String,
    pub level: u8,
    pub issuer: AccountId,
    pub issuer_name: String,
    pub stamped_at: u64,
}

/// What a job requires: a skill at at least this level.
#[near(serializers = [borsh, json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequiredStamp {
    pub skill: String,
    pub min_level: u8,
}

/// The stamp a job's worker earns by completing it, set at posting.
#[near(serializers = [borsh, json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompletionStamp {
    pub skill: String,
    pub level: u8,
}

#[near(serializers = [borsh, json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobStatus {
    Open,
    Accepted,
    Disputed,
    Completed,
    Refunded,
    PartiallyPaid,
    Cancelled,
}

#[near(serializers = [borsh, json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Job {
    pub job_id: String,
    pub title: String,
    pub description: String,
    /// Escrowed payment, yoctoNEAR. Set from the attached deposit at
    /// create_job; the full amount is the job's payment.
    pub payment: u128,
    pub required_stamps: Vec<RequiredStamp>,
    /// The stamp the worker earns by completing the job. Issued on
    /// every success path (poster confirm, auto-release, arbiter
    /// pay-in-full); never on refund or partial.
    pub completion_stamp: CompletionStamp,
    /// The acceptance criteria the work is judged against. Required
    /// at posting (non-empty): the arbiter judges the evidence
    /// against what is written.
    pub criteria: String,
    pub poster: AccountId,
    /// The DAO that may resolve a dispute on this job. Defaults
    /// to the contract's Merit DAO; the poster may name another
    /// trusted DAO at posting.
    pub arbiter: AccountId,
    /// SHA-256 hex of the evidence the poster submitted, if any.
    pub poster_evidence: Option<String>,
    /// SHA-256 hex of the evidence the worker submitted, if any.
    pub worker_evidence: Option<String>,
    /// Content reference for the poster evidence (a URI or CID),
    /// if any. The hash above commits to the content it points at.
    pub poster_evidence_ref: Option<String>,
    /// Content reference for the worker evidence (a URI or CID),
    /// if any.
    pub worker_evidence_ref: Option<String>,
    /// True while a cancel refund is still owed: cancel_job marked
    /// the job Cancelled and the refund transfer failed, so the
    /// poster may retry it with retry_cancel_refund.
    pub refund_pending: bool,
    pub status: JobStatus,
    pub accepted_by: Option<TokenId>,
    /// Timeout for the accepted job, in nanoseconds.
    pub timeout_ns: u64,
    /// Block timestamp (ns) when the job was accepted, if any.
    pub accepted_at: Option<u64>,
}

/// A kit tool token. Kit tokens live in this contract's own registry
/// (they are not separate NEP-171 tokens); `inside_merit` records
/// which Merit currently holds the tool, if any.
#[near(serializers = [borsh, json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KitToken {
    pub kit_token_id: String,
    pub name: String,
    pub owner_id: AccountId,
    pub inside_merit: Option<TokenId>,
}

/// A lend delegation: `to` may act as the Merit until `expires_at`
/// (nanosecond timestamp, same clock as `env::block_timestamp`).
#[near(serializers = [borsh, json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LendInfo {
    pub to: AccountId,
    pub expires_at: u64,
}

/// One Merit token's full onchain state.
#[near(serializers = [borsh, json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MeritToken {
    pub owner_id: AccountId,
    pub metadata: Option<TokenMetadata>,
    pub stamps: Vec<Stamp>,
    /// 95% of completed job pay, withdrawable by the holder. The
    /// NEAR sits in this token's sub-account wallet.
    pub withdrawable: u128,
    /// The 5% cut of completed job pay. Held in the token's
    /// sub-account wallet; not withdrawable through `withdraw`.
    pub retained: u128,
    /// Kit token ids currently held inside this Merit.
    pub kit: Vec<String>,
    pub lend: Option<LendInfo>,
    /// True once the Merit has ever held a stamp. The lock stays
    /// once earned: revoking the last stamp does not unlock the
    /// Merit, so a credential can never be erased to free a Merit
    /// for sale.
    pub ever_stamped: bool,
}

// ---- View shapes (JSON) ----

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[cfg_attr(not(target_arch = "wasm32"), derive(JsonSchema))]
#[serde(crate = "near_sdk::serde")]
pub struct StampView {
    pub skill: String,
    pub level: u8,
    pub issuer: AccountId,
    pub issuer_name: String,
    pub stamped_at: U64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[cfg_attr(not(target_arch = "wasm32"), derive(JsonSchema))]
#[serde(crate = "near_sdk::serde")]
pub struct LendView {
    pub to: AccountId,
    pub expires_at: U64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[cfg_attr(not(target_arch = "wasm32"), derive(JsonSchema))]
#[serde(crate = "near_sdk::serde")]
pub struct MeritView {
    pub token_id: TokenId,
    pub owner_id: AccountId,
    pub level: u16,
    pub stamps: Vec<StampView>,
    pub balance_withdrawable: U128,
    pub balance_retained: U128,
    pub locked: bool,
    pub kit: Vec<String>,
    pub lend: Option<LendView>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[cfg_attr(not(target_arch = "wasm32"), derive(JsonSchema))]
#[serde(crate = "near_sdk::serde")]
pub struct JobView {
    pub job_id: String,
    pub title: String,
    pub description: String,
    pub payment: U128,
    pub required_stamps: Vec<RequiredStamp>,
    pub completion_stamp: CompletionStamp,
    pub criteria: String,
    pub poster: AccountId,
    pub arbiter: AccountId,
    pub poster_evidence: Option<String>,
    pub worker_evidence: Option<String>,
    pub poster_evidence_ref: Option<String>,
    pub worker_evidence_ref: Option<String>,
    pub refund_pending: bool,
    pub status: JobStatus,
    pub accepted_by: Option<TokenId>,
    pub timeout_ns: U64,
    pub accepted_at: Option<U64>,
    pub deadline: Option<U64>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[cfg_attr(not(target_arch = "wasm32"), derive(JsonSchema))]
#[serde(crate = "near_sdk::serde")]
pub struct KitView {
    pub kit_token_id: String,
    pub name: String,
    pub owner_id: AccountId,
    pub inside_merit: Option<TokenId>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[cfg_attr(not(target_arch = "wasm32"), derive(JsonSchema))]
#[serde(crate = "near_sdk::serde")]
pub struct IssuerView {
    pub account_id: AccountId,
    pub name: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[cfg_attr(not(target_arch = "wasm32"), derive(JsonSchema))]
#[serde(crate = "near_sdk::serde")]
pub struct WalletInfoView {
    /// Hex-encoded SHA-256 of the wallet code, once published.
    pub code_hash: Option<String>,
    pub deployed: bool,
    /// True when mints deploy the wallet wasm per sub-account
    /// instead of referencing the global contract.
    pub embedded: bool,
}

// ---- Pure helpers (unit-tested) ----

/// Token ids double as sub-account name parts, so they must be valid
/// NEAR sub-account labels: 1-32 chars, lowercase letters, digits,
/// hyphens, never starting or ending with a hyphen.
pub fn validate_token_id(token_id: &str) {
    assert!(
        !token_id.is_empty() && token_id.len() <= 32,
        "token_id must be 1-32 characters"
    );
    assert!(
        token_id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
        "token_id may only contain lowercase letters, digits and hyphens"
    );
    assert!(
        !token_id.starts_with('-') && !token_id.ends_with('-'),
        "token_id may not start or end with a hyphen"
    );
}

/// The token's own sub-account id.
pub fn subaccount_id(token_id: &str, contract_id: &AccountId) -> String {
    format!("{}.{}", token_id, contract_id)
}

/// A Merit's level is the sum of its stamp levels.
pub fn merit_level(stamps: &[Stamp]) -> u16 {
    stamps.iter().map(|s| s.level as u16).sum()
}

/// Split a completed job payment exactly: 95% withdrawable, the rest
/// (5% plus any rounding remainder) retained, so the two parts always
/// sum to the payment.
pub fn split_payment(payment: u128) -> (u128, u128) {
    let withdrawable = payment * (10_000 - CUT_BP) / 10_000;
    (withdrawable, payment - withdrawable)
}

/// True while a lend delegation is live at timestamp `now`.
pub fn lend_active(lend: &Option<LendInfo>, now: u64) -> bool {
    match lend {
        Some(l) => now < l.expires_at,
        None => false,
    }
}

/// Deadline for an accepted job: accepted_at + timeout.
pub fn job_deadline(accepted_at: u64, timeout_ns: u64) -> u64 {
    accepted_at
        .checked_add(timeout_ns)
        .expect("job deadline overflow")
}

/// Paginate a list view: returns the [start, end) index range in
/// u64 space, with the page size capped at MAX_PAGE_SIZE and
/// saturating arithmetic, so huge from_index or limit values can
/// never trap or wrap.
pub fn paginate(total: u64, from_index: Option<U64>, limit: Option<u64>) -> (u64, u64) {
    let from = from_index.map(|i| i.0).unwrap_or(0);
    let limit = limit.unwrap_or(MAX_PAGE_SIZE).min(MAX_PAGE_SIZE);
    let start = from.min(total);
    let end = from.saturating_add(limit).min(total);
    (start, end)
}

fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

/// An evidence hash is a SHA-256 hex string: exactly 64 lowercase
/// hex characters.
pub fn validate_evidence_hash(hash: &str) {
    assert!(
        hash.len() == 64
            && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')),
        "evidence_hash must be a 64-character lowercase sha256 hex string"
    );
}

/// SHA-256 of the embedded wallet code — the global contract's code
/// hash once published.
pub fn wallet_code_hash() -> CryptoHash {
    env::sha256(WALLET_WASM)
        .try_into()
        .expect("sha256 is 32 bytes")
}

// ---- Cross-contract interfaces ----

#[ext_contract(ext_wallet)]
pub trait ExtWallet {
    fn payout(&mut self, receiver: AccountId, amount: U128);
}

#[ext_contract(ext_self)]
pub trait ExtSelf {
    fn on_wallet_global_deployed(&mut self);
    fn on_mint_subaccount_created(
        &mut self,
        token_id: TokenId,
        receiver_id: AccountId,
        metadata: Option<TokenMetadata>,
        minter: AccountId,
    );
    fn on_withdraw(&mut self, token_id: TokenId, amount: U128);
    fn on_cancel_refund(&mut self, job_id: String);
    fn on_buy_kit(&mut self, token_id: TokenId, kit_token_id: String, seller: AccountId);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Merit {
    owner: AccountId,
    /// The Merit DAO (Sputnik v2) account. Jobs default their
    /// arbiter to this DAO; only a job's arbiter DAO may call
    /// `resolve_dispute` on it.
    dao_id: AccountId,
    /// Whitelisted issuers: account -> display name.
    issuers: LookupMap<AccountId, String>,
    issuer_ids: Vector<AccountId>,
    /// v2 prefixes (b"T" / b"J"): migrate moved tokens and jobs
    /// here from the v1 prefixes (b"t" / b"j"), whose entries are
    /// orphaned storage. Never reuse the v1 prefixes.
    tokens: LookupMap<TokenId, MeritToken>,
    token_ids: Vector<TokenId>,
    jobs: LookupMap<String, Job>,
    job_ids: Vector<String>,
    kits: LookupMap<String, KitToken>,
    /// SHA-256 of the SHA-256 of the demo test answer (TEST_ANSWER).
    test_answer_hash: Vec<u8>,
    /// SHA-256 of the wallet code, once published as a global
    /// contract.
    wallet_code_hash: Option<Vec<u8>>,
    wallet_deployed: bool,
    /// Fallback: mint deploys the wallet wasm per sub-account
    /// instead of referencing the global contract.
    use_embedded_wallet: bool,
    /// Skills that may be awarded as job completion stamps.
    /// Governed by the DAO; seeded at init and in migrate.
    completion_skills: Vector<String>,
}

#[near]
impl Merit {
    #[init]
    pub fn new(owner_id: AccountId, dao_id: AccountId) -> Self {
        assert!(!env::state_exists(), "already initialized");
        let mut issuers = LookupMap::new(b"i");
        let mut issuer_ids = Vector::new(b"q");
        // Seed the whitelist with the owner as "Merit DAO".
        issuers.insert(owner_id.clone(), OWNER_ISSUER_NAME.to_string());
        issuer_ids.push(owner_id.clone());
        let mut completion_skills = Vector::new(b"s");
        for skill in SEEDED_COMPLETION_SKILLS {
            completion_skills.push(skill.to_string());
        }
        Self {
            owner: owner_id,
            dao_id,
            issuers,
            issuer_ids,
            tokens: LookupMap::new(b"T"),
            token_ids: Vector::new(b"v"),
            jobs: LookupMap::new(b"J"),
            job_ids: Vector::new(b"w"),
            kits: LookupMap::new(b"k"),
            test_answer_hash: env::sha256(TEST_ANSWER.as_bytes()),
            wallet_code_hash: None,
            wallet_deployed: false,
            use_embedded_wallet: false,
            completion_skills,
        }
    }

    /// One-shot migration from the pre-audit state shape to this
    /// one. Deploy the new WASM over the old contract, then call
    /// this once as the owner. It reads the old state, converts
    /// every job (evidence refs default to None, no cancel refund
    /// pending) and every token (ever_stamped is true exactly when
    /// the token already holds a stamp, so locked Merits stay
    /// locked), seeds the completion skill registry, and writes
    /// the new state. A second call fails: the migration marker is
    /// set, and the old shape can no longer be read from new state.
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        if env::storage_read(b"merit:migrated_v2").is_some() {
            env::panic_str("already migrated");
        }
        let old: OldMerit = env::state_read().expect("old contract state not found");
        assert_eq!(
            env::predecessor_account_id(),
            old.owner,
            "only the contract owner may migrate"
        );
        let job_ids: Vec<String> = old.job_ids.iter().cloned().collect();
        // Fresh prefix (b"J"): inserting into the old prefix would
        // read each old job back as the new Job shape and panic.
        // The old entries stay as unreachable orphaned storage.
        let mut jobs = LookupMap::new(b"J");
        for id in &job_ids {
            if let Some(oj) = old.jobs.get(id) {
                jobs.insert(
                    id.clone(),
                    Job {
                        job_id: oj.job_id.clone(),
                        title: oj.title.clone(),
                        description: oj.description.clone(),
                        payment: oj.payment,
                        required_stamps: oj.required_stamps.clone(),
                        completion_stamp: oj.completion_stamp.clone(),
                        criteria: oj.criteria.clone(),
                        poster: oj.poster.clone(),
                        arbiter: oj.arbiter.clone(),
                        poster_evidence: oj.poster_evidence.clone(),
                        worker_evidence: oj.worker_evidence.clone(),
                        poster_evidence_ref: None,
                        worker_evidence_ref: None,
                        refund_pending: false,
                        status: oj.status.clone(),
                        accepted_by: oj.accepted_by.clone(),
                        timeout_ns: oj.timeout_ns,
                        accepted_at: oj.accepted_at,
                    },
                );
            }
        }
        let token_ids: Vec<TokenId> = old.token_ids.iter().cloned().collect();
        // Fresh prefix (b"T"), same reason as the jobs map above.
        let mut tokens = LookupMap::new(b"T");
        for id in &token_ids {
            if let Some(ot) = old.tokens.get(id) {
                tokens.insert(
                    id.clone(),
                    MeritToken {
                        owner_id: ot.owner_id.clone(),
                        metadata: ot.metadata.clone(),
                        stamps: ot.stamps.clone(),
                        withdrawable: ot.withdrawable,
                        retained: ot.retained,
                        kit: ot.kit.clone(),
                        lend: ot.lend.clone(),
                        ever_stamped: !ot.stamps.is_empty(),
                    },
                );
            }
        }
        let mut completion_skills = Vector::new(b"s");
        for skill in SEEDED_COMPLETION_SKILLS {
            completion_skills.push(skill.to_string());
        }
        env::storage_write(b"merit:migrated_v2", b"1");
        Self {
            owner: old.owner,
            dao_id: old.dao_id,
            issuers: old.issuers,
            issuer_ids: old.issuer_ids,
            tokens,
            token_ids: old.token_ids,
            jobs,
            job_ids: old.job_ids,
            kits: old.kits,
            test_answer_hash: old.test_answer_hash,
            wallet_code_hash: old.wallet_code_hash,
            wallet_deployed: old.wallet_deployed,
            use_embedded_wallet: old.use_embedded_wallet,
            completion_skills,
        }
    }

    // ---- internal helpers ----

    fn token(&self, token_id: &str) -> MeritToken {
        self.tokens
            .get(token_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str(&format!("token not found: {}", token_id)))
    }

    fn job(&self, job_id: &str) -> Job {
        self.jobs
            .get(job_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str(&format!("job not found: {}", job_id)))
    }

    /// True when `caller` is the worker on an accepted job: the
    /// holder of the assigned Merit, or a live lend delegate of it.
    fn is_worker(&self, job: &Job, caller: &AccountId) -> bool {
        let Some(token_id) = &job.accepted_by else {
            return false;
        };
        let Some(token) = self.tokens.get(token_id) else {
            return false;
        };
        caller == &token.owner_id
            || matches!(&token.lend, Some(ref l) if &l.to == caller && env::block_timestamp() < l.expires_at)
    }

    fn require_owner(&self) {
        assert_eq!(
            env::predecessor_account_id(),
            self.owner,
            "caller is not the contract owner"
        );
    }

    fn require_dao(&self) {
        assert_eq!(
            env::predecessor_account_id(),
            self.dao_id,
            "caller is not the Merit DAO"
        );
    }

    fn is_completion_skill(&self, skill: &str) -> bool {
        self.completion_skills.iter().any(|s| s == skill)
    }

    fn require_issuer(&self) {
        let caller = env::predecessor_account_id();
        assert!(
            self.issuers.contains_key(&caller),
            "caller is not a whitelisted issuer"
        );
    }

    fn issuer_name(&self, account_id: &AccountId) -> String {
        self.issuers
            .get(account_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("issuer is not whitelisted"))
    }

    /// Holder-only: the caller must own the token. Delegates may NOT
    /// do holder-only things (withdraw, kit moves, lend, transfer).
    fn require_holder(&self, token: &MeritToken) {
        assert_eq!(
            env::predecessor_account_id(),
            token.owner_id,
            "caller is not the Merit holder"
        );
    }

    /// Holder or a live lend delegate.
    fn require_access(&self, token: &MeritToken) {
        let caller = env::predecessor_account_id();
        let delegated = match &token.lend {
            Some(l) => l.to == caller && env::block_timestamp() < l.expires_at,
            None => false,
        };
        assert!(
            caller == token.owner_id || delegated,
            "caller is neither the holder nor a live lend delegate"
        );
    }

    fn stamps_satisfy(token: &MeritToken, required: &[RequiredStamp]) -> bool {
        required.iter().all(|r| {
            token
                .stamps
                .iter()
                .any(|s| s.skill == r.skill && s.level >= r.min_level)
        })
    }

    fn token_view(&self, token_id: &str, token: &MeritToken) -> MeritView {
        MeritView {
            token_id: token_id.to_string(),
            owner_id: token.owner_id.clone(),
            level: merit_level(&token.stamps),
            stamps: token
                .stamps
                .iter()
                .map(|s| StampView {
                    skill: s.skill.clone(),
                    level: s.level,
                    issuer: s.issuer.clone(),
                    issuer_name: s.issuer_name.clone(),
                    stamped_at: U64(s.stamped_at),
                })
                .collect(),
            balance_withdrawable: U128(token.withdrawable),
            balance_retained: U128(token.retained),
            locked: token.ever_stamped,
            kit: token.kit.clone(),
            lend: token.lend.as_ref().map(|l| LendView {
                to: l.to.clone(),
                expires_at: U64(l.expires_at),
            }),
        }
    }

    fn job_view(job: &Job) -> JobView {
        JobView {
            job_id: job.job_id.clone(),
            title: job.title.clone(),
            description: job.description.clone(),
            payment: U128(job.payment),
            required_stamps: job.required_stamps.clone(),
            completion_stamp: job.completion_stamp.clone(),
            criteria: job.criteria.clone(),
            poster: job.poster.clone(),
            arbiter: job.arbiter.clone(),
            poster_evidence: job.poster_evidence.clone(),
            worker_evidence: job.worker_evidence.clone(),
            poster_evidence_ref: job.poster_evidence_ref.clone(),
            worker_evidence_ref: job.worker_evidence_ref.clone(),
            refund_pending: job.refund_pending,
            status: job.status.clone(),
            accepted_by: job.accepted_by.clone(),
            timeout_ns: U64(job.timeout_ns),
            accepted_at: job.accepted_at.map(U64),
            deadline: job
                .accepted_at
                .map(|at| U64(job_deadline(at, job.timeout_ns))),
        }
    }

    /// Pay an assigned Merit's sub-account wallet: split the job
    /// payment 95/5 into the Merit's ledger and transfer the full
    /// payment into the token's sub-account. The sub-account has no
    /// keys and can never be deleted, so this transfer cannot fail
    /// in practice; the ledger is updated in the same call either way.
    fn pay_merit(&mut self, token_id: &str, payment: u128) {
        let mut token = self.token(token_id);
        let (to_withdrawable, to_retained) = split_payment(payment);
        token.withdrawable = token
            .withdrawable
            .checked_add(to_withdrawable)
            .unwrap_or_else(|| env::panic_str("withdrawable balance overflow"));
        token.retained = token
            .retained
            .checked_add(to_retained)
            .unwrap_or_else(|| env::panic_str("retained balance overflow"));
        self.tokens.insert(token_id.to_string(), token);
        let sub: AccountId = subaccount_id(token_id, &env::current_account_id())
            .parse()
            .unwrap_or_else(|_| env::panic_str("token sub-account id invalid"));
        Promise::new(sub)
            .transfer(NearToken::from_yoctonear(payment))
            .detach();
    }

    /// Issue a job's completion stamp onto the worker's Merit token
    /// as a system stamp (issuer = this contract, issuer_name =
    /// "Job completion"). If the Merit already holds that skill, the
    /// level is raised to the higher of the two — a completion never
    /// downgrades a credential. Issuing may lock the Merit if it is
    /// its first stamp, which is intended.
    fn issue_completion_stamp(&mut self, token_id: &str, stamp: &CompletionStamp) {
        let mut token = self.token(token_id);
        let now = env::block_timestamp();
        if let Some(existing) = token
            .stamps
            .iter_mut()
            .find(|s| s.skill == stamp.skill)
        {
            if stamp.level > existing.level {
                existing.level = stamp.level;
            }
            existing.issuer = env::current_account_id();
            existing.issuer_name = COMPLETION_ISSUER_NAME.to_string();
            existing.stamped_at = now;
        } else {
            assert!(
                token.stamps.len() < MAX_STAMPS,
                "too many distinct stamps on this Merit"
            );
            token.stamps.push(Stamp {
                skill: stamp.skill.clone(),
                level: stamp.level,
                issuer: env::current_account_id(),
                issuer_name: COMPLETION_ISSUER_NAME.to_string(),
                stamped_at: now,
            });
        }
        token.ever_stamped = true;
        self.tokens.insert(token_id.to_string(), token);
    }

    // ---- NEP-171 views ----

    pub fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        self.tokens.get(&token_id).map(|t| Token {
            token_id,
            owner_id: t.owner_id.clone(),
            metadata: t.metadata.clone(),
            approved_account_ids: None,
        })
    }

    pub fn nft_tokens(&self, from_index: Option<U64>, limit: Option<u64>) -> Vec<Token> {
        let total = self.token_ids.len() as u64;
        let (start, end) = paginate(total, from_index, limit);
        (start..end)
            .filter_map(|i| {
                let id = self.token_ids.get(i as u32)?;
                let t = self.tokens.get(id.as_str())?;
                Some(Token {
                    token_id: id.clone(),
                    owner_id: t.owner_id.clone(),
                    metadata: t.metadata.clone(),
                    approved_account_ids: None,
                })
            })
            .collect()
    }

    pub fn nft_metadata(&self) -> NFTContractMetadata {
        NFTContractMetadata {
            spec: "nft-1.0.0".to_string(),
            name: "Merit".to_string(),
            symbol: "MERIT".to_string(),
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        }
    }

    // ---- Merit views ----

    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }

    /// The Merit DAO account id (the default arbiter for new jobs).
    pub fn get_dao(&self) -> AccountId {
        self.dao_id.clone()
    }

    pub fn is_issuer(&self, account_id: AccountId) -> bool {
        self.issuers.contains_key(&account_id)
    }

    pub fn list_issuers(&self, from_index: Option<U64>, limit: Option<u64>) -> Vec<IssuerView> {
        let total = self.issuer_ids.len() as u64;
        let (start, end) = paginate(total, from_index, limit);
        (start..end)
            .filter_map(|i| {
                let id = self.issuer_ids.get(i as u32)?;
                let name = self.issuers.get(id)?;
                Some(IssuerView {
                    account_id: id.clone(),
                    name: name.clone(),
                })
            })
            .collect()
    }

    pub fn get_wallet_info(&self) -> WalletInfoView {
        WalletInfoView {
            code_hash: self.wallet_code_hash.as_ref().map(|h| to_hex(h)),
            deployed: self.wallet_deployed,
            embedded: self.use_embedded_wallet,
        }
    }

    pub fn get_merit(&self, token_id: TokenId) -> MeritView {
        let token = self.token(&token_id);
        self.token_view(&token_id, &token)
    }

    /// True when `account_id` holds the Merit (or a live lend of it)
    /// AND the Merit's stamps satisfy every stamp the job requires.
    pub fn can_access(&self, token_id: TokenId, job_id: String, account_id: AccountId) -> bool {
        let Some(token) = self.tokens.get(&token_id) else {
            return false;
        };
        let Some(job) = self.jobs.get(&job_id) else {
            return false;
        };
        let delegated = match &token.lend {
            Some(l) => l.to == account_id && env::block_timestamp() < l.expires_at,
            None => false,
        };
        if account_id != token.owner_id && !delegated {
            return false;
        }
        Self::stamps_satisfy(&token, &job.required_stamps)
    }

    pub fn get_job(&self, job_id: String) -> JobView {
        Self::job_view(&self.job(&job_id))
    }

    pub fn list_jobs(&self, from_index: Option<U64>, limit: Option<u64>) -> Vec<JobView> {
        let total = self.job_ids.len() as u64;
        let (start, end) = paginate(total, from_index, limit);
        (start..end)
            .filter_map(|i| {
                let id = self.job_ids.get(i as u32)?;
                self.jobs.get(id.as_str()).map(|j| Self::job_view(j))
            })
            .collect()
    }

    /// The skills that may be awarded as job completion stamps.
    pub fn list_completion_skills(&self) -> Vec<String> {
        self.completion_skills.iter().cloned().collect()
    }

    /// The price of one kit tool bought with retained balance.
    pub fn kit_price(&self) -> U128 {
        U128(KIT_PRICE)
    }

    pub fn get_kit(&self, kit_token_id: String) -> KitView {
        let kit = self
            .kits
            .get(&kit_token_id)
            .unwrap_or_else(|| env::panic_str(&format!("kit not found: {}", kit_token_id)));
        KitView {
            kit_token_id: kit.kit_token_id.clone(),
            name: kit.name.clone(),
            owner_id: kit.owner_id.clone(),
            inside_merit: kit.inside_merit.clone(),
        }
    }

    // ---- Wallet publishing (global contract) ----

    /// Publish the wallet code ONCE as a global contract (by code
    /// hash), so every sub-account can reference it cheaply. Owner-
    /// only. The code hash is recorded by the callback on success.
    /// The one-time storage cost (~1.14 NEAR for the 113,927-byte
    /// wallet) comes from the contract account's balance.
    pub fn deploy_wallet_global(&mut self) -> Promise {
        self.require_owner();
        assert!(!self.wallet_deployed, "wallet global contract already deployed");
        Promise::new(env::current_account_id())
            .deploy_global_contract(WALLET_WASM.to_vec())
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_wallet_global_deployed(),
            )
    }

    /// Callback for `deploy_wallet_global`. Records the wallet code
    /// hash on success; leaves `wallet_deployed` false on failure.
    #[private]
    pub fn on_wallet_global_deployed(&mut self) {
        assert_eq!(env::promise_results_count(), 1, "expected one promise result");
        match env::promise_result(0) {
            PromiseResult::Successful(_) => {
                self.wallet_code_hash = Some(wallet_code_hash().to_vec());
                self.wallet_deployed = true;
            }
            PromiseResult::Failed => {
                env::log_str("global wallet deployment failed; wallet not deployed");
            }
        }
    }

    /// Fallback switch (owner-only): when true, mints deploy the
    /// wallet wasm to each sub-account instead of referencing the
    /// global contract (~1.14 NEAR of code storage per mint, drawn
    /// from the contract's balance — for proving the mechanism only).
    pub fn set_use_embedded_wallet(&mut self, use_embedded: bool) {
        self.require_owner();
        self.use_embedded_wallet = use_embedded;
    }

    // ---- Mint: creates the token AND its real sub-account ----

    /// Mint a blank Merit for `receiver_id`. Payable 0.1 NEAR:
    /// 0.05 NEAR goes into the new sub-account (account + wallet
    /// state + buffer), 0.05 NEAR stays in the contract for token
    /// storage.
    ///
    /// The token record is written by the `on_mint_subaccount_created`
    /// callback, only once the sub-account + wallet exist — so a failed
    /// sub-account creation never leaves an orphan token (the 0.1
    /// NEAR is refunded to the minter instead).
    #[payable]
    pub fn nft_mint(
        &mut self,
        token_id: TokenId,
        receiver_id: AccountId,
        metadata: Option<TokenMetadata>,
    ) -> Promise {
        validate_token_id(&token_id);
        assert_eq!(
            env::attached_deposit().as_yoctonear(),
            MINT_PRICE,
            "nft_mint requires exactly 0.1 NEAR attached"
        );
        assert!(!self.tokens.contains_key(&token_id), "token already exists");
        let sub: AccountId = subaccount_id(&token_id, &env::current_account_id())
            .parse()
            .unwrap_or_else(|_| env::panic_str("token_id is not a valid sub-account name"));
        let init_args =
            near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({"parent": env::current_account_id()}))
                .unwrap_or_else(|_| env::panic_str("failed to encode wallet init args"));
        let minter = env::predecessor_account_id();
        let mut promise = Promise::new(sub)
            .create_account()
            .transfer(NearToken::from_yoctonear(SUBACCOUNT_INIT));
        if self.use_embedded_wallet {
            promise = promise.deploy_contract(WALLET_WASM.to_vec());
        } else {
            let hash: CryptoHash = self
                .wallet_code_hash
                .clone()
                .unwrap_or_else(|| {
                    env::panic_str(
                        "wallet global contract not deployed yet; owner must call deploy_wallet_global",
                    )
                })
                .try_into()
                .unwrap_or_else(|_| env::panic_str("stored wallet code hash is not 32 bytes"));
            promise = promise.use_global_contract(hash);
        }
        promise
            .function_call("init", init_args, NearToken::from_yoctonear(0), MINT_INIT_GAS)
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_mint_subaccount_created(token_id, receiver_id, metadata, minter),
            )
    }

    /// Callback for `nft_mint`. On success the token is created and
    /// the mint event emitted. On failure the minter is refunded the
    /// 0.1 NEAR (no panic here: panicking would discard the refund).
    #[private]
    pub fn on_mint_subaccount_created(
        &mut self,
        token_id: TokenId,
        receiver_id: AccountId,
        metadata: Option<TokenMetadata>,
        minter: AccountId,
    ) {
        assert_eq!(env::promise_results_count(), 1, "expected one promise result");
        match env::promise_result(0) {
            PromiseResult::Successful(_) => {
                let token = MeritToken {
                    owner_id: receiver_id.clone(),
                    metadata,
                    stamps: Vec::new(),
                    withdrawable: 0,
                    retained: 0,
                    kit: Vec::new(),
                    lend: None,
                    ever_stamped: false,
                };
                self.tokens.insert(token_id.clone(), token);
                self.token_ids.push(token_id.clone());
                NftMint {
                    owner_id: receiver_id.as_ref(),
                    token_ids: &[&token_id],
                    memo: None,
                }
                .emit();
            }
            PromiseResult::Failed => {
                env::log_str(&format!(
                    "sub-account creation failed for token {}; refunding minter",
                    token_id
                ));
                Promise::new(minter).transfer(NearToken::from_yoctonear(MINT_PRICE));
            }
        }
    }

    // ---- NEP-171 transfer (panics when locked) ----

    /// NEP-171 transfer. Panics if the Merit is locked (it has any
    /// stamp — credentials cannot be bought). Only the holder may
    /// transfer; no approvals are implemented. A transfer clears any
    /// active lend. Requires exactly 1 yoctoNEAR attached.
    #[payable]
    pub fn nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
    ) {
        let _ = approval_id; // approvals are not implemented
        assert_eq!(
            env::attached_deposit().as_yoctonear(),
            TRANSFER_DEPOSIT,
            "nft_transfer requires exactly 1 yoctoNEAR attached"
        );
        let mut token = self.token(&token_id);
        assert!(
            !token.ever_stamped,
            "locked Merit cannot be transferred: it carries earned credentials"
        );
        assert_eq!(
            env::predecessor_account_id(),
            token.owner_id,
            "caller is not the token owner"
        );
        assert_ne!(receiver_id, token.owner_id, "cannot transfer to self");
        let old_owner = token.owner_id.clone();
        token.owner_id = receiver_id.clone();
        token.lend = None;
        self.tokens.insert(token_id.clone(), token);
        NftTransfer {
            old_owner_id: old_owner.as_ref(),
            new_owner_id: receiver_id.as_ref(),
            token_ids: &[&token_id],
            authorized_id: None,
            memo: memo.as_deref(),
        }
        .emit();
    }

    // ---- Stamps / credentials (whitelist only) ----

    /// Stamp a credential onto a Merit. Whitelisted-issuer-only.
    /// Level 1-3. Re-stamping the same skill updates its level,
    /// issuer and time. The first stamp locks the Merit. The stamp
    /// records the issuer account and its whitelist display name.
    pub fn stamp(&mut self, token_id: TokenId, skill: String, level: u8) {
        self.require_issuer();
        assert!((1..=3).contains(&level), "stamp level must be 1-3");
        assert!(!skill.is_empty() && skill.len() <= 64, "skill must be 1-64 characters");
        let mut token = self.token(&token_id);
        let now = env::block_timestamp();
        let issuer = env::predecessor_account_id();
        let issuer_name = self.issuer_name(&issuer);
        if let Some(existing) = token.stamps.iter_mut().find(|s| s.skill == skill) {
            existing.level = level;
            existing.issuer = issuer;
            existing.issuer_name = issuer_name;
            existing.stamped_at = now;
        } else {
            assert!(
                token.stamps.len() < MAX_STAMPS,
                "too many distinct stamps on this Merit"
            );
            token.stamps.push(Stamp {
                skill,
                level,
                issuer,
                issuer_name,
                stamped_at: now,
            });
        }
        token.ever_stamped = true;
        self.tokens.insert(token_id, token);
    }

    /// The demo skills test. Holder-only. The submitted answer is
    /// SHA-256 hashed and compared to the hash stored at init; a
    /// correct answer stamps skill "merit-basics" at level 1 (which
    /// locks the Merit). The answer is "merit" — a demo test, not a
    /// secret; see README. The stamp is a system stamp: issuer is
    /// the contract account, issuer_name is "Merit Test".
    pub fn pass_test(&mut self, token_id: TokenId, answer: String) {
        let mut token = self.token(&token_id);
        self.require_holder(&token);
        assert!(
            !token.stamps.iter().any(|s| s.skill == TEST_SKILL),
            "test already passed for this Merit"
        );
        assert_eq!(
            env::sha256(answer.as_bytes()),
            self.test_answer_hash,
            "wrong answer"
        );
        assert!(
            token.stamps.len() < MAX_STAMPS,
            "too many distinct stamps on this Merit"
        );
        token.stamps.push(Stamp {
            skill: TEST_SKILL.to_string(),
            level: 1,
            issuer: env::current_account_id(),
            issuer_name: TEST_ISSUER_NAME.to_string(),
            stamped_at: env::block_timestamp(),
        });
        token.ever_stamped = true;
        self.tokens.insert(token_id, token);
    }

    // ---- Jobs ----

    /// Post a job, escrowing its payment: the payment IS the attached
    /// deposit (in full). Anyone may post. Minimum 0.001 NEAR so a
    /// job is worth doing. `timeout_ns` is optional; when omitted the
    /// job uses the 7-day default. The dispute arbiter is ALWAYS the
    /// contract's Merit DAO (`dao_id`): no caller may name another
    /// arbiter. `completion_stamp` is the credential the worker earns
    /// on success, and its skill must be in the completion skill
    /// registry (governed by the DAO) — a poster cannot invent a
    /// credential. `criteria` is REQUIRED (non-empty): the acceptance
    /// criteria the work is judged against — the arbiter can only
    /// judge against what is written. Description is capped at 2000
    /// characters and required_stamps at 10 entries.
    #[payable]
    pub fn create_job(
        &mut self,
        job_id: String,
        title: String,
        description: String,
        required_stamps: Vec<RequiredStamp>,
        completion_stamp: CompletionStamp,
        criteria: String,
        timeout_ns: Option<U64>,
    ) {
        let payment = env::attached_deposit().as_yoctonear();
        assert!(payment >= ONE_NEAR / 1000, "job payment must be at least 0.001 NEAR");
        assert!(!job_id.is_empty() && job_id.len() <= 64, "job_id must be 1-64 characters");
        assert!(!self.jobs.contains_key(&job_id), "job already exists");
        assert!(!title.is_empty() && title.len() <= 128, "title must be 1-128 characters");
        assert!(
            description.len() <= MAX_DESCRIPTION_LEN,
            "description must be at most 2000 characters"
        );
        assert!(
            required_stamps.len() <= MAX_REQUIRED_STAMPS,
            "required_stamps must have at most 10 entries"
        );
        assert!(
            !criteria.is_empty() && criteria.len() <= MAX_CRITERIA_LEN,
            "criteria must be 1-2000 characters"
        );
        for r in &required_stamps {
            assert!((1..=3).contains(&r.min_level), "required min_level must be 1-3");
            assert!(!r.skill.is_empty() && r.skill.len() <= 64, "skill must be 1-64 characters");
        }
        assert!(
            !completion_stamp.skill.is_empty() && completion_stamp.skill.len() <= 64,
            "completion_stamp skill must be 1-64 characters"
        );
        assert!(
            (1..=3).contains(&completion_stamp.level),
            "completion_stamp level must be 1-3"
        );
        assert!(
            self.is_completion_skill(&completion_stamp.skill),
            "completion_stamp skill is not registered"
        );
        let timeout_ns = timeout_ns.map(|t| t.0).unwrap_or(DEFAULT_TIMEOUT_NS);
        assert!(timeout_ns > 0, "timeout_ns must be positive");
        self.jobs.insert(
            job_id.clone(),
            Job {
                job_id: job_id.clone(),
                title,
                description,
                payment,
                required_stamps,
                completion_stamp,
                criteria,
                poster: env::predecessor_account_id(),
                arbiter: self.dao_id.clone(),
                poster_evidence: None,
                worker_evidence: None,
                poster_evidence_ref: None,
                worker_evidence_ref: None,
                refund_pending: false,
                status: JobStatus::Open,
                accepted_by: None,
                timeout_ns,
                accepted_at: None,
            },
        );
        self.job_ids.push(job_id);
    }

    /// Cancel an Open job and refund the exact escrow to the poster.
    /// Poster-only, only while the job is Open: never after
    /// acceptance or while disputed. The job is marked Cancelled
    /// BEFORE the refund transfer is issued, so the escrow can
    /// never be refunded twice; if the transfer fails, the private
    /// callback leaves refund_pending set and the poster may retry
    /// with retry_cancel_refund.
    pub fn cancel_job(&mut self, job_id: String) -> Promise {
        let mut job = self.job(&job_id);
        assert_eq!(
            env::predecessor_account_id(),
            job.poster,
            "only the poster may cancel the job"
        );
        assert_eq!(job.status, JobStatus::Open, "only an open job can be cancelled");
        let payment = job.payment;
        let poster = job.poster.clone();
        job.status = JobStatus::Cancelled;
        job.refund_pending = true;
        self.jobs.insert(job_id.clone(), job);
        Promise::new(poster)
            .transfer(NearToken::from_yoctonear(payment))
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_cancel_refund(job_id),
            )
    }

    /// Retry a failed cancel refund. Poster-only, only while the
    /// job is Cancelled with a refund still pending. A successful
    /// refund clears the pending flag; a second failure leaves it
    /// pending for another retry, without double payment.
    pub fn retry_cancel_refund(&mut self, job_id: String) -> Promise {
        let job = self.job(&job_id);
        assert_eq!(
            env::predecessor_account_id(),
            job.poster,
            "only the poster may retry the cancel refund"
        );
        assert_eq!(job.status, JobStatus::Cancelled, "job is not cancelled");
        assert!(job.refund_pending, "no cancel refund is pending");
        let payment = job.payment;
        let poster = job.poster.clone();
        Promise::new(poster)
            .transfer(NearToken::from_yoctonear(payment))
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_cancel_refund(job_id),
            )
    }

    /// Callback for cancel_job / retry_cancel_refund. On success
    /// the refund is settled and the pending flag clears; on
    /// failure the flag stays set so the poster can retry.
    #[private]
    pub fn on_cancel_refund(&mut self, job_id: String) {
        assert_eq!(env::promise_results_count(), 1, "expected one promise result");
        if matches!(env::promise_result(0), PromiseResult::Successful(_)) {
            let mut job = self.job(&job_id);
            job.refund_pending = false;
            self.jobs.insert(job_id, job);
        } else {
            env::log_str("cancel refund failed; refund remains pending for retry");
        }
    }

    /// Add a skill to the completion stamp registry. DAO-only: the
    /// registry is what stops a poster inventing a credential, so
    /// only the DAO may extend it.
    pub fn add_completion_skill(&mut self, skill: String) {
        self.require_dao();
        assert!(!skill.is_empty() && skill.len() <= 64, "skill must be 1-64 characters");
        assert!(!self.is_completion_skill(&skill), "skill is already registered");
        self.completion_skills.push(skill);
    }

    /// Remove a skill from the completion stamp registry. DAO-only.
    /// Jobs already posted keep their recorded completion stamp.
    pub fn remove_completion_skill(&mut self, skill: String) {
        self.require_dao();
        assert!(self.is_completion_skill(&skill), "skill is not registered");
        let kept: Vec<String> = self
            .completion_skills
            .iter()
            .filter(|s| *s != &skill)
            .cloned()
            .collect();
        self.completion_skills.clear();
        for s in kept {
            self.completion_skills.push(s);
        }
    }

    /// Take an open job with a Merit. Caller must hold the Merit (or
    /// a live lend of it) and the Merit must satisfy the job's stamp
    /// requirements. Records accepted_at; the deadline starts here.
    pub fn accept_job(&mut self, job_id: String, token_id: TokenId) {
        let token = self.token(&token_id);
        self.require_access(&token);
        let mut job = self.job(&job_id);
        assert_eq!(job.status, JobStatus::Open, "job is not open");
        assert!(
            Self::stamps_satisfy(&token, &job.required_stamps),
            "Merit does not satisfy the job's required stamps"
        );
        job.status = JobStatus::Accepted;
        job.accepted_by = Some(token_id);
        job.accepted_at = Some(env::block_timestamp());
        self.jobs.insert(job_id, job);
    }

    /// Confirm completion: release the escrowed payment to the
    /// worker's Merit (95/5 split into its sub-account) and issue
    /// the job's completion stamp. POSTER-only: the poster confirms
    /// the work is done. Fails while the job is disputed (status
    /// Disputed) or if the caller is not the poster.
    pub fn complete_job(&mut self, job_id: String, token_id: TokenId) {
        let mut job = self.job(&job_id);
        assert_eq!(
            env::predecessor_account_id(),
            job.poster,
            "only the poster may confirm completion"
        );
        assert_eq!(job.status, JobStatus::Accepted, "job is not accepted");
        assert_eq!(
            job.accepted_by.as_deref(),
            Some(token_id.as_str()),
            "this Merit is not assigned to the job"
        );
        // Validate the token exists before settling.
        let _ = self.token(&token_id);
        let payment = job.payment;
        let stamp = job.completion_stamp.clone();
        job.status = JobStatus::Completed;
        self.jobs.insert(job_id, job);
        self.pay_merit(&token_id, payment);
        self.issue_completion_stamp(&token_id, &stamp);
    }

    /// Auto-release after the deadline: if the poster never confirms
    /// and never disputes, ANYONE may call this once the deadline
    /// (accepted_at + timeout) has passed. The escrow pays the
    /// worker's Merit (same 95/5 split as a normal completion) and
    /// the completion stamp is issued — silence is not a dispute:
    /// unchallenged work stands. Fails before the deadline or while
    /// the job is disputed.
    pub fn release_job(&mut self, job_id: String) {
        let job = self.job(&job_id);
        assert_eq!(job.status, JobStatus::Accepted, "job is not accepted");
        let accepted_at = job
            .accepted_at
            .unwrap_or_else(|| env::panic_str("accepted job has no accepted_at"));
        assert!(
            env::block_timestamp() >= job_deadline(accepted_at, job.timeout_ns),
            "job deadline has not passed yet"
        );
        let token_id = job
            .accepted_by
            .clone()
            .unwrap_or_else(|| env::panic_str("job has no assigned Merit"));
        let payment = job.payment;
        let stamp = job.completion_stamp.clone();
        let mut job = job;
        job.status = JobStatus::Completed;
        self.jobs.insert(job_id, job);
        self.pay_merit(&token_id, payment);
        self.issue_completion_stamp(&token_id, &stamp);
    }

    /// Raise a dispute on an accepted job, BEFORE the deadline.
    /// Caller must be the poster or the worker (holder or live lend
    /// delegate of the assigned Merit). Status becomes Disputed,
    /// which blocks complete_job and release_job and holds both the
    /// payment and the stamp until the arbiter resolves.
    pub fn raise_dispute(&mut self, job_id: String) {
        let mut job = self.job(&job_id);
        assert_eq!(job.status, JobStatus::Accepted, "job is not accepted");
        let accepted_at = job
            .accepted_at
            .unwrap_or_else(|| env::panic_str("accepted job has no accepted_at"));
        assert!(
            env::block_timestamp() < job_deadline(accepted_at, job.timeout_ns),
            "cannot dispute after the deadline"
        );
        let caller = env::predecessor_account_id();
        assert!(
            caller == job.poster || self.is_worker(&job, &caller),
            "only the poster or the worker may raise a dispute"
        );
        job.status = JobStatus::Disputed;
        self.jobs.insert(job_id, job);
    }

    /// Submit evidence for an open dispute: the SHA-256 hex of the
    /// evidence bytes (the work product, photos, text), plus an
    /// optional content reference (a URI or CID) where the council
    /// can retrieve the evidence and check it against the hash.
    /// Callable by the poster or the worker while the job is
    /// Disputed. The evidence itself stays offchain — only its hash
    /// and reference are recorded, so the arbiter judges the exact
    /// evidence each side submitted. A side may re-submit (the
    /// latest hash and reference count).
    pub fn submit_evidence(
        &mut self,
        job_id: String,
        evidence_hash: String,
        evidence_ref: Option<String>,
    ) {
        validate_evidence_hash(&evidence_hash);
        if let Some(ref r) = evidence_ref {
            assert!(
                !r.is_empty() && r.len() <= MAX_EVIDENCE_REF_LEN,
                "evidence_ref must be 1-512 characters"
            );
        }
        let mut job = self.job(&job_id);
        assert_eq!(job.status, JobStatus::Disputed, "job is not disputed");
        let caller = env::predecessor_account_id();
        if caller == job.poster {
            job.poster_evidence = Some(evidence_hash);
            job.poster_evidence_ref = evidence_ref;
        } else if self.is_worker(&job, &caller) {
            job.worker_evidence = Some(evidence_hash);
            job.worker_evidence_ref = evidence_ref;
        } else {
            env::panic_str("only the poster or the worker may submit evidence");
        }
        self.jobs.insert(job_id, job);
    }

    /// Execute a dispute outcome (called by `resolve_dispute`).
    /// Validates the outcome and `partial_amount`, then settles:
    /// sets the job status, pays the worker's Merit and/or refunds
    /// the poster, and issues the completion stamp when
    /// `issue_stamp` is true. Refund never stamps, whatever the
    /// flag. Once this runs the dispute is closed: the job is no
    /// longer Disputed, so no further resolution is accepted.
    fn execute_dispute_outcome(
        &mut self,
        mut job: Job,
        outcome: &str,
        partial_amount: Option<u128>,
        issue_stamp: bool,
    ) {
        let token_id = job
            .accepted_by
            .clone()
            .unwrap_or_else(|| env::panic_str("job has no assigned Merit"));
        let payment = job.payment;
        let stamp = job.completion_stamp.clone();
        let poster = job.poster.clone();
        match outcome {
            "pay_full" => {
                job.status = JobStatus::Completed;
                self.jobs.insert(job.job_id.clone(), job);
                self.pay_merit(&token_id, payment);
                if issue_stamp {
                    self.issue_completion_stamp(&token_id, &stamp);
                }
            }
            "refund" => {
                job.status = JobStatus::Refunded;
                self.jobs.insert(job.job_id.clone(), job);
                Promise::new(poster)
                    .transfer(NearToken::from_yoctonear(payment))
                    .detach();
            }
            "partial" => {
                let worker_amount = partial_amount
                    .unwrap_or_else(|| env::panic_str("partial requires partial_amount"));
                assert!(worker_amount > 0, "partial_amount must be positive");
                assert!(
                    worker_amount <= payment,
                    "partial_amount exceeds the escrowed payment"
                );
                job.status = JobStatus::PartiallyPaid;
                self.jobs.insert(job.job_id.clone(), job);
                self.pay_merit(&token_id, worker_amount);
                let remainder = payment - worker_amount;
                if remainder > 0 {
                    Promise::new(poster)
                        .transfer(NearToken::from_yoctonear(remainder))
                        .detach();
                }
                if issue_stamp {
                    self.issue_completion_stamp(&token_id, &stamp);
                }
            }
            _ => env::panic_str("outcome must be pay_full, refund or partial"),
        }
    }

    /// Resolve an open dispute. ONLY the job's recorded arbiter DAO
    /// may call this: the predecessor must be the job's arbiter DAO
    /// contract (normally the Merit DAO executing a passed council
    /// proposal). Any other caller — person or contract — is
    /// rejected. The decision is final: once resolved, no further
    /// resolution is accepted. If the DAO council rejects a
    /// proposal, the dispute stays open and another proposal with a
    /// different outcome may be made.
    /// - "pay_full": the full escrow goes to the worker's Merit
    ///   (95/5 split) and the completion stamp is issued.
    /// - "refund": the full escrow returns to the poster; no pay,
    ///   no stamp.
    /// - "partial": `partial_amount` (<= escrow) goes to the worker's
    ///   Merit (95/5 split), the remainder refunds to the poster,
    ///   and NO stamp is issued.
    pub fn resolve_dispute(
        &mut self,
        job_id: String,
        outcome: String,
        partial_amount: Option<U128>,
    ) {
        let job = self.job(&job_id);
        assert_eq!(
            env::predecessor_account_id(),
            job.arbiter,
            "caller is not the job's arbiter DAO"
        );
        assert_eq!(job.status, JobStatus::Disputed, "job is not disputed");
        let issue_stamp = outcome == "pay_full";
        self.execute_dispute_outcome(job, &outcome, partial_amount.map(|a| a.0), issue_stamp);
    }

    // ---- Withdraw ----

    /// Withdraw `amount` of the withdrawable balance to the holder.
    /// Holder-only: a lend delegate can work jobs but cannot touch
    /// the money. The balance is debited before the wallet payout is
    /// issued, so two concurrent withdrawals can never double-spend.
    /// The NEAR comes out of the token's own sub-account wallet.
    pub fn withdraw(&mut self, token_id: TokenId, amount: U128) -> Promise {
        let mut token = self.token(&token_id);
        self.require_holder(&token);
        let amount: u128 = amount.into();
        assert!(amount > 0, "withdraw amount must be positive");
        assert!(
            amount <= token.withdrawable,
            "withdraw exceeds withdrawable balance"
        );
        token.withdrawable -= amount;
        let owner = token.owner_id.clone();
        self.tokens.insert(token_id.clone(), token);
        let sub: AccountId = subaccount_id(&token_id, &env::current_account_id())
            .parse()
            .unwrap_or_else(|_| env::panic_str("token sub-account id invalid"));
        ext_wallet::ext(sub)
            .with_static_gas(PAYOUT_GAS)
            .payout(owner, U128(amount))
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_withdraw(token_id, U128(amount)),
            )
    }

    /// Callback for `withdraw`. If the wallet payout failed, the
    /// debited amount is restored to the withdrawable balance.
    #[private]
    pub fn on_withdraw(&mut self, token_id: TokenId, amount: U128) {
        assert_eq!(env::promise_results_count(), 1, "expected one promise result");
        if matches!(env::promise_result(0), PromiseResult::Failed) {
            env::log_str("wallet payout failed; restoring withdrawable balance");
            let mut token = self.token(&token_id);
            token.withdrawable += amount.0;
            self.tokens.insert(token_id, token);
        }
    }

    // ---- Kit ----

    /// Mint a kit tool token to `receiver_id`. Whitelisted-issuer
    /// only (the owner is whitelisted at init as "Merit DAO").
    pub fn mint_kit(&mut self, kit_token_id: String, name: String, receiver_id: AccountId) {
        self.require_issuer();
        assert!(
            !kit_token_id.is_empty() && kit_token_id.len() <= 64,
            "kit_token_id must be 1-64 characters"
        );
        assert!(
            kit_token_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
            "kit_token_id may only contain letters, digits, hyphens and underscores"
        );
        assert!(!name.is_empty() && name.len() <= 128, "name must be 1-128 characters");
        assert!(!self.kits.contains_key(&kit_token_id), "kit token already exists");
        self.kits.insert(
            kit_token_id.clone(),
            KitToken {
                kit_token_id,
                name,
                owner_id: receiver_id,
                inside_merit: None,
            },
        );
    }

    /// Move a kit tool the caller owns into a Merit the caller holds.
    pub fn deposit_kit(&mut self, token_id: TokenId, kit_token_id: String) {
        let mut token = self.token(&token_id);
        self.require_holder(&token);
        let mut kit = self
            .kits
            .get(&kit_token_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str(&format!("kit not found: {}", kit_token_id)));
        assert_eq!(
            env::predecessor_account_id(),
            kit.owner_id,
            "caller does not own this kit token"
        );
        assert!(kit.inside_merit.is_none(), "kit is already inside a Merit");
        kit.inside_merit = Some(token_id.clone());
        self.kits.insert(kit_token_id.clone(), kit);
        token.kit.push(kit_token_id);
        self.tokens.insert(token_id, token);
    }

    /// Remove a kit tool from a Merit the caller holds. The tool
    /// stays owned by the same account, just no longer inside.
    pub fn withdraw_kit(&mut self, token_id: TokenId, kit_token_id: String) {
        let mut token = self.token(&token_id);
        self.require_holder(&token);
        let mut kit = self
            .kits
            .get(&kit_token_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str(&format!("kit not found: {}", kit_token_id)));
        assert_eq!(
            kit.inside_merit.as_deref(),
            Some(token_id.as_str()),
            "kit is not inside this Merit"
        );
        kit.inside_merit = None;
        self.kits.insert(kit_token_id.clone(), kit);
        token.kit.retain(|k| k != &kit_token_id);
        self.tokens.insert(token_id, token);
    }

    /// Buy a kit tool with the Merit's retained balance.
    /// Holder-only. The kit must exist and not already be inside a
    /// Merit, and the Merit's retained balance must cover KIT_PRICE
    /// (0.1 NEAR). The retained balance is debited before the
    /// payout, and the kit moves to the holder inside this Merit;
    /// the seller is paid KIT_PRICE from the Merit's own sub-account
    /// wallet. Withdrawable funds can never be spent through this
    /// path. If the wallet payout fails, the private callback
    /// restores the retained balance and returns the kit to the
    /// seller, so neither funds nor kit are lost.
    pub fn buy_kit(&mut self, token_id: TokenId, kit_token_id: String) -> Promise {
        let mut token = self.token(&token_id);
        self.require_holder(&token);
        let mut kit = self
            .kits
            .get(&kit_token_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str(&format!("kit not found: {}", kit_token_id)));
        assert!(kit.inside_merit.is_none(), "kit is already inside a Merit");
        let seller = kit.owner_id.clone();
        assert_ne!(seller, token.owner_id, "caller already owns this kit token");
        assert!(
            token.retained >= KIT_PRICE,
            "retained balance is below the kit price"
        );
        token.retained -= KIT_PRICE;
        kit.owner_id = token.owner_id.clone();
        kit.inside_merit = Some(token_id.clone());
        self.kits.insert(kit_token_id.clone(), kit);
        token.kit.push(kit_token_id.clone());
        self.tokens.insert(token_id.clone(), token);
        let sub: AccountId = subaccount_id(&token_id, &env::current_account_id())
            .parse()
            .unwrap_or_else(|_| env::panic_str("token sub-account id invalid"));
        ext_wallet::ext(sub)
            .with_static_gas(PAYOUT_GAS)
            .payout(seller.clone(), U128(KIT_PRICE))
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_buy_kit(token_id, kit_token_id, seller),
            )
    }

    /// Callback for buy_kit. On success nothing more is needed.
    /// On failure the retained debit is restored and the kit
    /// returns to the seller outside any Merit.
    #[private]
    pub fn on_buy_kit(&mut self, token_id: TokenId, kit_token_id: String, seller: AccountId) {
        assert_eq!(env::promise_results_count(), 1, "expected one promise result");
        if matches!(env::promise_result(0), PromiseResult::Failed) {
            env::log_str("kit payout failed; restoring retained balance and returning the kit");
            let mut token = self.token(&token_id);
            token.retained += KIT_PRICE;
            token.kit.retain(|k| k != &kit_token_id);
            self.tokens.insert(token_id, token);
            if let Some(mut kit) = self.kits.get(&kit_token_id).cloned() {
                kit.owner_id = seller;
                kit.inside_merit = None;
                self.kits.insert(kit_token_id, kit);
            }
        }
    }

    // ---- Lend ----

    /// Delegate access to `to` until `expires_at` (nanosecond
    /// timestamp). Holder-only. The delegate can open gates and do
    /// jobs, but cannot transfer or withdraw. Expiry is enforced
    /// onchain by every access check.
    pub fn lend(&mut self, token_id: TokenId, to: AccountId, expires_at: U64) {
        let mut token = self.token(&token_id);
        self.require_holder(&token);
        assert_ne!(to, token.owner_id, "cannot lend to yourself");
        assert!(
            expires_at.0 > env::block_timestamp(),
            "lend expiry must be in the future"
        );
        token.lend = Some(LendInfo {
            to,
            expires_at: expires_at.0,
        });
        self.tokens.insert(token_id, token);
    }

    /// Cancel any active lend. Holder-only. Idempotent.
    pub fn revoke_lend(&mut self, token_id: TokenId) {
        let mut token = self.token(&token_id);
        self.require_holder(&token);
        token.lend = None;
        self.tokens.insert(token_id, token);
    }

    // ---- Issuers / owner ----

    /// Add an issuer to the whitelist with a display name.
    /// DAO-only: issuer control is governance, not an owner switch.
    pub fn add_issuer(&mut self, account_id: AccountId, name: String) {
        self.require_dao();
        assert!(!name.is_empty() && name.len() <= 64, "name must be 1-64 characters");
        if !self.issuers.contains_key(&account_id) {
            self.issuer_ids.push(account_id.clone());
        }
        self.issuers.insert(account_id, name);
    }

    /// Remove an issuer from the whitelist. DAO-only. The owner
    /// can be removed (the DAO can always add them back).
    pub fn remove_issuer(&mut self, account_id: AccountId) {
        self.require_dao();
        self.issuers.remove(&account_id);
        // Note: issuer_ids keeps the id; list_issuers skips ids with
        // no whitelist entry, so removal is visible immediately.
    }

    /// Revoke a stamp from a Merit. Callable by the Merit DAO or
    /// by the issuer recorded on that stamp (a removed issuer may
    /// still revoke a stamp they issued). Removing a stamp never
    /// unlocks the Merit: once a Merit has earned a stamp it stays
    /// locked, so a credential cannot be erased to free a Merit
    /// for sale.
    pub fn revoke_stamp(&mut self, token_id: TokenId, skill: String) {
        let mut token = self.token(&token_id);
        let pos = token
            .stamps
            .iter()
            .position(|s| s.skill == skill)
            .unwrap_or_else(|| env::panic_str("stamp not found"));
        let issuer = token.stamps[pos].issuer.clone();
        let caller = env::predecessor_account_id();
        assert!(
            caller == self.dao_id || caller == issuer,
            "caller is neither the Merit DAO nor the stamp issuer"
        );
        token.stamps.remove(pos);
        self.tokens.insert(token_id, token);
    }

    /// Change the Merit DAO account (the default arbiter for new
    /// jobs). Owner-only. Existing jobs keep their recorded
    /// arbiter DAO.
    pub fn set_dao(&mut self, dao_id: AccountId) {
        self.require_owner();
        self.dao_id = dao_id;
    }

}

/// Pre-audit contract state, exactly as deployed (v1). Only
/// used by migrate() to read the old state blob and convert it.
#[derive(BorshDeserialize, BorshSerialize)]
pub struct OldMerit {
    pub owner: AccountId,
    pub dao_id: AccountId,
    pub issuers: LookupMap<AccountId, String>,
    pub issuer_ids: Vector<AccountId>,
    pub tokens: LookupMap<TokenId, OldMeritToken>,
    pub token_ids: Vector<TokenId>,
    pub jobs: LookupMap<String, OldJob>,
    pub job_ids: Vector<String>,
    pub kits: LookupMap<String, KitToken>,
    pub test_answer_hash: Vec<u8>,
    pub wallet_code_hash: Option<Vec<u8>>,
    pub wallet_deployed: bool,
    pub use_embedded_wallet: bool,
}

/// Pre-audit token state: as MeritToken but without ever_stamped.
#[derive(BorshDeserialize, BorshSerialize)]
pub struct OldMeritToken {
    pub owner_id: AccountId,
    pub metadata: Option<TokenMetadata>,
    pub stamps: Vec<Stamp>,
    pub withdrawable: u128,
    pub retained: u128,
    pub kit: Vec<String>,
    pub lend: Option<LendInfo>,
}

/// Pre-audit job state: as Job but without the evidence refs and
/// without refund_pending.
#[derive(BorshDeserialize, BorshSerialize)]
pub struct OldJob {
    pub job_id: String,
    pub title: String,
    pub description: String,
    pub payment: u128,
    pub required_stamps: Vec<RequiredStamp>,
    pub completion_stamp: CompletionStamp,
    pub criteria: String,
    pub poster: AccountId,
    pub arbiter: AccountId,
    pub poster_evidence: Option<String>,
    pub worker_evidence: Option<String>,
    pub status: JobStatus,
    pub accepted_by: Option<TokenId>,
    pub timeout_ns: u64,
    pub accepted_at: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_id_validation_accepts_good_ids() {
        for id in ["a", "merit-1", "welder-007", "a1-b2-c3"] {
            validate_token_id(id);
        }
    }

    #[test]
    #[should_panic(expected = "token_id must be 1-32 characters")]
    fn token_id_validation_rejects_empty() {
        validate_token_id("");
    }

    #[test]
    #[should_panic(expected = "token_id must be 1-32 characters")]
    fn token_id_validation_rejects_too_long() {
        validate_token_id("a-very-long-token-id-that-exceeds-32");
    }

    #[test]
    #[should_panic(expected = "lowercase letters")]
    fn token_id_validation_rejects_uppercase_and_underscore() {
        validate_token_id("Merit_1");
    }

    #[test]
    #[should_panic(expected = "may not start or end with a hyphen")]
    fn token_id_validation_rejects_leading_hyphen() {
        validate_token_id("-merit");
    }

    #[test]
    fn split_payment_is_exact() {
        // 1 NEAR job: 0.95 withdrawable, 0.05 retained.
        assert_eq!(split_payment(ONE_NEAR), (950_000_000_000_000_000_000_000, 50_000_000_000_000_000_000_000));
        // Odd amounts: the two parts always sum to the payment.
        for p in [1u128, 3, 99, 100, 101, 123_456_789] {
            let (w, r) = split_payment(p);
            assert_eq!(w + r, p, "split must be exact for {}", p);
            assert_eq!(w, p * 95 / 100);
        }
    }

    #[test]
    fn merit_level_sums_stamp_levels() {
        let stamps = vec![
            Stamp {
                skill: "welding".to_string(),
                level: 3,
                issuer: "issuer.testnet".parse().unwrap(),
                issuer_name: "Some Issuer".to_string(),
                stamped_at: 0,
            },
            Stamp {
                skill: "merit-basics".to_string(),
                level: 1,
                issuer: "issuer.testnet".parse().unwrap(),
                issuer_name: "Merit Test".to_string(),
                stamped_at: 0,
            },
        ];
        assert_eq!(merit_level(&stamps), 4);
        assert_eq!(merit_level(&[]), 0);
    }

    #[test]
    fn lend_active_respects_expiry() {
        let lend = Some(LendInfo {
            to: "bob.testnet".parse().unwrap(),
            expires_at: 1_000,
        });
        assert!(lend_active(&lend, 999));
        assert!(!lend_active(&lend, 1_000));
        assert!(!lend_active(&lend, 1_001));
        assert!(!lend_active(&None, 0));
    }

    #[test]
    fn subaccount_id_format() {
        let contract: AccountId = "merit.testnet".parse().unwrap();
        assert_eq!(subaccount_id("merit-1", &contract), "merit-1.merit.testnet");
    }

    #[test]
    fn default_timeout_is_seven_days() {
        assert_eq!(DEFAULT_TIMEOUT_NS, 7 * 24 * 60 * 60 * 1_000_000_000);
    }

    #[test]
    fn job_deadline_adds_timeout() {
        assert_eq!(job_deadline(1_000, 5_000), 6_000);
        assert_eq!(job_deadline(0, DEFAULT_TIMEOUT_NS), DEFAULT_TIMEOUT_NS);
    }

    #[test]
    fn hex_encoding() {
        assert_eq!(to_hex(&[0x08, 0x0c, 0xc3, 0xf9]), "080cc3f9");
        assert_eq!(to_hex(&[]), "");
    }



    #[test]
    fn evidence_hash_validation() {
        validate_evidence_hash(&"a".repeat(64));
        validate_evidence_hash("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    }

    #[test]
    #[should_panic(expected = "evidence_hash must be a 64-character")]
    fn evidence_hash_rejects_short() {
        validate_evidence_hash("abcd");
    }

    #[test]
    #[should_panic(expected = "evidence_hash must be a 64-character")]
    fn evidence_hash_rejects_uppercase() {
        validate_evidence_hash(&"A".repeat(64));
    }

    #[test]
    fn pagination_caps_page_size_and_never_traps() {
        assert_eq!(paginate(100, None, None), (0, 50));
        assert_eq!(paginate(100, Some(U64(90)), Some(50)), (90, 100));
        assert_eq!(paginate(3, Some(U64(2)), Some(100)), (2, 3));
        assert_eq!(paginate(3, Some(U64(u64::MAX)), Some(u64::MAX)), (3, 3));
        assert_eq!(paginate(0, None, None), (0, 0));
        assert_eq!(paginate(10, Some(U64(10)), Some(5)), (10, 10));
    }

    #[test]
    fn kit_price_is_a_tenth_near() {
        assert_eq!(KIT_PRICE, ONE_NEAR / 10);
    }

    #[test]
    fn seeded_completion_skills_are_nine() {
        assert_eq!(SEEDED_COMPLETION_SKILLS.len(), 9);
        for skill in ["welding", "torch-work", "gate-welding", "repair-welding", "merit-basics", "coding", "design", "writing", "data-entry"] {
            assert!(SEEDED_COMPLETION_SKILLS.contains(&skill), "seed is missing {}", skill);
        }
    }



}
