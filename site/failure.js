// Failure classifier for Merit. Pure function, no DOM: it takes a
// failure (an Error, a string, or anything with a message) and returns
// exactly one of four categories with display text. The site never shows
// a bare "transaction failed", and never shows success before the chain
// confirms it.
//
// Categories:
// * contract: the chain rejected the call (the contract's panic message
//   names the rule violated). No money moved.
// * network: the RPC could not be reached or timed out. The transaction
//   may not have been sent.
// * gas: the call ran out of gas and did not execute. No money moved.
// * wallet: the user declined in the wallet, or no wallet is connected.
//   Nothing was sent.
//
// The gate refusal is a feature, not a bug: when a Merit lacks the stamp
// a job needs, the site says so plainly instead of showing a raw panic.
function classifyFailure(input) {
  const raw = (function (v) {
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (typeof v.message === "string") return v.message;
    if (typeof v.toString === "function") return v.toString();
    return String(v);
  })(input);
  const lower = raw.toLowerCase();

  // The gate refusal, matched first so it never reads as a raw panic.
  const gateNeedles = [
    "lacks the required stamp",
    "does not have the required stamp",
    "missing required stamp",
    "stamp required",
    "access refused",
    "access denied",
    "no access",
    "does not meet the required",
    "insufficient stamp",
  ];
  for (const needle of gateNeedles) {
    if (lower.indexOf(needle) >= 0) {
      return { category: "contract", rule: needle, text: "Access refused: this Merit lacks the required stamp. No money moved." };
    }
  }

  // The specific contract rules, matched next so the display names the
  // rule that was violated.
  const rules = [
    ["locked", "Rejected. This Merit is locked and cannot be sold or transferred while it carries a stamp. No money moved."],
    ["cannot be transferred", "Rejected. This Merit is locked and cannot be transferred while it carries a stamp. No money moved."],
    ["only the issuer", "Rejected. Only the stamp issuer may call this method. No money moved."],
    ["only the holder", "Rejected. Only the Merit holder may call this method. No money moved."],
    ["only the owner", "Rejected. Only the Merit owner may call this method. No money moved."],
    ["not the owner", "Rejected. Only the Merit owner may call this method. No money moved."],
    ["token does not exist", "Rejected. That Merit does not exist. Check the token id and try again. No money moved."],
    ["job does not exist", "Rejected. That job does not exist. No money moved."],
    ["job is not open", "Rejected. That job is not open any more. No money moved."],
    ["job already accepted", "Rejected. That job was already accepted. No money moved."],
    ["insufficient balance", "Rejected. The Merit account balance is too low for that amount. No money moved."],
    ["amount exceeds", "Rejected. The amount is larger than the withdrawable balance. No money moved."],
    ["kit does not exist", "Rejected. That kit item does not exist. No money moved."],
    ["kit not in merit", "Rejected. That kit item is not inside this Merit. No money moved."],
    ["already lent", "Rejected. This Merit is already lent out. Revoke the current lend first. No money moved."],
    ["lend expired", "Rejected. The lend has expired. No money moved."],
    ["invalid token id", "Rejected. The token id is not valid. Use lowercase letters, digits and hyphens only, 1 to 32 characters, not starting or ending with a hyphen. No money moved."],
  ];
  for (const [needle, text] of rules) {
    if (lower.indexOf(needle) >= 0) {
      return { category: "contract", rule: needle, text: text };
    }
  }

  // Wallet failures: the user declined, or no wallet is connected.
  if (/declin|user reject|rejected by user|not connected|no wallet|wallet (is )?not|wallet unavailable|aborted by user/i.test(raw)) {
    return { category: "wallet", rule: null, text: "You declined the transaction in your wallet. Nothing was sent." };
  }

  // Gas failures.
  if (/out of gas|exceeded the prepaid gas|gas limit|intrinsic gas|not enough gas/i.test(raw)) {
    return { category: "gas", rule: null, text: "Ran out of gas. The transaction did not execute. No money moved. Try again." };
  }

  // Contract failures: the chain ran the call and it panicked.
  if (/panic|smart contract|guest panic|execution error|receipt.*fail|action.*fail|invalid transaction|account does not exist/i.test(raw)) {
    const shown = raw.length > 200 ? raw.slice(0, 200) : raw;
    return { category: "contract", rule: null, text: "Rejected by the contract. " + shown + " No money moved." };
  }

  // Network failures: the RPC could not be reached or timed out.
  if (/failed to fetch|network ?error|timeout|timed out|rpc|econnrefused|enotfound|socket hang up|all rpc endpoints failed/i.test(raw)) {
    return { category: "network", rule: null, text: "Network error. The transaction may not have been sent. Check your connection and try again. No money moved." };
  }

  // Unknown: show the message itself rather than a bare failure, and
  // treat it as a contract rejection.
  const shown = raw.length > 200 ? raw.slice(0, 200) : raw;
  return { category: "contract", rule: null, text: "Rejected. " + (shown || "The transaction did not complete.") + " No money moved." };
}

(function (root) {
  if (typeof module !== "undefined" && module.exports) module.exports = { classifyFailure: classifyFailure };
  if (root) root.classifyFailure = classifyFailure;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null));
