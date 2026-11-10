// Merit home page: mint a blank Merit and list all Merits with level
// and lock state. Reads go through RPC; writes go through the wallet.
async function loadMerits() {
  const list = el("meritList");
  try {
    const tokens = await view("nft_tokens", { from_index: "0", limit: 20 });
    if (!tokens || tokens.length === 0) {
      list.innerHTML = "<div class=\"panel\"><p>No Merits exist yet.</p><p><a class=\"btn\" href=\"mint.html\">Mint the first one</a></p></div>";
      return;
    }
    const rows = [];
    for (const t of tokens) {
      const tokenId = t.token_id;
      let level = 0;
      let levelText = "Not recorded";
      let locked = "Not recorded";
      let owner = t.owner_id || "";
      let stamps = [];
      try {
        const m = await view("get_merit", { token_id: tokenId });
        level = m.level != null ? Number(m.level) : 0;
        levelText = m.level != null ? String(m.level) : "unknown";
        locked = m.locked ? "Locked" : "Open";
        if (m.owner_id) owner = m.owner_id;
        stamps = Array.isArray(m.stamps) ? m.stamps : [];
      } catch (_) { /* get_merit may fail for a plain NFT; show the token anyway */ }
      const title = (t.metadata && t.metadata.title) || tokenId;
      const tier = meritTier(level);
      rows.push("<div class=\"merit-list-visual\">" + meritRings() +
        meritBadgeArt(tokenId, level, stamps) +
        "<div class=\"list-visual-meta\">" +
        "<div class=\"list-visual-id\"><a href=\"merit.html?id=" + encodeURIComponent(tokenId) + "\" style=\"color:inherit;text-decoration:none\">" + escapeHtml(tokenId) + "</a></div>" +
        (title !== tokenId ? "<div class=\"list-visual-sub\">" + escapeHtml(title) + "</div>" : "") +
        "<div class=\"list-visual-sub\">Owner: <span class=\"mono\">" + escapeHtml(owner) + "</span></div>" +
        "<div class=\"list-visual-sub\">" + escapeHtml(tier.label) + " tier \u2022 " + stamps.length + (stamps.length === 1 ? " stamp" : " stamps") + " \u2022 " + escapeHtml(locked) + "</div>" +
        "<p style=\"margin:8px 0 0\"><a class=\"btn secondary\" href=\"merit.html?id=" + encodeURIComponent(tokenId) + "\">Open Merit</a></p>" +
        "</div>" +
        levelBadgeHtml(level, stamps, "") +
        "</div>");
    }
    list.innerHTML = rows.join("");
  } catch (e) {
    list.innerHTML = "<p class=\"muted\">Could not load Merits. " + escapeHtml(e.message || String(e)) + "</p>";
  }
}

// Build the exact mint call the form sends. Kept separate so the
// headless verifier can check the call without a real wallet.
function buildMintCall(tokenId, title, receiverId) {
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

async function onMint(ev) {
  ev.preventDefault();
  const btn = el("mintBtn");
  if (!walletAccountId) { pageStatus("Connect your wallet first."); return; }
  const tokenId = el("tokenId").value.trim();
  const bad = validateTokenId(tokenId);
  if (bad) { pageStatus(bad); return; }
  const title = el("meritTitle").value.trim();
  const call = buildMintCall(tokenId, title, walletAccountId);
  btn.disabled = true;
  pageStatus("Sending transaction. Confirm in your wallet.");
  try {
    const res = await walletCall(contractId(), call.method, call.args, call.depositYocto, call.gas);
    const hash = txHashFromWalletResult(res);
    setTxStatus("Mint sent. It will appear here once the chain confirms it.", hash, "Pass the demo test to earn your first stamp and open gated jobs.");
    await loadMerits();
  } catch (e) {
    reportFailure(e);
  } finally {
    btn.disabled = false;
  }
}

document.getElementById("mintForm").addEventListener("submit", onMint);
window.meritWalletChanged = function () { /* list does not depend on the wallet */ };
loadMerits();
