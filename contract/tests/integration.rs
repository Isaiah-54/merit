// Merit integration tests — REAL end-to-end proofs against the
// compiled wasm on a local near-workspaces sandbox.
//
// Each test is independent (own sandbox) and covers one behaviour:
//  1. mint creates a REAL sub-account running the wallet contract
//     (get_parent on the sub-account returns the Merit contract;
//     its code hash matches the published wallet code hash), plus
//     NEP-171 enumeration (+ invalid id / duplicate rejected)
//  2. stamp locks the Merit; locked transfer panics; a
//     NON-whitelisted stamp is rejected; a whitelisted stamp
//     carries the issuer display name
//  3. pass_test: wrong answer fails, "merit" stamps merit-basics 1
//     as a "Merit Test" system stamp
//  4. job flow (poster confirms): gate, accept, poster completes,
//     the 2 NEAR payment lands IN THE SUB-ACCOUNT (balance +2
//     exactly), split 1.9 withdrawable / 0.1 retained, holder
//     withdraws 1.9 from the sub-account wallet
//  5. gate denied without the required stamp
//  6. lend: delegate can accept jobs but cannot withdraw or
//     transfer; revoke ends access; past-expiry lend rejected;
//     expiry enforced onchain via fast_forward
//  7. kit: mint, deposit into Merit, withdraw out
//  8. issuer admin: only the DAO adds/removes; removed issuer cannot
//     stamp; list_issuers shows the seeded "Merit DAO" owner
//  9. unlocked transfer works and clears any lend
// 10. poster timeout: release before the deadline fails; release
//     after the deadline (anyone) pays the worker AND issues the
//     completion stamp; an open dispute blocks release and
//     completion; the arbiter DAO resolves (pay_full / refund /
//     partial); a non-DAO resolve call is rejected; a job's arbiter
//     is always the DAO (no caller-supplied arbiter)
// 13. audit regressions (M-01..M-08 + D): completion skill registry,
//     cancel_job exact-once refund, exact mint deposit, MAX_STAMPS
//     on completion stamps, evidence refs, bounds + pagination,
//     buy_kit from retained, DAO-only issuers + revoke_stamp
//     (lock stays once earned), migrate preserves live state
// 11. wallet only obeys the parent: a direct payout call on the
//     sub-account from a non-parent account fails
// 12. DAO proposal-and-vote (REAL Sputnik v2 in the sandbox,
//     council 3, threshold 2): a dispute proposal carrying the
//     outcome is created on the DAO; council approval executes
//     resolve_dispute in the Merit contract (pay_full pays +
//     stamps, refund returns the escrow with no stamp, partial
//     pays the set amount + refunds the rest with no stamp); a
//     rejected proposal leaves the dispute open for a new proposal
//
// The wasms are loaded at RUNTIME from target/ (never
// include_bytes!): this environment intermittently fails rustc
// include_bytes! reads of target/ paths (ENOENT on a file that ls
// and python can read), while normal process reads work every time.
//
// Run with (wasms must exist first: `scripts/build.sh`):
//   export PATH="$HOME/.cargo/bin:$PATH"
//   NEAR_SANDBOX_BIN_PATH=$HOME/.near/near-sandbox-2.14.0/near-sandbox \
//   LD_PRELOAD=$PWD/../hidden_files/fd-shim/setrlimit_shim.so \
//     cargo test --test integration -- --nocapture --test-threads=1
// The LD_PRELOAD shim is needed because this container caps the hard
// RLIMIT_NOFILE at 4096 and the sandbox binary refuses to start below
// 65535; the shim only fakes the limit check. The fd-shim is copied
// from OwnGround (~/workspace/commonhold/hidden_files/fd-shim/).
use base64::Engine as _;
use near_workspaces::network::Sandbox;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use serde_json::json;
use sha2::Digest;

const N: u128 = 1_000_000_000_000_000_000_000_000;
const GAS: Gas = Gas::from_tgas(100);
const VOTE_GAS: Gas = Gas::from_tgas(150);
const MINT_GAS: Gas = Gas::from_tgas(150);
/// The acceptance criteria posted on every test job.
const CRITERIA: &str = "Weld the gate: continuous beads, no porosity, ground flush.";

fn y(n: u128) -> String {
    n.to_string()
}

/// Load a built wasm at runtime. Panics with a clear message if the
/// build step was skipped. The path is built WITHOUT any `..`
/// component: this environment intermittently fails to resolve
/// paths containing `..` (stat returns ENOENT on a file ls can see),
/// so the workspace root is derived by stripping the last path
/// component of CARGO_MANIFEST_DIR instead.
fn load_wasm(rel: &str) -> Vec<u8> {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let workspace = manifest.parent().expect("contract has a workspace parent");
    let path = workspace.join(rel);
    std::fs::read(&path).unwrap_or_else(|e| {
        panic!("wasm not found at {}; io error: {e}; run scripts/build.sh first", path.display())
    })
}

// The test copies live in contract/tests/ (copied there by
// scripts/build.sh): plain `cp` writes that this environment's
// flaky path resolution can read, unlike the cargo-near outputs
// under target/ (std::fs::read gets ENOENT on those from the test
// binary even though ls and python read them fine).
fn merit_wasm() -> Vec<u8> {
    load_wasm("contract/tests/merit.wasm")
}

fn wallet_wasm() -> Vec<u8> {
    load_wasm("contract/tests/merit_wallet.wasm")
}

/// Real Sputnik v2 bytecode (copied from OwnGround's test copy;
/// sha256 6e3f1814d40769d8f57b9a7af689d22aaab96d3232cec4d861311829c1d2318f).
fn sputnik_wasm() -> Vec<u8> {
    load_wasm("contract/tests/sputnik-v2.wasm")
}

/// SHA-256 hex of bytes (evidence hashes for submit_evidence).
fn evidence_hash(bytes: &[u8]) -> String {
    hex::encode(sha2::Sha256::digest(bytes))
}

struct Env {
    worker: Worker<Sandbox>,
    contract: Contract,
    owner: Account,
    alice: Account,
    bob: Account,
    carol: Account,
    /// Stand-in for the Merit DAO: a plain dev account whose id is
    /// passed as dao_id at init. resolve_dispute called by this
    /// account plays the DAO executing a passed proposal; the full
    /// real-DAO flow is covered by the DaoEnv tests below.
    dao: Account,
}

async fn setup() -> anyhow::Result<Env> {
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&merit_wasm()).await?;
    let owner = worker.dev_create_account().await?;
    let alice = worker.dev_create_account().await?;
    let bob = worker.dev_create_account().await?;
    let carol = worker.dev_create_account().await?;
    let dao = worker.dev_create_account().await?;
    owner
        .call(contract.id(), "new")
        .args_json(json!({ "owner_id": owner.id(), "dao_id": dao.id() }))
        .transact()
        .await?
        .into_result()?;
    // Sanity: the contract records the DAO.
    let recorded: String = worker
        .view(contract.id(), "get_dao")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(recorded, dao.id().to_string(), "get_dao must return the init DAO");
    // Publish the wallet once as a global contract.
    owner
        .call(contract.id(), "deploy_wallet_global")
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    Ok(Env {
        worker,
        contract,
        owner,
        alice,
        bob,
        carol,
        dao,
    })
}

fn sub_id(env: &Env, token_id: &str) -> near_workspaces::types::AccountId {
    format!("{}.{}", token_id, env.contract.id())
        .parse()
        .unwrap()
}

async fn sub_balance(env: &Env, token_id: &str) -> anyhow::Result<u128> {
    let details = env.worker.view_account(&sub_id(env, token_id)).await?;
    Ok(details.balance.as_yoctonear())
}

async fn mint(env: &Env, who: &Account, token_id: &str) -> anyhow::Result<()> {
    who.call(env.contract.id(), "nft_mint")
        .args_json(json!({
            "token_id": token_id,
            "receiver_id": who.id(),
            "metadata": { "title": format!("Merit {}", token_id) },
        }))
        .deposit(NearToken::from_yoctonear(N / 10))
        .gas(MINT_GAS)
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn get_merit(env: &Env, token_id: &str) -> anyhow::Result<serde_json::Value> {
    Ok(env
        .worker
        .view(env.contract.id(), "get_merit")
        .args_json(json!({ "token_id": token_id }))
        .await?
        .json()?)
}

async fn get_job(env: &Env, job_id: &str) -> anyhow::Result<serde_json::Value> {
    Ok(env
        .worker
        .view(env.contract.id(), "get_job")
        .args_json(json!({ "job_id": job_id }))
        .await?
        .json()?)
}

async fn stamp(env: &Env, who: &Account, token_id: &str, skill: &str, level: u8) -> anyhow::Result<()> {
    who.call(env.contract.id(), "stamp")
        .args_json(json!({ "token_id": token_id, "skill": skill, "level": level }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn create_job(
    env: &Env,
    poster: &Account,
    job_id: &str,
    payment: u128,
    skill: &str,
    min_level: u8,
    timeout_ns: Option<u64>,
    completion: (&str, u8),
) -> anyhow::Result<()> {
    poster
        .call(env.contract.id(), "create_job")
        .args_json(json!({
            "job_id": job_id,
            "title": format!("Job {}", job_id),
            "description": "Test job",
            "required_stamps": [{ "skill": skill, "min_level": min_level }],
            "completion_stamp": { "skill": completion.0, "level": completion.1 },
            "criteria": CRITERIA,
            "timeout_ns": timeout_ns.map(|t| t.to_string()),
        }))
        .deposit(NearToken::from_yoctonear(payment))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

/// Advance sandbox time well past a few-second deadline:
/// fast-forward 70 blocks (moves block timestamps forward) plus a
/// 2s wall-clock sleep (covers the sandbox tracking wall time).
async fn advance_time(worker: &Worker<Sandbox>) {
    worker.fast_forward(70).await.expect("fast_forward");
    std::thread::sleep(std::time::Duration::from_secs(2));
}

fn failures_contain(outcome: &near_workspaces::result::ExecutionFinalResult, needle: &str) -> bool {
    format!("{:?}", outcome.failures()).contains(needle)
}

#[tokio::test]
async fn mint_creates_real_subaccount_with_wallet() -> anyhow::Result<()> {
    let env = setup().await?;
    let cid = env.contract.id();
    // The published wallet code hash matches the wallet wasm.
    let wallet_bytes = wallet_wasm();
    let expected_hash = hex::encode(sha2::Sha256::digest(&wallet_bytes));
    let info: serde_json::Value = env
        .worker
        .view(cid, "get_wallet_info")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(info["deployed"], true);
    assert_eq!(info["code_hash"], expected_hash);
    assert_eq!(info["embedded"], false);

    mint(&env, &env.alice, "merit-1").await?;
    let token: serde_json::Value = env
        .worker
        .view(cid, "nft_token")
        .args_json(json!({ "token_id": "merit-1" }))
        .await?
        .json()?;
    assert_eq!(token["owner_id"], env.alice.id().to_string());
    let merit = get_merit(&env, "merit-1").await?;
    assert_eq!(merit["level"], 0);
    assert_eq!(merit["locked"], false);

    // The sub-account exists with exactly the 0.05 NEAR init.
    assert_eq!(sub_balance(&env, "merit-1").await?, N / 20);
    // The sub-account runs the wallet contract: get_parent returns
    // the Merit contract, and its code hash is the wallet hash.
    let parent: String = env
        .worker
        .view(&sub_id(&env, "merit-1"), "get_parent")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(parent, cid.to_string());
    let code = env.worker.view_code(&sub_id(&env, "merit-1")).await?;
    assert_eq!(hex::encode(sha2::Sha256::digest(&code)), expected_hash);

    let tokens: serde_json::Value = env
        .worker
        .view(cid, "nft_tokens")
        .args_json(json!({ "from_index": "0", "limit": 10 }))
        .await?
        .json()?;
    assert_eq!(tokens.as_array().unwrap().len(), 1);

    // Invalid token id (uppercase + underscore) is rejected.
    let bad = env
        .alice
        .call(cid, "nft_mint")
        .args_json(json!({ "token_id": "Bad_ID", "receiver_id": env.alice.id() }))
        .deposit(NearToken::from_yoctonear(N / 10))
        .gas(MINT_GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "invalid token id must fail");
    assert!(failures_contain(&bad, "lowercase letters"));

    // Duplicate mint is rejected.
    let dup = env
        .alice
        .call(cid, "nft_mint")
        .args_json(json!({ "token_id": "merit-1", "receiver_id": env.alice.id() }))
        .deposit(NearToken::from_yoctonear(N / 10))
        .gas(MINT_GAS)
        .transact()
        .await?;
    assert!(dup.is_failure(), "duplicate mint must fail");
    assert!(failures_contain(&dup, "token already exists"));
    Ok(())
}

#[tokio::test]
async fn wallet_only_obeys_parent() -> anyhow::Result<()> {
    let env = setup().await?;
    mint(&env, &env.alice, "merit-1").await?;
    // Carol calls the sub-account wallet payout directly: the wallet
    // only obeys the parent Merit contract.
    let bad = env
        .carol
        .call(&sub_id(&env, "merit-1"), "payout")
        .args_json(json!({ "receiver": env.carol.id(), "amount": y(N / 100) }))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "direct wallet payout must fail");
    assert!(failures_contain(&bad, "only the parent Merit contract"));
    assert_eq!(sub_balance(&env, "merit-1").await?, N / 20, "no money moved");
    Ok(())
}

#[tokio::test]
async fn stamp_locks_and_whitelist_rules() -> anyhow::Result<()> {
    let env = setup().await?;
    let cid = env.contract.id();
    mint(&env, &env.alice, "merit-1").await?;
    // Seeded whitelist: owner as "Merit DAO".
    let issuers: serde_json::Value = env
        .worker
        .view(cid, "list_issuers")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(issuers.as_array().unwrap().len(), 1);
    assert_eq!(issuers[0]["account_id"], env.owner.id().to_string());
    assert_eq!(issuers[0]["name"], "Merit DAO");

    // Bob is not whitelisted: stamp rejected.
    let bad = env
        .bob
        .call(cid, "stamp")
        .args_json(json!({ "token_id": "merit-1", "skill": "welding", "level": 2 }))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "non-whitelisted stamp must fail");
    assert!(failures_contain(&bad, "not a whitelisted issuer"));

    // Owner (whitelisted) stamps; the stamp carries "Merit DAO".
    stamp(&env, &env.owner, "merit-1", "welding", 2).await?;
    let merit = get_merit(&env, "merit-1").await?;
    assert_eq!(merit["level"], 2);
    assert_eq!(merit["locked"], true);
    assert_eq!(merit["stamps"][0]["skill"], "welding");
    assert_eq!(merit["stamps"][0]["issuer"], env.owner.id().to_string());
    assert_eq!(merit["stamps"][0]["issuer_name"], "Merit DAO");

    // Locked transfer panics.
    let bad = env
        .alice
        .call(cid, "nft_transfer")
        .args_json(json!({ "receiver_id": env.bob.id(), "token_id": "merit-1" }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "locked transfer must fail");
    assert!(failures_contain(&bad, "locked Merit cannot be transferred"));

    // Level out of range is rejected.
    let bad = env
        .owner
        .call(cid, "stamp")
        .args_json(json!({ "token_id": "merit-1", "skill": "welding", "level": 4 }))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "level 4 stamp must fail");
    assert!(failures_contain(&bad, "level must be 1-3"));

    // The DAO adds Carol as "Carol Crafts"; she can stamp with her name.
    env.dao
        .call(cid, "add_issuer")
        .args_json(json!({ "account_id": env.carol.id(), "name": "Carol Crafts" }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    stamp(&env, &env.carol, "merit-1", "plumbing", 1).await?;
    let merit = get_merit(&env, "merit-1").await?;
    assert_eq!(merit["stamps"][1]["issuer_name"], "Carol Crafts");
    assert_eq!(merit["level"], 3);

    // Non-DAO cannot add an issuer.
    let bad = env
        .alice
        .call(cid, "add_issuer")
        .args_json(json!({ "account_id": env.bob.id(), "name": "Bob" }))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "non-DAO add_issuer must fail");

    // The DAO removes Carol; she can no longer stamp.
    env.dao
        .call(cid, "remove_issuer")
        .args_json(json!({ "account_id": env.carol.id() }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let bad = env
        .carol
        .call(cid, "stamp")
        .args_json(json!({ "token_id": "merit-1", "skill": "plumbing", "level": 2 }))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "removed issuer cannot stamp");
    Ok(())
}

#[tokio::test]
async fn pass_test_stamps_basics() -> anyhow::Result<()> {
    let env = setup().await?;
    let cid = env.contract.id();
    mint(&env, &env.alice, "merit-1").await?;
    let bad = env
        .alice
        .call(cid, "pass_test")
        .args_json(json!({ "token_id": "merit-1", "answer": "wrong" }))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "wrong answer must fail");
    assert!(failures_contain(&bad, "wrong answer"));
    env.alice
        .call(cid, "pass_test")
        .args_json(json!({ "token_id": "merit-1", "answer": "merit" }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let merit = get_merit(&env, "merit-1").await?;
    assert_eq!(merit["level"], 1);
    assert_eq!(merit["locked"], true);
    assert_eq!(merit["stamps"][0]["skill"], "merit-basics");
    // System stamp: issuer is the contract, name is "Merit Test".
    assert_eq!(merit["stamps"][0]["issuer"], cid.to_string());
    assert_eq!(merit["stamps"][0]["issuer_name"], "Merit Test");
    // Second pass is rejected.
    let bad = env
        .alice
        .call(cid, "pass_test")
        .args_json(json!({ "token_id": "merit-1", "answer": "merit" }))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "second pass must fail");
    assert!(failures_contain(&bad, "test already passed"));
    Ok(())
}

#[tokio::test]
async fn job_flow_poster_confirms_and_money_lands_in_subaccount() -> anyhow::Result<()> {
    let env = setup().await?;
    let cid = env.contract.id();
    mint(&env, &env.alice, "merit-1").await?;
    stamp(&env, &env.owner, "merit-1", "welding", 2).await?;
    // Bob posts a 2 NEAR job requiring welding level 2.
    create_job(&env, &env.bob, "weld-1", 2 * N, "welding", 2, None, ("gate-welding", 1)).await?;
    let job = get_job(&env, "weld-1").await?;
    assert_eq!(job["payment"], y(2 * N));
    assert_eq!(job["status"], "Open");
    assert_eq!(job["criteria"], CRITERIA, "criteria is stored on the job");
    assert_eq!(job["arbiter"], env.dao.id().to_string(), "arbiter defaults to the DAO");
    assert_eq!(job["timeout_ns"], (7 * 24 * 60 * 60 * 1_000_000_000u64).to_string());
    // Carol (not holder, no lend) cannot access; Alice can.
    let can: bool = env
        .worker
        .view(cid, "can_access")
        .args_json(json!({ "token_id": "merit-1", "job_id": "weld-1", "account_id": env.carol.id() }))
        .await?
        .json()?;
    assert!(!can, "non-holder cannot access");
    let can: bool = env
        .worker
        .view(cid, "can_access")
        .args_json(json!({ "token_id": "merit-1", "job_id": "weld-1", "account_id": env.alice.id() }))
        .await?
        .json()?;
    assert!(can, "holder with the stamp can access");
    // Worker accepts; worker CANNOT confirm (poster-only now).
    env.alice
        .call(cid, "accept_job")
        .args_json(json!({ "job_id": "weld-1", "token_id": "merit-1" }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let job = get_job(&env, "weld-1").await?;
    assert_eq!(job["status"], "Accepted");
    // U64 serializes as a JSON string, not a number.
    assert!(job["accepted_at"].as_str().is_some());
    assert!(job["deadline"].as_str().is_some());
    let bad = env
        .alice
        .call(cid, "complete_job")
        .args_json(json!({ "job_id": "weld-1", "token_id": "merit-1" }))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "worker cannot confirm completion");
    assert!(failures_contain(&bad, "only the poster may confirm"));
    // Poster confirms: the 2 NEAR lands IN THE SUB-ACCOUNT.
    assert_eq!(sub_balance(&env, "merit-1").await?, N / 20);
    env.bob
        .call(cid, "complete_job")
        .args_json(json!({ "job_id": "weld-1", "token_id": "merit-1" }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    assert_eq!(
        sub_balance(&env, "merit-1").await?,
        N / 20 + 2 * N,
        "job payment lands in the sub-account"
    );
    let merit = get_merit(&env, "merit-1").await?;
    assert_eq!(merit["balance_withdrawable"], y(19 * N / 10), "95% withdrawable");
    assert_eq!(merit["balance_retained"], y(N / 10), "5% retained");
    // The completion stamp is issued on poster confirm.
    let stamps = merit["stamps"].as_array().expect("merit has stamps");
    let completion = stamps
        .iter()
        .find(|s| s["skill"] == "gate-welding")
        .expect("completion stamp issued");
    assert_eq!(completion["level"], 1);
    assert_eq!(completion["issuer_name"], "Job completion");
    assert_eq!(completion["issuer"], env.contract.id().to_string());
    let job = get_job(&env, "weld-1").await?;
    assert_eq!(job["status"], "Completed");
    // Withdraw pays the holder exactly 1.9 NEAR FROM the sub-account.
    let before = env.alice.view_account().await?.balance.as_yoctonear();
    env.alice
        .call(cid, "withdraw")
        .args_json(json!({ "token_id": "merit-1", "amount": y(19 * N / 10) }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let after = env.alice.view_account().await?.balance.as_yoctonear();
    assert!(
        after > before + 180 * N / 100,
        "holder must receive ~1.9 NEAR (less the withdraw call's own gas): before {} after {}",
        before,
        after
    );
    assert_eq!(
        sub_balance(&env, "merit-1").await?,
        N / 20 + N / 10,
        "sub-account keeps the 0.05 init + 0.1 retained"
    );
    let merit = get_merit(&env, "merit-1").await?;
    assert_eq!(merit["balance_withdrawable"], y(0));
    assert_eq!(merit["balance_retained"], y(N / 10), "retained stays");
    // Over-withdraw now fails.
    let bad = env
        .alice
        .call(cid, "withdraw")
        .args_json(json!({ "token_id": "merit-1", "amount": y(1) }))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "over-withdraw must fail");
    assert!(failures_contain(&bad, "withdraw exceeds withdrawable balance"));
    Ok(())
}

#[tokio::test]
async fn gate_denied_without_stamp() -> anyhow::Result<()> {
    let env = setup().await?;
    let cid = env.contract.id();
    mint(&env, &env.alice, "merit-1").await?;
    create_job(&env, &env.bob, "weld-1", N, "welding", 1, None, ("gate-welding", 1)).await?;
    let can: bool = env
        .worker
        .view(cid, "can_access")
        .args_json(json!({ "token_id": "merit-1", "job_id": "weld-1", "account_id": env.alice.id() }))
        .await?
        .json()?;
    assert!(!can, "unstamped Merit cannot access a gated job");
    let bad = env
        .alice
        .call(cid, "accept_job")
        .args_json(json!({ "job_id": "weld-1", "token_id": "merit-1" }))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "accept without the stamp must fail");
    assert!(failures_contain(&bad, "does not satisfy"));
    Ok(())
}

#[tokio::test]
async fn lend_rules() -> anyhow::Result<()> {
    let env = setup().await?;
    let cid = env.contract.id();
    mint(&env, &env.alice, "merit-1").await?;
    stamp(&env, &env.owner, "merit-1", "welding", 1).await?;
    create_job(&env, &env.bob, "weld-1", N, "welding", 1, None, ("gate-welding", 1)).await?;
    // Lend to Bob for 1 hour from the stamp time.
    let merit = get_merit(&env, "merit-1").await?;
    let now_ns: u64 = merit["stamps"][0]["stamped_at"]
        .as_str()
        .expect("stamped_at is a U64 string")
        .parse()
        .expect("stamped_at parses as u64");
    let expiry = now_ns + 3_600_000_000_000;
    env.alice
        .call(cid, "lend")
        .args_json(json!({
            "token_id": "merit-1",
            "to": env.bob.id(),
            "expires_at": expiry.to_string(),
        }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let can: bool = env
        .worker
        .view(cid, "can_access")
        .args_json(json!({ "token_id": "merit-1", "job_id": "weld-1", "account_id": env.bob.id() }))
        .await?
        .json()?;
    assert!(can, "live delegate can access");
    // Delegate accepts; the POSTER (bob is both poster and delegate
    // here) confirms — the delegate path is the accept.
    env.bob
        .call(cid, "accept_job")
        .args_json(json!({ "job_id": "weld-1", "token_id": "merit-1" }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let job = get_job(&env, "weld-1").await?;
    assert_eq!(job["status"], "Accepted");
    // Delegate cannot withdraw (holder-only).
    let bad = env
        .bob
        .call(cid, "withdraw")
        .args_json(json!({ "token_id": "merit-1", "amount": y(N / 10) }))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "delegate withdraw must fail");
    assert!(failures_contain(&bad, "not the Merit holder"));
    // Lend with a past expiry is rejected at lend time.
    let bad = env
        .alice
        .call(cid, "lend")
        .args_json(json!({
            "token_id": "merit-1",
            "to": env.carol.id(),
            "expires_at": "1",
        }))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "past-expiry lend must fail");
    assert!(failures_contain(&bad, "expiry must be in the future"));
    // Revoke ends the delegate's access.
    env.alice
        .call(cid, "revoke_lend")
        .args_json(json!({ "token_id": "merit-1" }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let can: bool = env
        .worker
        .view(cid, "can_access")
        .args_json(json!({ "token_id": "merit-1", "job_id": "weld-1", "account_id": env.bob.id() }))
        .await?
        .json()?;
    assert!(!can, "revoked delegate cannot access");
    let merit = get_merit(&env, "merit-1").await?;
    assert_eq!(merit["lend"], serde_json::Value::Null);
    Ok(())
}

#[tokio::test]
async fn lend_expiry_enforced_onchain() -> anyhow::Result<()> {
    let env = setup().await?;
    let cid = env.contract.id();
    mint(&env, &env.alice, "merit-1").await?;
    stamp(&env, &env.owner, "merit-1", "welding", 1).await?;
    create_job(&env, &env.bob, "weld-1", N, "welding", 1, None, ("gate-welding", 1)).await?;
    // Lend for ~5 seconds from a FRESH onchain timestamp (re-stamp
    // to refresh stamped_at), then fast-forward past it.
    stamp(&env, &env.owner, "merit-1", "welding", 1).await?;
    let merit = get_merit(&env, "merit-1").await?;
    let now_ns: u64 = merit["stamps"][0]["stamped_at"]
        .as_str()
        .expect("stamped_at is a U64 string")
        .parse()
        .expect("stamped_at parses as u64");
    env.alice
        .call(cid, "lend")
        .args_json(json!({
            "token_id": "merit-1",
            "to": env.bob.id(),
            "expires_at": (now_ns + 5_000_000_000).to_string(),
        }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let can: bool = env
        .worker
        .view(cid, "can_access")
        .args_json(json!({ "token_id": "merit-1", "job_id": "weld-1", "account_id": env.bob.id() }))
        .await?
        .json()?;
    assert!(can, "delegate can access before expiry");
    advance_time(&env.worker).await;
    let can: bool = env
        .worker
        .view(cid, "can_access")
        .args_json(json!({ "token_id": "merit-1", "job_id": "weld-1", "account_id": env.bob.id() }))
        .await?
        .json()?;
    assert!(!can, "delegate cannot access after expiry");
    Ok(())
}

#[tokio::test]
async fn kit_flow() -> anyhow::Result<()> {
    let env = setup().await?;
    let cid = env.contract.id();
    mint(&env, &env.alice, "merit-1").await?;
    env.owner
        .call(cid, "mint_kit")
        .args_json(json!({
            "kit_token_id": "torch-1",
            "name": "Welding Torch",
            "receiver_id": env.alice.id(),
        }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    // Bob cannot deposit a kit he does not own.
    let bad = env
        .bob
        .call(cid, "deposit_kit")
        .args_json(json!({ "token_id": "merit-1", "kit_token_id": "torch-1" }))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "non-owner kit deposit must fail");
    env.alice
        .call(cid, "deposit_kit")
        .args_json(json!({ "token_id": "merit-1", "kit_token_id": "torch-1" }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let merit = get_merit(&env, "merit-1").await?;
    assert_eq!(merit["kit"], json!(["torch-1"]));
    let kit: serde_json::Value = env
        .worker
        .view(cid, "get_kit")
        .args_json(json!({ "kit_token_id": "torch-1" }))
        .await?
        .json()?;
    assert_eq!(kit["inside_merit"], "merit-1");
    assert_eq!(kit["name"], "Welding Torch");
    env.alice
        .call(cid, "withdraw_kit")
        .args_json(json!({ "token_id": "merit-1", "kit_token_id": "torch-1" }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let merit = get_merit(&env, "merit-1").await?;
    assert_eq!(merit["kit"], json!([]));
    let kit: serde_json::Value = env
        .worker
        .view(cid, "get_kit")
        .args_json(json!({ "kit_token_id": "torch-1" }))
        .await?
        .json()?;
    assert_eq!(kit["inside_merit"], serde_json::Value::Null);
    Ok(())
}

#[tokio::test]
async fn issuer_admin() -> anyhow::Result<()> {
    let env = setup().await?;
    let cid = env.contract.id();
    mint(&env, &env.alice, "merit-1").await?;
    // Non-DAO cannot add an issuer.
    let bad = env
        .alice
        .call(cid, "add_issuer")
        .args_json(json!({ "account_id": env.carol.id(), "name": "Carol Crafts" }))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "non-DAO add_issuer must fail");
    env.dao
        .call(cid, "add_issuer")
        .args_json(json!({ "account_id": env.carol.id(), "name": "Carol Crafts" }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    stamp(&env, &env.carol, "merit-1", "welding", 3).await?;
    let merit = get_merit(&env, "merit-1").await?;
    assert_eq!(merit["stamps"][0]["issuer"], env.carol.id().to_string());
    assert_eq!(merit["stamps"][0]["issuer_name"], "Carol Crafts");
    env.dao
        .call(cid, "remove_issuer")
        .args_json(json!({ "account_id": env.carol.id() }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let bad = env
        .carol
        .call(cid, "stamp")
        .args_json(json!({ "token_id": "merit-1", "skill": "plumbing", "level": 1 }))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "removed issuer cannot stamp");
    // list_issuers no longer shows Carol.
    let issuers: serde_json::Value = env
        .worker
        .view(cid, "list_issuers")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(issuers.as_array().unwrap().len(), 1);
    assert_eq!(issuers[0]["name"], "Merit DAO");
    Ok(())
}

#[tokio::test]
async fn unlocked_transfer_works_and_clears_lend() -> anyhow::Result<()> {
    let env = setup().await?;
    let cid = env.contract.id();
    mint(&env, &env.alice, "merit-1").await?;
    // Lend the blank Merit to Carol, then transfer it to Bob.
    env.alice
        .call(cid, "lend")
        .args_json(json!({
            "token_id": "merit-1",
            "to": env.carol.id(),
            "expires_at": "9999999999999999999",
        }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    // Delegate cannot transfer (only the holder can).
    let bad = env
        .carol
        .call(cid, "nft_transfer")
        .args_json(json!({
            "receiver_id": env.carol.id(),
            "token_id": "merit-1",
        }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "delegate transfer must fail");
    env.alice
        .call(cid, "nft_transfer")
        .args_json(json!({
            "receiver_id": env.bob.id(),
            "token_id": "merit-1",
        }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let merit = get_merit(&env, "merit-1").await?;
    assert_eq!(merit["owner_id"], env.bob.id().to_string());
    assert_eq!(merit["lend"], serde_json::Value::Null, "transfer clears lend");
    assert_eq!(merit["locked"], false);
    Ok(())
}

#[tokio::test]
async fn timeout_release_pays_worker_after_deadline() -> anyhow::Result<()> {
    let env = setup().await?;
    let cid = env.contract.id();
    mint(&env, &env.alice, "merit-1").await?;
    stamp(&env, &env.owner, "merit-1", "welding", 1).await?;
    // 5-second timeout so the test can pass the deadline.
    create_job(&env, &env.bob, "weld-1", N, "welding", 1, Some(5_000_000_000), ("welding", 1)).await?;
    env.alice
        .call(cid, "accept_job")
        .args_json(json!({ "job_id": "weld-1", "token_id": "merit-1" }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    // Release BEFORE the deadline fails.
    let bad = env
        .carol
        .call(cid, "release_job")
        .args_json(json!({ "job_id": "weld-1" }))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "early release must fail");
    assert!(failures_contain(&bad, "deadline has not passed"));
    // Advance well past the deadline; ANYONE (carol) may release.
    advance_time(&env.worker).await;
    env.carol
        .call(cid, "release_job")
        .args_json(json!({ "job_id": "weld-1" }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let job = get_job(&env, "weld-1").await?;
    assert_eq!(job["status"], "Completed");
    let merit = get_merit(&env, "merit-1").await?;
    assert_eq!(merit["balance_withdrawable"], y(95 * N / 100));
    assert_eq!(merit["balance_retained"], y(5 * N / 100));
    // Silence past the deadline auto-releases AND issues the stamp:
    // the Merit already held welding 1, so the completion re-issues
    // it as a "Job completion" system stamp.
    let stamps = merit["stamps"].as_array().expect("merit has stamps");
    let welding = stamps
        .iter()
        .find(|s| s["skill"] == "welding")
        .expect("welding stamp present");
    assert_eq!(welding["level"], 1);
    assert_eq!(welding["issuer_name"], "Job completion");
    assert_eq!(
        sub_balance(&env, "merit-1").await?,
        N / 20 + N,
        "released payment lands in the sub-account"
    );
    // Second release fails (job no longer accepted).
    let bad = env
        .carol
        .call(cid, "release_job")
        .args_json(json!({ "job_id": "weld-1" }))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "double release must fail");
    Ok(())
}

#[tokio::test]
async fn dispute_blocks_release_and_completion() -> anyhow::Result<()> {
    let env = setup().await?;
    let cid = env.contract.id();
    mint(&env, &env.alice, "merit-1").await?;
    stamp(&env, &env.owner, "merit-1", "welding", 1).await?;
    create_job(&env, &env.bob, "weld-1", N, "welding", 1, Some(5_000_000_000), ("welding", 1)).await?;
    env.alice
        .call(cid, "accept_job")
        .args_json(json!({ "job_id": "weld-1", "token_id": "merit-1" }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    // A bystander (carol, not a party) cannot raise.
    let bad = env
        .carol
        .call(cid, "raise_dispute")
        .args_json(json!({ "job_id": "weld-1" }))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "bystander dispute must fail");
    // Poster raises; the job is Disputed.
    env.bob
        .call(cid, "raise_dispute")
        .args_json(json!({ "job_id": "weld-1" }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let job = get_job(&env, "weld-1").await?;
    assert_eq!(job["status"], "Disputed");
    assert_eq!(job["arbiter"], env.dao.id().to_string());
    // Both sides submit evidence hashes (content stays offchain).
    let poster_ev = evidence_hash(b"poster photos: gate welded, beads continuous");
    let worker_ev = evidence_hash(b"worker photos: finished gate");
    env.bob
        .call(cid, "submit_evidence")
        .args_json(json!({ "job_id": "weld-1", "evidence_hash": poster_ev, "evidence_ref": null }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    env.alice
        .call(cid, "submit_evidence")
        .args_json(json!({ "job_id": "weld-1", "evidence_hash": worker_ev, "evidence_ref": null }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let job = get_job(&env, "weld-1").await?;
    assert_eq!(job["poster_evidence"], poster_ev);
    assert_eq!(job["worker_evidence"], worker_ev);
    // A malformed evidence hash is rejected.
    let bad = env
        .bob
        .call(cid, "submit_evidence")
        .args_json(json!({ "job_id": "weld-1", "evidence_hash": "xyz", "evidence_ref": null }))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "bad evidence hash must fail");
    // Completion and release are blocked while disputed.
    let bad = env
        .bob
        .call(cid, "complete_job")
        .args_json(json!({ "job_id": "weld-1", "token_id": "merit-1" }))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "completion blocked while disputed");
    assert!(failures_contain(&bad, "job is not accepted"));
    advance_time(&env.worker).await;
    let bad = env
        .carol
        .call(cid, "release_job")
        .args_json(json!({ "job_id": "weld-1" }))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "release blocked while disputed");
    assert!(failures_contain(&bad, "job is not accepted"));
    // The poster is NOT the DAO: resolve from anyone except the
    // recorded arbiter DAO is rejected.
    let bad = env
        .bob
        .call(cid, "resolve_dispute")
        .args_json(json!({ "job_id": "weld-1", "outcome": "pay_full" }))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "non-DAO resolve must fail");
    assert!(failures_contain(&bad, "not the job's arbiter DAO"));
    // The DAO (stand-in account) pays the worker in full + stamp.
    env.dao
        .call(cid, "resolve_dispute")
        .args_json(json!({ "job_id": "weld-1", "outcome": "pay_full" }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let job = get_job(&env, "weld-1").await?;
    assert_eq!(job["status"], "Completed");
    let merit = get_merit(&env, "merit-1").await?;
    assert_eq!(merit["balance_withdrawable"], y(95 * N / 100));
    assert_eq!(merit["balance_retained"], y(5 * N / 100));
    let stamps = merit["stamps"].as_array().expect("merit has stamps");
    let welding = stamps.iter().find(|s| s["skill"] == "welding").expect("welding stamp");
    assert_eq!(welding["issuer_name"], "Job completion", "pay_full issues the completion stamp");
    // Second resolution is rejected (job no longer disputed).
    let bad = env
        .dao
        .call(cid, "resolve_dispute")
        .args_json(json!({ "job_id": "weld-1", "outcome": "refund" }))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "double resolution must fail");
    Ok(())
}

// ---- Real Sputnik DAO proposal-and-vote tests ----

struct DaoEnv {
    worker: Worker<Sandbox>,
    contract: Contract,
    dao: Contract,
    owner: Account,
    alice: Account,
    bob: Account,
    carol: Account,
}

/// Deploy a REAL Sputnik v2 DAO from the on-chain WASM, with the
/// given council and absolute Weight threshold. Mirrors the
/// OwnGround v4_security.rs pattern (direct deploy, no factory).
async fn deploy_dao(
    worker: &Worker<Sandbox>,
    council: &[&Account],
    threshold: &str,
) -> anyhow::Result<Contract> {
    let dao = worker.dev_deploy(&sputnik_wasm()).await?;
    let council_ids: Vec<String> = council.iter().map(|a| a.id().to_string()).collect();
    dao.as_account()
        .call(dao.id(), "new")
        .args_json(json!({
            "config": { "name": "merit-dao", "purpose": "Merit DAO — judges disputes", "metadata": "" },
            "policy": {
                "roles": [
                    { "name": "all", "kind": "Everyone", "permissions": ["*:AddProposal"], "vote_policy": {} },
                    { "name": "council", "kind": { "Group": council_ids }, "permissions": ["*:*"], "vote_policy": {} },
                ],
                "default_vote_policy": { "weight_kind": "RoleWeight", "quorum": "0", "threshold": threshold },
                "proposal_bond": "1000000000000000000000000",
                "proposal_period": "604800000000000",
                "bounty_bond": "1000000000000000000000000",
                "bounty_forgiveness_period": "86400000000000",
            },
        }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let policy: serde_json::Value = worker
        .view(dao.id(), "get_policy")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(
        policy["default_vote_policy"]["threshold"].as_str().unwrap(),
        threshold,
        "DAO threshold is not the requested value"
    );
    Ok(dao)
}

async fn setup_dao() -> anyhow::Result<DaoEnv> {
    let worker = near_workspaces::sandbox().await?;
    let owner = worker.dev_create_account().await?;
    let alice = worker.dev_create_account().await?;
    let bob = worker.dev_create_account().await?;
    let carol = worker.dev_create_account().await?;
    // Council = owner, alice, bob; threshold 2 (strict majority).
    let dao = deploy_dao(&worker, &[&owner, &alice, &bob], "2").await?;
    let contract = worker.dev_deploy(&merit_wasm()).await?;
    owner
        .call(contract.id(), "new")
        .args_json(json!({ "owner_id": owner.id(), "dao_id": dao.id() }))
        .transact()
        .await?
        .into_result()?;
    owner
        .call(contract.id(), "deploy_wallet_global")
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    Ok(DaoEnv {
        worker,
        contract,
        dao,
        owner,
        alice,
        bob,
        carol,
    })
}

/// Mint + stamp + post + accept + dispute + evidence, ready for a
/// DAO proposal. Poster is `poster`, worker is alice (merit-1),
/// payment 1 NEAR, completion stamp gate-welding 1.
async fn disputed_job(env: &DaoEnv, job_id: &str, poster: &Account) -> anyhow::Result<()> {
    let cid = env.contract.id();
    env.alice
        .call(cid, "nft_mint")
        .args_json(json!({
            "token_id": "merit-1",
            "receiver_id": env.alice.id(),
            "metadata": { "title": "Merit merit-1" },
        }))
        .deposit(NearToken::from_yoctonear(N / 10))
        .gas(MINT_GAS)
        .transact()
        .await?
        .into_result()?;
    env.owner
        .call(cid, "stamp")
        .args_json(json!({ "token_id": "merit-1", "skill": "welding", "level": 1 }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    poster
        .call(cid, "create_job")
        .args_json(json!({
            "job_id": job_id,
            "title": format!("Job {}", job_id),
            "description": "Test job",
            "required_stamps": [{ "skill": "welding", "min_level": 1 }],
            "completion_stamp": { "skill": "gate-welding", "level": 1 },
            "criteria": CRITERIA,
            "timeout_ns": null,
        }))
        .deposit(NearToken::from_yoctonear(N))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    env.alice
        .call(cid, "accept_job")
        .args_json(json!({ "job_id": job_id, "token_id": "merit-1" }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    poster
        .call(cid, "raise_dispute")
        .args_json(json!({ "job_id": job_id }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    poster
        .call(cid, "submit_evidence")
        .args_json(json!({ "job_id": job_id, "evidence_hash": evidence_hash(b"poster evidence: photos of the gate"), "evidence_ref": null }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    env.alice
        .call(cid, "submit_evidence")
        .args_json(json!({ "job_id": job_id, "evidence_hash": evidence_hash(b"worker evidence: finished gate photos"), "evidence_ref": null }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

/// Create the DAO proposal that resolves a dispute: a FunctionCall
/// proposal calling the Merit contract's resolve_dispute with the
/// given outcome. The description carries the job id, the outcome,
/// the criteria, and both sides' evidence hashes — the council
/// judges by reading the evidence against the criteria. Returns
/// the new proposal's id.
async fn propose_resolve(
    env: &DaoEnv,
    proposer: &Account,
    job_id: &str,
    outcome: &str,
    partial_amount: Option<u128>,
) -> anyhow::Result<u64> {
    let dao_id = env.dao.id();
    let next_id: u64 = env
        .worker
        .view(dao_id, "get_last_proposal_id")
        .args_json(json!({}))
        .await?
        .json()?;
    let mut call_args = json!({ "job_id": job_id, "outcome": outcome });
    if let Some(a) = partial_amount {
        call_args["partial_amount"] = json!(a.to_string());
    }
    let job: serde_json::Value = env
        .worker
        .view(env.contract.id(), "get_job")
        .args_json(json!({ "job_id": job_id }))
        .await?
        .json()?;
    let description = format!(
        "Merit dispute {}: {} — criteria: {} | poster evidence {} | worker evidence {}",
        job_id,
        outcome,
        job["criteria"].as_str().unwrap_or(""),
        job["poster_evidence"].as_str().unwrap_or("none"),
        job["worker_evidence"].as_str().unwrap_or("none"),
    );
    let args_b64 =
        base64::engine::general_purpose::STANDARD.encode(serde_json::to_string(&call_args)?);
    proposer
        .call(dao_id, "add_proposal")
        .args_json(json!({
            "proposal": {
                "description": description,
                "kind": { "FunctionCall": {
                    "receiver_id": env.contract.id().to_string(),
                    "actions": [{
                        "method_name": "resolve_dispute",
                        "args": args_b64,
                        "deposit": "0",
                        "gas": "100000000000000",
                    }],
                }},
            },
        }))
        .deposit(NearToken::from_yoctonear(N))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let proposal = get_proposal(env, next_id).await?;
    assert_eq!(proposal["status"], "InProgress", "new dispute proposal must be InProgress");
    Ok(next_id)
}

async fn vote(env: &DaoEnv, voter: &Account, id: u64, approve: bool) -> anyhow::Result<()> {
    let action = if approve { "VoteApprove" } else { "VoteReject" };
    voter
        .call(env.dao.id(), "act_proposal")
        .args_json(json!({ "id": id, "action": action }))
        .gas(VOTE_GAS)
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn get_proposal(env: &DaoEnv, id: u64) -> anyhow::Result<serde_json::Value> {
    Ok(env
        .worker
        .view(env.dao.id(), "get_proposal")
        .args_json(json!({ "id": id }))
        .await?
        .json()?)
}

async fn dao_get_merit(env: &DaoEnv, token_id: &str) -> anyhow::Result<serde_json::Value> {
    Ok(env
        .worker
        .view(env.contract.id(), "get_merit")
        .args_json(json!({ "token_id": token_id }))
        .await?
        .json()?)
}

async fn dao_get_job(env: &DaoEnv, job_id: &str) -> anyhow::Result<serde_json::Value> {
    Ok(env
        .worker
        .view(env.contract.id(), "get_job")
        .args_json(json!({ "job_id": job_id }))
        .await?
        .json()?)
}

#[tokio::test]
async fn dao_proposal_pay_full_executes() -> anyhow::Result<()> {
    let env = setup_dao().await?;
    disputed_job(&env, "weld-1", &env.carol).await?;
    // Anyone (here the poster, not a council member) may propose.
    let pid = propose_resolve(&env, &env.carol, "weld-1", "pay_full", None).await?;
    // One approve is not enough (threshold 2 of 3).
    vote(&env, &env.owner, pid, true).await?;
    let p = get_proposal(&env, pid).await?;
    assert_eq!(p["status"], "InProgress", "one vote must not pass");
    let job = dao_get_job(&env, "weld-1").await?;
    assert_eq!(job["status"], "Disputed", "one vote must not execute");
    // The second approve reaches threshold: the DAO executes the
    // FunctionCall, so resolve_dispute runs in the Merit contract.
    vote(&env, &env.alice, pid, true).await?;
    let p = get_proposal(&env, pid).await?;
    assert_eq!(p["status"], "Approved");
    let job = dao_get_job(&env, "weld-1").await?;
    assert_eq!(job["status"], "Completed");
    let merit = dao_get_merit(&env, "merit-1").await?;
    assert_eq!(merit["balance_withdrawable"], y(95 * N / 100));
    assert_eq!(merit["balance_retained"], y(5 * N / 100));
    let stamps = merit["stamps"].as_array().expect("merit has stamps");
    let completion = stamps
        .iter()
        .find(|s| s["skill"] == "gate-welding")
        .expect("completion stamp issued by DAO pay_full");
    assert_eq!(completion["level"], 1);
    assert_eq!(completion["issuer_name"], "Job completion");
    Ok(())
}

#[tokio::test]
async fn dao_proposal_refund_executes() -> anyhow::Result<()> {
    let env = setup_dao().await?;
    // Fresh poster (dave) so the refund is the only inflow to
    // measure after the dispute is set up.
    let dave = env.worker.dev_create_account().await?;
    disputed_job(&env, "weld-1", &dave).await?;
    let before = dave.view_account().await?.balance.as_yoctonear();
    let pid = propose_resolve(&env, &env.carol, "weld-1", "refund", None).await?;
    vote(&env, &env.owner, pid, true).await?;
    vote(&env, &env.bob, pid, true).await?;
    let p = get_proposal(&env, pid).await?;
    assert_eq!(p["status"], "Approved");
    let job = dao_get_job(&env, "weld-1").await?;
    assert_eq!(job["status"], "Refunded");
    let after = dave.view_account().await?.balance.as_yoctonear();
    assert_eq!(after - before, N, "poster gets the full escrow back");
    let merit = dao_get_merit(&env, "merit-1").await?;
    assert_eq!(merit["balance_withdrawable"], y(0), "worker was not paid");
    assert!(
        merit["stamps"].as_array().unwrap().iter().all(|s| s["skill"] != "gate-welding"),
        "refund issues no completion stamp"
    );
    Ok(())
}

#[tokio::test]
async fn dao_proposal_partial_executes() -> anyhow::Result<()> {
    let env = setup_dao().await?;
    let dave = env.worker.dev_create_account().await?;
    disputed_job(&env, "weld-1", &dave).await?;
    let before = dave.view_account().await?.balance.as_yoctonear();
    let pid = propose_resolve(&env, &env.carol, "weld-1", "partial", Some(4 * N / 10)).await?;
    vote(&env, &env.owner, pid, true).await?;
    vote(&env, &env.alice, pid, true).await?;
    let p = get_proposal(&env, pid).await?;
    assert_eq!(p["status"], "Approved");
    let job = dao_get_job(&env, "weld-1").await?;
    assert_eq!(job["status"], "PartiallyPaid");
    let after = dave.view_account().await?.balance.as_yoctonear();
    assert_eq!(after - before, 6 * N / 10, "poster is refunded the remainder");
    let merit = dao_get_merit(&env, "merit-1").await?;
    assert_eq!(merit["balance_withdrawable"], y(38 * N / 100), "95% of the 0.4 NEAR worker amount");
    assert_eq!(merit["balance_retained"], y(2 * N / 100), "5% of the 0.4 NEAR worker amount");
    assert!(
        merit["stamps"].as_array().unwrap().iter().all(|s| s["skill"] != "gate-welding"),
        "partial issues no completion stamp"
    );
    Ok(())
}

#[tokio::test]
async fn dao_proposal_rejected_leaves_dispute_open() -> anyhow::Result<()> {
    let env = setup_dao().await?;
    disputed_job(&env, "weld-1", &env.carol).await?;
    let pid = propose_resolve(&env, &env.carol, "weld-1", "pay_full", None).await?;
    vote(&env, &env.owner, pid, false).await?;
    vote(&env, &env.alice, pid, false).await?;
    let p = get_proposal(&env, pid).await?;
    assert_eq!(p["status"], "Rejected");
    // The dispute stays open: no payment, no stamp.
    let job = dao_get_job(&env, "weld-1").await?;
    assert_eq!(job["status"], "Disputed");
    let merit = dao_get_merit(&env, "merit-1").await?;
    assert_eq!(merit["balance_withdrawable"], y(0));
    // Either side may propose a different outcome.
    let pid2 = propose_resolve(&env, &env.carol, "weld-1", "refund", None).await?;
    vote(&env, &env.owner, pid2, true).await?;
    vote(&env, &env.bob, pid2, true).await?;
    let p2 = get_proposal(&env, pid2).await?;
    assert_eq!(p2["status"], "Approved");
    let job = dao_get_job(&env, "weld-1").await?;
    assert_eq!(job["status"], "Refunded");
    Ok(())
}

// ---- Audit regression tests (M-01..M-08 + D) ----

/// M-01: the completion skill registry gates job awards.
#[tokio::test]
async fn completion_skill_registry_gates_jobs() -> anyhow::Result<()> {
    let env = setup().await?;
    let cid = env.contract.id();
    let skills: Vec<String> = env
        .worker
        .view(cid, "list_completion_skills")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(
        skills,
        vec![
            "welding",
            "torch-work",
            "gate-welding",
            "repair-welding",
            "merit-basics",
            "coding",
            "design",
            "writing",
            "data-entry",
        ],
        "registry seeds exactly the nine agreed skills"
    );
    // An unregistered completion skill is rejected at posting.
    let bad = env
        .bob
        .call(cid, "create_job")
        .args_json(json!({
            "job_id": "bad-1",
            "title": "Job bad-1",
            "description": "Test job",
            "required_stamps": [],
            "completion_stamp": { "skill": "brain-surgery", "level": 3 },
            "criteria": CRITERIA,
            "timeout_ns": null,
        }))
        .deposit(NearToken::from_yoctonear(N))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "unregistered completion skill must fail");
    assert!(failures_contain(&bad, "not registered"));
    // Only the DAO may extend the registry: the owner cannot.
    let bad = env
        .owner
        .call(cid, "add_completion_skill")
        .args_json(json!({ "skill": "plumbing" }))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "non-DAO add_completion_skill must fail");
    assert!(failures_contain(&bad, "not the Merit DAO"));
    // The DAO adds plumbing; a job awarding it now succeeds.
    env.dao
        .call(cid, "add_completion_skill")
        .args_json(json!({ "skill": "plumbing" }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    create_job(&env, &env.bob, "plumb-1", N, "welding", 1, None, ("plumbing", 1)).await?;
    let job = get_job(&env, "plumb-1").await?;
    assert_eq!(job["completion_stamp"]["skill"], "plumbing");
    // The DAO removes it again; new jobs awarding it fail.
    env.dao
        .call(cid, "remove_completion_skill")
        .args_json(json!({ "skill": "plumbing" }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let skills: Vec<String> = env
        .worker
        .view(cid, "list_completion_skills")
        .args_json(json!({}))
        .await?
        .json()?;
    assert!(!skills.contains(&"plumbing".to_string()));
    let bad = env
        .bob
        .call(cid, "create_job")
        .args_json(json!({
            "job_id": "plumb-2",
            "title": "Job plumb-2",
            "description": "Test job",
            "required_stamps": [],
            "completion_stamp": { "skill": "plumbing", "level": 1 },
            "criteria": CRITERIA,
            "timeout_ns": null,
        }))
        .deposit(NearToken::from_yoctonear(N))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "removed completion skill must fail");
    assert!(failures_contain(&bad, "not registered"));
    Ok(())
}

/// M-02: a job's arbiter is always the DAO, whatever the caller sends.
#[tokio::test]
async fn arbiter_is_always_dao() -> anyhow::Result<()> {
    let env = setup().await?;
    let cid = env.contract.id();
    create_job(&env, &env.bob, "weld-1", N, "welding", 1, None, ("gate-welding", 1)).await?;
    let job = get_job(&env, "weld-1").await?;
    assert_eq!(job["arbiter"], env.dao.id().to_string(), "arbiter is the DAO");
    // Even a caller-supplied arbiter in the args is ignored.
    env.bob
        .call(cid, "create_job")
        .args_json(json!({
            "job_id": "weld-2",
            "title": "Job weld-2",
            "description": "Test job",
            "required_stamps": [{ "skill": "welding", "min_level": 1 }],
            "completion_stamp": { "skill": "gate-welding", "level": 1 },
            "criteria": CRITERIA,
            "timeout_ns": null,
            "arbiter": env.bob.id().to_string(),
        }))
        .deposit(NearToken::from_yoctonear(N))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let job = get_job(&env, "weld-2").await?;
    assert_eq!(
        job["arbiter"],
        env.dao.id().to_string(),
        "a poster-supplied arbiter must not stick"
    );
    Ok(())
}

/// M-03: cancel_job refunds the exact escrow once, poster-only, Open-only.
#[tokio::test]
async fn cancel_job_refunds_exactly_once() -> anyhow::Result<()> {
    let env = setup().await?;
    let cid = env.contract.id();
    create_job(&env, &env.bob, "weld-1", N, "welding", 1, None, ("gate-welding", 1)).await?;
    // A non-poster cannot cancel.
    let bad = env
        .alice
        .call(cid, "cancel_job")
        .args_json(json!({ "job_id": "weld-1" }))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "non-poster cancel must fail");
    assert!(failures_contain(&bad, "only the poster may cancel"));
    // The poster cancels: the contract balance falls by exactly 1 NEAR.
    let before = env
        .contract
        .as_account()
        .view_account()
        .await?
        .balance
        .as_yoctonear();
    env.bob
        .call(cid, "cancel_job")
        .args_json(json!({ "job_id": "weld-1" }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let after = env
        .contract
        .as_account()
        .view_account()
        .await?
        .balance
        .as_yoctonear();
    assert_eq!(before - after, N, "cancel must refund the exact escrow once");
    let job = get_job(&env, "weld-1").await?;
    assert_eq!(job["status"], "Cancelled");
    assert_eq!(job["refund_pending"], false, "refund settled, nothing pending");
    // Duplicate cancel fails: the job is no longer Open.
    let bad = env
        .bob
        .call(cid, "cancel_job")
        .args_json(json!({ "job_id": "weld-1" }))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "duplicate cancel must fail");
    assert!(failures_contain(&bad, "only an open job can be cancelled"));
    // Retry with nothing pending fails too.
    let bad = env
        .bob
        .call(cid, "retry_cancel_refund")
        .args_json(json!({ "job_id": "weld-1" }))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "retry with nothing pending must fail");
    // Cancel after acceptance fails.
    mint(&env, &env.alice, "merit-1").await?;
    stamp(&env, &env.owner, "merit-1", "welding", 1).await?;
    create_job(&env, &env.bob, "weld-2", N, "welding", 1, None, ("gate-welding", 1)).await?;
    env.alice
        .call(cid, "accept_job")
        .args_json(json!({ "job_id": "weld-2", "token_id": "merit-1" }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let bad = env
        .bob
        .call(cid, "cancel_job")
        .args_json(json!({ "job_id": "weld-2" }))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "cancel after acceptance must fail");
    assert!(failures_contain(&bad, "only an open job can be cancelled"));
    Ok(())
}

/// M-04: nft_mint requires exactly 0.1 NEAR — over and under both fail.
#[tokio::test]
async fn mint_requires_exact_deposit() -> anyhow::Result<()> {
    let env = setup().await?;
    let cid = env.contract.id();
    let over = env
        .alice
        .call(cid, "nft_mint")
        .args_json(json!({ "token_id": "merit-1", "receiver_id": env.alice.id() }))
        .deposit(NearToken::from_yoctonear(N / 10 + 1))
        .gas(MINT_GAS)
        .transact()
        .await?;
    assert!(over.is_failure(), "overpayment must fail");
    assert!(failures_contain(&over, "exactly 0.1 NEAR"));
    let under = env
        .alice
        .call(cid, "nft_mint")
        .args_json(json!({ "token_id": "merit-1", "receiver_id": env.alice.id() }))
        .deposit(NearToken::from_yoctonear(N / 10 - 1))
        .gas(MINT_GAS)
        .transact()
        .await?;
    assert!(under.is_failure(), "underpayment must fail");
    assert!(failures_contain(&under, "exactly 0.1 NEAR"));
    mint(&env, &env.alice, "merit-1").await?;
    let merit = get_merit(&env, "merit-1").await?;
    assert_eq!(merit["level"], 0, "exact payment still mints");
    Ok(())
}

/// M-05: completion stamps obey the 64-stamp cap; updating an
/// existing skill at the cap still works, and a failed completion
/// settles nothing.
#[tokio::test]
async fn completion_stamp_cap_enforced() -> anyhow::Result<()> {
    let env = setup().await?;
    let cid = env.contract.id();
    mint(&env, &env.alice, "merit-1").await?;
    stamp(&env, &env.owner, "merit-1", "welding", 1).await?;
    for i in 0..63u32 {
        stamp(&env, &env.owner, "merit-1", &format!("skill-{:02}", i), 1).await?;
    }
    let merit = get_merit(&env, "merit-1").await?;
    assert_eq!(merit["stamps"].as_array().unwrap().len(), 64);
    // A job completing with a NEW registered skill fails safely.
    env.bob
        .call(cid, "create_job")
        .args_json(json!({
            "job_id": "cap-1",
            "title": "Job cap-1",
            "description": "Test job",
            "required_stamps": [],
            "completion_stamp": { "skill": "coding", "level": 1 },
            "criteria": CRITERIA,
            "timeout_ns": null,
        }))
        .deposit(NearToken::from_yoctonear(N))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    env.alice
        .call(cid, "accept_job")
        .args_json(json!({ "job_id": "cap-1", "token_id": "merit-1" }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let bad = env
        .bob
        .call(cid, "complete_job")
        .args_json(json!({ "job_id": "cap-1", "token_id": "merit-1" }))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "completion past the cap must fail");
    assert!(failures_contain(&bad, "too many distinct stamps"));
    // Nothing settled: the job is still Accepted, no money moved.
    let job = get_job(&env, "cap-1").await?;
    assert_eq!(job["status"], "Accepted");
    assert_eq!(sub_balance(&env, "merit-1").await?, N / 20, "no payment on a failed completion");
    let merit = get_merit(&env, "merit-1").await?;
    assert_eq!(merit["balance_withdrawable"], y(0));
    // Updating an EXISTING skill at the cap succeeds.
    env.bob
        .call(cid, "create_job")
        .args_json(json!({
            "job_id": "cap-2",
            "title": "Job cap-2",
            "description": "Test job",
            "required_stamps": [],
            "completion_stamp": { "skill": "welding", "level": 3 },
            "criteria": CRITERIA,
            "timeout_ns": null,
        }))
        .deposit(NearToken::from_yoctonear(N))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    env.alice
        .call(cid, "accept_job")
        .args_json(json!({ "job_id": "cap-2", "token_id": "merit-1" }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    env.bob
        .call(cid, "complete_job")
        .args_json(json!({ "job_id": "cap-2", "token_id": "merit-1" }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let merit = get_merit(&env, "merit-1").await?;
    assert_eq!(merit["stamps"].as_array().unwrap().len(), 64, "still 64 stamps");
    assert_eq!(merit["balance_withdrawable"], y(95 * N / 100));
    let updated = merit["stamps"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["skill"] == "welding")
        .expect("welding present");
    assert_eq!(updated["level"], 3, "existing skill level rises at the cap");
    Ok(())
}

/// M-06: evidence refs are stored alongside the hashes, per side.
#[tokio::test]
async fn evidence_reference_stored() -> anyhow::Result<()> {
    let env = setup().await?;
    let cid = env.contract.id();
    mint(&env, &env.alice, "merit-1").await?;
    stamp(&env, &env.owner, "merit-1", "welding", 1).await?;
    create_job(&env, &env.bob, "weld-1", N, "welding", 1, Some(5_000_000_000), ("gate-welding", 1)).await?;
    env.alice
        .call(cid, "accept_job")
        .args_json(json!({ "job_id": "weld-1", "token_id": "merit-1" }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    env.bob
        .call(cid, "raise_dispute")
        .args_json(json!({ "job_id": "weld-1" }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let poster_hash = evidence_hash(b"poster photos");
    let worker_hash = evidence_hash(b"worker photos");
    env.bob
        .call(cid, "submit_evidence")
        .args_json(json!({
            "job_id": "weld-1",
            "evidence_hash": poster_hash,
            "evidence_ref": "ipfs://bafyposter",
        }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    env.alice
        .call(cid, "submit_evidence")
        .args_json(json!({
            "job_id": "weld-1",
            "evidence_hash": worker_hash,
            "evidence_ref": "ipfs://bafyworker",
        }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let job = get_job(&env, "weld-1").await?;
    assert_eq!(job["poster_evidence"], poster_hash);
    assert_eq!(job["poster_evidence_ref"], "ipfs://bafyposter");
    assert_eq!(job["worker_evidence"], worker_hash);
    assert_eq!(job["worker_evidence_ref"], "ipfs://bafyworker");
    // Re-submit with no ref clears the reference (latest counts).
    env.bob
        .call(cid, "submit_evidence")
        .args_json(json!({
            "job_id": "weld-1",
            "evidence_hash": poster_hash,
            "evidence_ref": null,
        }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let job = get_job(&env, "weld-1").await?;
    assert_eq!(job["poster_evidence_ref"], serde_json::Value::Null);
    // Hash validation still applies with a ref present.
    let bad = env
        .bob
        .call(cid, "submit_evidence")
        .args_json(json!({
            "job_id": "weld-1",
            "evidence_hash": "xyz",
            "evidence_ref": "ipfs://bafywhatever",
        }))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "bad evidence hash must still fail");
    Ok(())
}

/// M-07: job input bounds and paginated list views.
#[tokio::test]
async fn job_bounds_and_pagination() -> anyhow::Result<()> {
    let env = setup().await?;
    let cid = env.contract.id();
    // Description over 2000 chars is rejected; exactly 2000 is fine.
    let bad = env
        .bob
        .call(cid, "create_job")
        .args_json(json!({
            "job_id": "long-1",
            "title": "Job long-1",
            "description": "x".repeat(2001),
            "required_stamps": [],
            "completion_stamp": { "skill": "welding", "level": 1 },
            "criteria": CRITERIA,
            "timeout_ns": null,
        }))
        .deposit(NearToken::from_yoctonear(N))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "2001-char description must fail");
    assert!(failures_contain(&bad, "at most 2000 characters"));
    env.bob
        .call(cid, "create_job")
        .args_json(json!({
            "job_id": "long-2",
            "title": "Job long-2",
            "description": "x".repeat(2000),
            "required_stamps": [],
            "completion_stamp": { "skill": "welding", "level": 1 },
            "criteria": CRITERIA,
            "timeout_ns": null,
        }))
        .deposit(NearToken::from_yoctonear(N))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    // 11 required stamps is rejected; 10 is fine.
    let eleven: Vec<serde_json::Value> = (0..11)
        .map(|i| json!({ "skill": format!("skill-{}", i), "min_level": 1 }))
        .collect();
    let bad = env
        .bob
        .call(cid, "create_job")
        .args_json(json!({
            "job_id": "many-1",
            "title": "Job many-1",
            "description": "Test job",
            "required_stamps": eleven,
            "completion_stamp": { "skill": "welding", "level": 1 },
            "criteria": CRITERIA,
            "timeout_ns": null,
        }))
        .deposit(NearToken::from_yoctonear(N))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "11 required stamps must fail");
    assert!(failures_contain(&bad, "at most 10 entries"));
    let ten: Vec<serde_json::Value> = (0..10)
        .map(|i| json!({ "skill": format!("skill-{}", i), "min_level": 1 }))
        .collect();
    env.bob
        .call(cid, "create_job")
        .args_json(json!({
            "job_id": "many-2",
            "title": "Job many-2",
            "description": "Test job",
            "required_stamps": ten,
            "completion_stamp": { "skill": "welding", "level": 1 },
            "criteria": CRITERIA,
            "timeout_ns": null,
        }))
        .deposit(NearToken::from_yoctonear(N))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    // Pagination: 2 jobs exist (long-2, many-2); add a third.
    create_job(&env, &env.bob, "pg-3", N, "welding", 1, None, ("gate-welding", 1)).await?;
    let page1: serde_json::Value = env
        .worker
        .view(cid, "list_jobs")
        .args_json(json!({ "from_index": "0", "limit": 2 }))
        .await?
        .json()?;
    assert_eq!(page1.as_array().unwrap().len(), 2);
    assert_eq!(page1[0]["job_id"], "long-2", "stable ordering, first page");
    let page2: serde_json::Value = env
        .worker
        .view(cid, "list_jobs")
        .args_json(json!({ "from_index": "2", "limit": 2 }))
        .await?
        .json()?;
    assert_eq!(page2.as_array().unwrap().len(), 1);
    assert_eq!(page2[0]["job_id"], "pg-3", "second page continues");
    // A limit above the cap is capped, not an error.
    let all: serde_json::Value = env
        .worker
        .view(cid, "list_jobs")
        .args_json(json!({ "from_index": "0", "limit": 100 }))
        .await?
        .json()?;
    assert_eq!(all.as_array().unwrap().len(), 3);
    // Extreme pagination values return empty, never trap.
    let none: serde_json::Value = env
        .worker
        .view(cid, "list_jobs")
        .args_json(json!({ "from_index": "18446744073709551615", "limit": 18446744073709551615u64 }))
        .await?
        .json()?;
    assert_eq!(none.as_array().unwrap().len(), 0);
    let none: serde_json::Value = env
        .worker
        .view(cid, "list_issuers")
        .args_json(json!({ "from_index": "18446744073709551615", "limit": 18446744073709551615u64 }))
        .await?
        .json()?;
    assert_eq!(none.as_array().unwrap().len(), 0);
    let issuers: serde_json::Value = env
        .worker
        .view(cid, "list_issuers")
        .args_json(json!({ "from_index": "0", "limit": 50 }))
        .await?
        .json()?;
    assert_eq!(issuers.as_array().unwrap().len(), 1);
    let none: serde_json::Value = env
        .worker
        .view(cid, "nft_tokens")
        .args_json(json!({ "from_index": "18446744073709551615", "limit": 18446744073709551615u64 }))
        .await?
        .json()?;
    assert_eq!(none.as_array().unwrap().len(), 0);
    Ok(())
}

/// M-08: buy_kit spends retained balance, pays the seller, and
/// never touches withdrawable funds.
#[tokio::test]
async fn buy_kit_spends_retained() -> anyhow::Result<()> {
    let env = setup().await?;
    let cid = env.contract.id();
    mint(&env, &env.alice, "merit-1").await?;
    stamp(&env, &env.owner, "merit-1", "welding", 2).await?;
    create_job(&env, &env.bob, "weld-1", 2 * N, "welding", 2, None, ("gate-welding", 1)).await?;
    env.alice
        .call(cid, "accept_job")
        .args_json(json!({ "job_id": "weld-1", "token_id": "merit-1" }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    env.bob
        .call(cid, "complete_job")
        .args_json(json!({ "job_id": "weld-1", "token_id": "merit-1" }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let merit = get_merit(&env, "merit-1").await?;
    assert_eq!(merit["balance_withdrawable"], y(19 * N / 10));
    assert_eq!(merit["balance_retained"], y(N / 10));
    // kit_price view reports 0.1 NEAR.
    let price: String = env
        .worker
        .view(cid, "kit_price")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(price, y(N / 10));
    // The seller (bob) owns torch-9; the holder cannot buy a kit
    // that does not exist, and a non-holder cannot buy at all.
    env.owner
        .call(cid, "mint_kit")
        .args_json(json!({
            "kit_token_id": "torch-9",
            "name": "Welding Torch",
            "receiver_id": env.bob.id(),
        }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let bad = env
        .bob
        .call(cid, "buy_kit")
        .args_json(json!({ "token_id": "merit-1", "kit_token_id": "torch-9" }))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "non-holder buy_kit must fail");
    assert!(failures_contain(&bad, "not the Merit holder"));
    let bad = env
        .alice
        .call(cid, "buy_kit")
        .args_json(json!({ "token_id": "merit-1", "kit_token_id": "no-such-kit" }))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "buying a missing kit must fail");
    assert!(failures_contain(&bad, "kit not found"));
    // The holder buys: retained 0.1 -> 0, seller gains exactly 0.1.
    let seller_before = env.bob.view_account().await?.balance.as_yoctonear();
    env.alice
        .call(cid, "buy_kit")
        .args_json(json!({ "token_id": "merit-1", "kit_token_id": "torch-9" }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let seller_after = env.bob.view_account().await?.balance.as_yoctonear();
    assert_eq!(seller_after - seller_before, N / 10, "seller is paid exactly the kit price");
    let merit = get_merit(&env, "merit-1").await?;
    assert_eq!(merit["balance_retained"], y(0), "retained is spent");
    assert_eq!(
        merit["balance_withdrawable"],
        y(19 * N / 10),
        "withdrawable is untouched by buy_kit"
    );
    assert_eq!(merit["kit"], json!(["torch-9"]));
    assert_eq!(
        sub_balance(&env, "merit-1").await?,
        N / 20 + 19 * N / 10,
        "sub-account keeps init + withdrawable after the kit payout"
    );
    let kit: serde_json::Value = env
        .worker
        .view(cid, "get_kit")
        .args_json(json!({ "kit_token_id": "torch-9" }))
        .await?
        .json()?;
    assert_eq!(kit["owner_id"], env.alice.id().to_string());
    assert_eq!(kit["inside_merit"], "merit-1");
    // A second kit is unaffordable now: retained is empty.
    env.owner
        .call(cid, "mint_kit")
        .args_json(json!({
            "kit_token_id": "torch-10",
            "name": "Spare Torch",
            "receiver_id": env.bob.id(),
        }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let bad = env
        .alice
        .call(cid, "buy_kit")
        .args_json(json!({ "token_id": "merit-1", "kit_token_id": "torch-10" }))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "buy_kit without retained funds must fail");
    assert!(failures_contain(&bad, "below the kit price"));
    Ok(())
}

/// D: issuer control is DAO-only, and revoke_stamp removes a stamp
/// without unlocking the Merit (the lock stays once earned).
#[tokio::test]
async fn dao_issuer_governance_and_revoke_stamp() -> anyhow::Result<()> {
    let env = setup().await?;
    let cid = env.contract.id();
    mint(&env, &env.alice, "merit-1").await?;
    // The owner can no longer add issuers: only the DAO can.
    let bad = env
        .owner
        .call(cid, "add_issuer")
        .args_json(json!({ "account_id": env.carol.id(), "name": "Carol Crafts" }))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "owner add_issuer must fail");
    assert!(failures_contain(&bad, "not the Merit DAO"));
    let bad = env
        .owner
        .call(cid, "remove_issuer")
        .args_json(json!({ "account_id": env.owner.id() }))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "owner remove_issuer must fail");
    // The DAO adds Carol; she stamps plumbing.
    env.dao
        .call(cid, "add_issuer")
        .args_json(json!({ "account_id": env.carol.id(), "name": "Carol Crafts" }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    stamp(&env, &env.carol, "merit-1", "plumbing", 1).await?;
    // The DAO revokes the stamp: it is gone, but the Merit stays locked.
    env.dao
        .call(cid, "revoke_stamp")
        .args_json(json!({ "token_id": "merit-1", "skill": "plumbing" }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let merit = get_merit(&env, "merit-1").await?;
    assert_eq!(merit["stamps"].as_array().unwrap().len(), 0, "stamp revoked");
    assert_eq!(merit["level"], 0);
    assert_eq!(merit["locked"], true, "revoking the last stamp does NOT unlock");
    let bad = env
        .alice
        .call(cid, "nft_transfer")
        .args_json(json!({ "receiver_id": env.bob.id(), "token_id": "merit-1" }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "revoked Merit still cannot transfer");
    assert!(failures_contain(&bad, "locked Merit cannot be transferred"));
    // The recorded issuer may revoke their own stamp.
    stamp(&env, &env.owner, "merit-1", "welding", 2).await?;
    env.owner
        .call(cid, "revoke_stamp")
        .args_json(json!({ "token_id": "merit-1", "skill": "welding" }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let merit = get_merit(&env, "merit-1").await?;
    assert_eq!(merit["stamps"].as_array().unwrap().len(), 0);
    assert_eq!(merit["locked"], true, "lock still holds after issuer revoke");
    // A stranger who is neither DAO nor the stamp issuer cannot revoke.
    stamp(&env, &env.owner, "merit-1", "welding", 2).await?;
    let bad = env
        .bob
        .call(cid, "revoke_stamp")
        .args_json(json!({ "token_id": "merit-1", "skill": "welding" }))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "stranger revoke must fail");
    assert!(failures_contain(&bad, "neither the Merit DAO nor the stamp issuer"));
    // Revoking a stamp that is not there fails.
    let bad = env
        .dao
        .call(cid, "revoke_stamp")
        .args_json(json!({ "token_id": "merit-1", "skill": "no-such-skill" }))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "revoking a missing stamp must fail");
    assert!(failures_contain(&bad, "stamp not found"));
    Ok(())
}

/// Migrate: the pre-audit wasm state (token + job) survives the
/// upgrade to the new code, with the registry seeded.
fn old_merit_wasm() -> Vec<u8> {
    load_wasm("contract/tests/merit-old.wasm")
}

#[tokio::test]
async fn migrate_preserves_tokens_and_jobs() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&old_merit_wasm()).await?;
    let owner = worker.dev_create_account().await?;
    let alice = worker.dev_create_account().await?;
    let bob = worker.dev_create_account().await?;
    let dao = worker.dev_create_account().await?;
    let cid = contract.id();
    owner
        .call(cid, "new")
        .args_json(json!({ "owner_id": owner.id(), "dao_id": dao.id() }))
        .transact()
        .await?
        .into_result()?;
    owner
        .call(cid, "deploy_wallet_global")
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    // Live v1 state: a stamped Merit and an open job (old API).
    alice
        .call(cid, "nft_mint")
        .args_json(json!({
            "token_id": "merit-1",
            "receiver_id": alice.id(),
            "metadata": { "title": "Merit merit-1" },
        }))
        .deposit(NearToken::from_yoctonear(N / 10))
        .gas(MINT_GAS)
        .transact()
        .await?
        .into_result()?;
    owner
        .call(cid, "stamp")
        .args_json(json!({ "token_id": "merit-1", "skill": "welding", "level": 1 }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    bob.call(cid, "create_job")
        .args_json(json!({
            "job_id": "weld-1",
            "title": "Job weld-1",
            "description": "Test job",
            "required_stamps": [{ "skill": "welding", "min_level": 1 }],
            "completion_stamp": { "skill": "gate-welding", "level": 1 },
            "criteria": CRITERIA,
            "timeout_ns": null,
            "arbiter": null,
        }))
        .deposit(NearToken::from_yoctonear(N))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    // Upgrade the code in place, then migrate as the owner.
    contract
        .as_account()
        .deploy(&merit_wasm())
        .await?
        .into_result()?;
    owner
        .call(cid, "migrate")
        .args_json(json!({}))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    // The token survives: stamp, level, lock all intact.
    let merit: serde_json::Value = worker
        .view(cid, "get_merit")
        .args_json(json!({ "token_id": "merit-1" }))
        .await?
        .json()?;
    assert_eq!(merit["level"], 1);
    assert_eq!(merit["locked"], true);
    assert_eq!(merit["stamps"][0]["skill"], "welding");
    assert_eq!(merit["balance_withdrawable"], y(0));
    assert_eq!(merit["balance_retained"], y(0));
    // The job survives: open, same arbiter, new fields defaulted.
    let job: serde_json::Value = worker
        .view(cid, "get_job")
        .args_json(json!({ "job_id": "weld-1" }))
        .await?
        .json()?;
    assert_eq!(job["status"], "Open");
    assert_eq!(job["arbiter"], dao.id().to_string());
    assert_eq!(job["payment"], y(N));
    assert_eq!(job["poster_evidence_ref"], serde_json::Value::Null);
    assert_eq!(job["worker_evidence_ref"], serde_json::Value::Null);
    assert_eq!(job["refund_pending"], false);
    // The registry is seeded by the migration.
    let skills: Vec<String> = worker
        .view(cid, "list_completion_skills")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(skills.len(), 9);
    assert!(skills.contains(&"gate-welding".to_string()));
    // New behaviour works on migrated state: the old job can still
    // be cancelled by its poster, and a fresh mint works.
    bob.call(cid, "cancel_job")
        .args_json(json!({ "job_id": "weld-1" }))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let job: serde_json::Value = worker
        .view(cid, "get_job")
        .args_json(json!({ "job_id": "weld-1" }))
        .await?
        .json()?;
    assert_eq!(job["status"], "Cancelled");
    alice
        .call(cid, "nft_mint")
        .args_json(json!({
            "token_id": "merit-2",
            "receiver_id": alice.id(),
            "metadata": { "title": "Merit merit-2" },
        }))
        .deposit(NearToken::from_yoctonear(N / 10))
        .gas(MINT_GAS)
        .transact()
        .await?
        .into_result()?;
    let merit2: serde_json::Value = worker
        .view(cid, "get_merit")
        .args_json(json!({ "token_id": "merit-2" }))
        .await?
        .json()?;
    assert_eq!(merit2["locked"], false, "fresh Merit is unlocked");
    // A second migrate fails closed.
    let bad = owner
        .call(cid, "migrate")
        .args_json(json!({}))
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "second migrate must fail");
    Ok(())
}
