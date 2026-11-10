//! Merit wallet — one tiny contract per Merit token, running on that
//! token's own sub-account (`{token_id}.{merit-contract}`).
//!
//! The wallet holds the Merit's money (job payments land here). It
//! has exactly one money-moving method, `payout`, and it only obeys
//! the parent Merit contract: the predecessor must be the parent
//! recorded at init, and the payout goes to whoever the parent says
//! is the current holder. Nobody else — not even the Merit holder —
//! can move money out of the wallet directly; withdrawals go through
//! the Merit contract, which enforces holder-only access and the
//! withdrawable/retained split. On lend, the parent still controls
//! it, so the money follows the parent's record of who may use the
//! Merit.
//!
//! The wallet account holds no keys, so it can never be deleted or
//! taken over. It is published ONCE as a global contract (by code
//! hash) and every sub-account references that one published code —
//! so each mint pays only account-creation storage, not a fresh copy
//! of the code.

use near_sdk::json_types::U128;
use near_sdk::{env, near, AccountId, NearToken, PanicOnDefault, Promise};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Wallet {
    parent: AccountId,
}

#[near]
impl Wallet {
    #[init]
    pub fn init(parent: AccountId) -> Self {
        assert!(!env::state_exists(), "already initialized");
        Self { parent }
    }

    /// Pay `amount` yoctoNEAR to `receiver`. Only the parent Merit
    /// contract may call this.
    pub fn payout(&mut self, receiver: AccountId, amount: U128) {
        assert_eq!(
            env::predecessor_account_id(),
            self.parent,
            "only the parent Merit contract may pay out of the wallet"
        );
        let amount: u128 = amount.into();
        assert!(amount > 0, "payout amount must be positive");
        assert!(
            env::account_balance().as_yoctonear() >= amount,
            "wallet balance insufficient for payout"
        );
        Promise::new(receiver)
            .transfer(NearToken::from_yoctonear(amount))
            .detach();
    }

    pub fn get_parent(&self) -> AccountId {
        self.parent.clone()
    }
}
