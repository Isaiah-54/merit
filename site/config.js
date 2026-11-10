// Site config for Merit.
// Deployed 2026-11-09: contract merit-nft.testnet, DAO merit-dao.testnet.
window.BRAND_NAME = "Merit";
window.CONTRACT_ID = "merit-nft.testnet";
// Merit DAO (Sputnik v2), deployed 2026-11-09.
window.DAO_ID = "merit-dao.testnet";

// Testnet only. Never point this at mainnet.
window.NETWORK = "testnet";
window.RPC_ENDPOINTS = ["https://rpc.testnet.near.org", "https://rpc.testnet.fastnear.com"];

// Mint price for a blank Merit (0.1 NEAR, yoctoNEAR as a string).
window.STORAGE = {
  mint: "100000000000000000000000", // 0.1 NEAR
};
window.GAS_100 = "100000000000000";
window.GAS_150 = "150000000000000";
// DAO votes need 300 TGas: the threshold-reaching vote executes the
// proposal's own call inside the same transaction.
window.GAS_300 = "300000000000000";
