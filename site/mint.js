// Mint page: a blank Merit, your own sub-account, ready to earn
// stamps. Same wallet flow and 0.1 NEAR price as the mint form on
// Home. After minting, the new Merit card shows here with a link to
// open it. A mint sent in this session survives the wallet redirect
// through sessionStorage, so the card appears when the wallet sends
// the visitor back.
function showMintResult(tokenId, title) {
  const wrap = el("mintResult");
  if (!wrap) return;
  const displayTitle = String(title || "").trim();
  const subAccount = tokenId + "." + window.CONTRACT_ID;
  wrap.innerHTML =
    "<h2>Your new Merit</h2>" +
    "<div class=\"merit-card\">" + meritRings() +
    "<div class=\"merit-card-in\">" + meritBadgeArt(tokenId, 0, []) +
    "<div style=\"min-width:200px;flex:1\">" +
    "<div class=\"mc-label\">Merit credential \u2022 NEAR testnet</div>" +
    "<div class=\"mc-id mono\">" + escapeHtml(tokenId) + "</div>" +
    (displayTitle && displayTitle !== tokenId ? "<div class=\"mc-meta\">" + escapeHtml(displayTitle) + "</div>" : "") +
    (walletAccountId ? "<div class=\"mc-meta\">Owner: <span class=\"mono\">" + escapeHtml(walletAccountId) + "</span></div>" : "") +
    "<div class=\"mc-meta\">Own sub-account: <span class=\"mono\">" + escapeHtml(subAccount) + "</span>, where job payments land</div>" +
    "<p style=\"margin:10px 0 0\"><span class=\"chip open\">Blank, no stamps yet, level 0</span></p>" +
    "</div>" +
    levelBadgeHtml(0, [], ", blank, ready to earn stamps") +
    "</div></div>" +
    "<h2>What is next</h2>" +
    "<div class=\"next-step\"><div class=\"next-step-card\">" +
    "<span class=\"next-step-num\" aria-hidden=\"true\">2</span>" +
    "<div class=\"next-step-body\"><div class=\"next-step-label\">Next step: pass the demo test</div>" +
    "<p class=\"next-step-text\">Pass the demo test to earn your first stamp and open gated jobs.</p></div>" +
    "<a class=\"btn\" href=\"merit.html?id=" + encodeURIComponent(tokenId) + "#testSection\">Pass the demo test</a>" +
    "</div></div>" +
    "<p style=\"margin-top:14px\"><a class=\"btn secondary\" href=\"merit.html?id=" + encodeURIComponent(tokenId) + "\">Open your new Merit</a></p>" +
    "<p class=\"muted small\">Mint sent. If the Merit does not open yet, give the chain a few seconds to confirm, then tap the link again.</p>";
  try { wrap.scrollIntoView({ block: "nearest", behavior: "smooth" }); } catch (_) { /* scroll unavailable */ }
}

// Build the exact mint call the form sends. Kept separate so the
// headless verifier can check the call without a real wallet.
function buildMintPageCall(tokenId, title, receiverId) {
  return {
    method: "nft_mint",
    args: {
      token_id: tokenId,
      receiver_id: receiverId,
      metadata: {
        title: title || tokenId,
        description: "A Merit: proof earned through work.",
      },
    },
    depositYocto: window.STORAGE.mint,
    gas: window.GAS_100,
  };
}

document.getElementById("mintPageForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!walletAccountId) { pageStatus("Connect your wallet first."); return; }
  const tokenId = el("mintPageTokenId").value.trim();
  const bad = validateTokenId(tokenId);
  if (bad) { pageStatus(bad); return; }
  const title = el("mintPageTitle").value.trim();
  const call = buildMintPageCall(tokenId, title, walletAccountId);
  const btn = el("mintPageBtn");
  btn.disabled = true;
  pageStatus("Sending mint. Confirm in your wallet.");
  try {
    try {
      sessionStorage.setItem("merit-pending-mint", tokenId);
      sessionStorage.setItem("merit-pending-mint-title", title);
    } catch (_) { /* storage unavailable */ }
    const res = await walletCall(contractId(), call.method, call.args, call.depositYocto, call.gas);
    try {
      sessionStorage.removeItem("merit-pending-mint");
      sessionStorage.removeItem("merit-pending-mint-title");
    } catch (_) { /* storage unavailable */ }
    const hash = txHashFromWalletResult(res);
    setTxStatus("Mint sent. Your new Merit is below. It will open once the chain confirms it.", hash, "Pass the demo test to earn your first stamp and open gated jobs.");
    showMintResult(tokenId, title);
  } catch (e) {
    reportFailure(e);
  } finally {
    btn.disabled = false;
  }
});

// After the wallet redirects back with a transaction hash, restore
// the mint result from the session handoff. Without a hash the
// visitor came back without sending, so the handoff is stale.
window.meritWalletChanged = function () {
  let pending = null;
  let pendingTitle = "";
  try {
    pending = sessionStorage.getItem("merit-pending-mint");
    pendingTitle = sessionStorage.getItem("merit-pending-mint-title") || "";
  } catch (_) { /* storage unavailable */ }
  if (!pending) return;
  try {
    sessionStorage.removeItem("merit-pending-mint");
    sessionStorage.removeItem("merit-pending-mint-title");
  } catch (_) { /* storage unavailable */ }
  const params = new URLSearchParams(window.location.search);
  if (params.get("transactionHashes")) showMintResult(pending, pendingTitle);
};
