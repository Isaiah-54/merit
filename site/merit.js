// Merit detail page: stamps, level, account balance, kit, lend state,
// plus the withdraw, lend, stamp and test actions. Reads go through RPC;
// writes go through the wallet. Defaults to merit-2, with a switcher
// to every other Merit.
const params = new URLSearchParams(window.location.search);
let TOKEN_ID = params.get("id") || "";
// Whether the id came from the URL. When it did not (the bottom
// nav "Merit" link goes to merit.html with no id), the default is
// re-derived on every load from the current wallet: the connected
// wallet's own first Merit, else the demo merit-2. Without this,
// the first load picks merit-2 before the wallet restores, and the
// re-render after the restore keeps merit-2, so a signed-in user
// sees another Merit's kit thinking it is their own.
const ID_FROM_URL = Boolean(params.get("id"));
let meritData = null;
let meritTokensCache = [];
// Monotonic load sequence: a newer loadMerit call makes an older
// one stale, so a slow earlier load cannot overwrite the newer
// Merit's render after the wallet restores.
let loadSeq = 0;
// Owner of the Merit currently shown. Set when the Merit loads; the
// withdraw actions check it so a non-owner never gets a wallet prompt.
let MERIT_OWNER = null;
// The withdrawable balance as last read, so the withdraw form can
// default to it and the Max button can fill it.
let currentWithdrawable = 0n;

function meritAccountId() {
  return TOKEN_ID + "." + window.CONTRACT_ID;
}
function fmtNsDate(ns) {
  try {
    const ms = Number(BigInt(ns) / 1000000n);
    return new Date(ms).toLocaleString();
  } catch (_) { return String(ns); }
}
function dateInputToNs(dateStr) {
  const ms = new Date(dateStr + "T00:00:00Z").getTime();
  if (Number.isNaN(ms)) throw new Error("Pick a valid date.");
  return (BigInt(ms) * 1000000n).toString();
}

async function loadMerit() {
  const seq = ++loadSeq;
  const picker = el("meritPicker");
  try { meritTokensCache = await view("nft_tokens", { from_index: "0", limit: 50 }) || []; }
  catch (_) { meritTokensCache = []; }
  if (seq !== loadSeq) return;
  // No id in the URL: re-derive the default on every load from the
  // wallet as it stands now, so a restore that lands after the
  // first load moves the page to the visitor's own Merit instead
  // of leaving it stuck on the demo. An id in the URL is kept.
  if (!ID_FROM_URL) {
    if (!meritTokensCache.length) {
      el("meritTitle").textContent = "Merit";
      if (picker) picker.innerHTML = "";
      el("meritSummary").innerHTML = "<div class=\"panel\"><p style=\"margin:0\">No Merits exist yet. <a href=\"mint.html\">Mint one on the Mint page</a>.</p></div>";
      el("stampList").innerHTML = ""; el("balancePanel").innerHTML = "";
      el("kitList").innerHTML = ""; el("lendPanel").innerHTML = "";
      return;
    }
    // No token chosen in the link: open the visitor's own first
    // Merit when they are connected and own one, otherwise the demo
    // Merit, merit-2, instead of leaving them on the first token.
    const own = walletAccountId ? meritTokensCache.filter((t) => t.owner_id === walletAccountId) : [];
    const def = (own.length ? own[0] : null) || meritTokensCache.find((t) => t.token_id === "merit-2") || meritTokensCache[0];
    TOKEN_ID = def.token_id;
  }
  if (picker) {
    // The switcher is My Merits: only the Merits the connected
    // wallet owns. A visitor who has not connected sees every Merit
    // as a public showcase instead.
    const ownTokens = walletAccountId ? meritTokensCache.filter((t) => t.owner_id === walletAccountId) : meritTokensCache;
    const label = walletAccountId ? "My Merits:" : "Viewing:";
    picker.innerHTML = ownTokens.length
      ? "<div class=\"merit-switch\"><span class=\"muted small\"><strong>" + escapeHtml(label) + "</strong></span>" + ownTokens.map((t) =>
          "<a class=\"chip" + (t.token_id === TOKEN_ID ? " active" : "") + "\" href=\"merit.html?id=" + encodeURIComponent(t.token_id) + "\">" + escapeHtml(t.token_id) + "</a>").join("") + "</div>"
      : (walletAccountId
          ? "<div class=\"merit-switch\"><span class=\"muted small\"><strong>My Merits:</strong> none yet. <a href=\"mint.html\">Mint one</a>.</span></div>"
          : "");
  }
  document.getElementById("meritTitle").textContent = TOKEN_ID;
  try {
    const m = await view("get_merit", { token_id: TOKEN_ID });
    if (seq !== loadSeq) return;
    meritData = m;
    MERIT_OWNER = m.owner_id || null;
    const locked = !!m.locked;
    const level = m.level != null ? m.level : 0;
    const tok = meritTokensCache.find((t) => t.token_id === TOKEN_ID);
    const cardTitle = (tok && tok.metadata && tok.metadata.title) || TOKEN_ID;
    const stamps = m.stamps || [];
    const tier = meritTier(level);
    el("meritSummary").innerHTML =
      "<div class=\"merit-card\">" + meritRings() +
      "<div class=\"merit-card-in\">" + meritBadgeArt(TOKEN_ID, level, stamps) +
      "<div style=\"min-width:200px;flex:1\">" +
      "<div class=\"mc-label\">Merit credential \u2022 NEAR testnet</div>" +
      "<div class=\"mc-id mono\">" + escapeHtml(TOKEN_ID) + "</div>" +
      (cardTitle !== TOKEN_ID ? "<div class=\"mc-meta\">" + escapeHtml(cardTitle) + "</div>" : "") +
      "<div class=\"mc-meta\">Owner: <span class=\"mono\">" + escapeHtml(m.owner_id || "Not recorded") + "</span></div>" +
      "<div class=\"mc-meta\">Own sub-account: <span class=\"mono\">" + escapeHtml(meritAccountId()) + "</span>, where job payments land</div>" +
      "<div class=\"mc-meta\">The seal follows the level: every Merit at this level carries the same seal, whatever its skills</div>" +
      "<p style=\"margin:10px 0 0\"><span class=\"tier-chip tier-" + tier.key + "\">" + escapeHtml(tier.label) + " tier</span> &nbsp;<span class=\"chip " + (locked ? "locked" : "open") + "\">" + (locked ? "Locked, stamped, cannot be sold" : "Open, not stamped yet") + "</span></p>" +
      "</div>" +
      levelBadgeHtml(level, null, ", computed onchain from its stamps") +
      "</div></div>";
    renderNextStep(m);

    if (!stamps.length) {
      el("stampList").innerHTML = "<div class=\"panel\"><p style=\"margin:0\">No stamps yet. This Merit is blank. It cannot take a gated job until a whitelisted issuer stamps it.</p></div>";
    } else {
      el("stampList").innerHTML = "<div class=\"stamp-grid stamp-grid-large\">" + stamps.map((s) => {
        const lvl = Number(s.level) || 0;
        let pips = "";
        for (let i = 0; i < Math.min(lvl, 10); i++) pips += "<i></i>";
        return "<div class=\"stamp-badge\"><div class=\"stamp-seal " + sealClass(lvl) + "\">" + levelEmblem(lvl) + "</div>" +
          "<div class=\"sk\">" + escapeHtml(s.skill) + "</div>" +
          "<div class=\"stamp-pips pips-lv" + sealLevelNum(lvl) + "\" aria-hidden=\"true\">" + pips + "</div>" +
          "<div class=\"lv lv" + sealLevelNum(lvl) + "\">Level " + escapeHtml(String(s.level)) + "</div>" +
          "<p class=\"muted small\" style=\"margin:6px 0 0\">" +
          (s.issuer_name ? escapeHtml(s.issuer_name) : "<span class=\"mono\">" + escapeHtml(s.issuer || "") + "</span>") +
          (s.stamped_at != null ? "<br>" + escapeHtml(fmtNsDate(s.stamped_at)) : "") + "</p></div>";
      }).join("") + "</div>";
    }

    const withdrawable = BigInt(m.balance_withdrawable || "0");
    const retained = BigInt(m.balance_retained || "0");
    currentWithdrawable = withdrawable;
    let subBalText = "Not readable";
    let mintDepositText = null;
    try {
      const bal = await rpcAccountBalance(meritAccountId());
      subBalText = fmtYocto(bal) + " NEAR";
      const deposit = bal - withdrawable - retained;
      if (deposit > 0n) mintDepositText = fmtYocto(deposit);
    } catch (_) { /* leave as Not readable */ }
    if (seq !== loadSeq) return;
    // A withdraw sent in this session: show a clear confirmation
    // only when the wallet returned with a transaction hash. A
    // rejected wallet call leaves no hash, so no false confirmation.
    let confirmHtml = "";
    try {
      const conf = sessionStorage.getItem("merit-withdraw-confirm");
      if (conf) {
        sessionStorage.removeItem("merit-withdraw-confirm");
        const params2 = new URLSearchParams(window.location.search);
        if (params2.get("transactionHashes")) {
          confirmHtml = "<div class=\"success-banner\">Withdraw of " + escapeHtml(conf) + " NEAR sent to your wallet. It lands once the chain confirms it.</div>";
        }
      }
    } catch (_) { /* storage unavailable */ }
    const isOwner = Boolean(walletAccountId) && Boolean(m.owner_id) && walletAccountId === m.owner_id;
    // Default the withdraw amount to the withdrawable balance, so
    // the form never suggests 1 NEAR when there is nothing to take.
    const wInput = el("withdrawAmount");
    if (wInput && isOwner) wInput.value = fmtYocto(withdrawable);
    let panelHtml = confirmHtml +
      "<div class=\"balance-hero\"><div class=\"balance-hero-label\">Sub-account balance</div>" +
      "<div class=\"balance-hero-num\">" + escapeHtml(subBalText) + "</div>" +
      "<div class=\"balance-hero-sub\">Your Merit's own NEAR account: <span class=\"mono\">" + escapeHtml(meritAccountId()) + "</span></div></div>";
    // A fresh Merit holds only its mint deposit. Say so plainly
    // under the hero, so the 0.05 NEAR is not mistaken for job pay:
    // 0.05 NEAR of the 0.1 NEAR mint went into this sub-account as
    // its storage deposit, and the other 0.05 NEAR paid for the NFT
    // record itself.
    if (withdrawable === 0n && retained === 0n && mintDepositText) {
      panelHtml += "<p class=\"muted small\" style=\"text-align:center;margin:0 0 4px\">This 0.05 NEAR is the storage deposit from the 0.1 NEAR mint. The other 0.05 NEAR paid for the NFT record itself, so the sub-account starts at 0.05 NEAR.</p>";
    }
    if (withdrawable > 0n) {
      if (isOwner) {
        panelHtml += "<p><button type=\"button\" class=\"btn withdraw-hero-btn\" id=\"withdrawAllBtn\">Withdraw " + escapeHtml(fmtYocto(m.balance_withdrawable)) + " NEAR to your wallet</button></p>";
      } else {
        panelHtml += "<p class=\"muted small\">Only the owner of this Merit (" + escapeHtml(m.owner_id || "") + ") can withdraw. The money goes to the owner, never to anyone else.</p>";
      }
    }
    panelHtml +=
      "<div class=\"kv\"><span>Withdrawable (95% of job payments)</span><b>" + escapeHtml(fmtYocto(m.balance_withdrawable || "0")) + " NEAR</b></div>" +
      "<div class=\"kv\"><span>Retained by the Merit (5% of job payments)</span><b>" + escapeHtml(fmtYocto(m.balance_retained || "0")) + " NEAR</b></div>";
    if (mintDepositText) {
      panelHtml += "<div class=\"kv\"><span>Mint deposit</span><b>" + escapeHtml(mintDepositText) + " NEAR</b></div>";
    }
    panelHtml += "<p class=\"muted small\" style=\"margin-bottom:0\">Job payments split 95% withdrawable / 5% retained, enforced by the contract. The retained part is the Merit's working royalty: every time its stamps unlock a job, the Merit earns 5% of that job's pay and keeps it in its own account. It is the Merit's own earnings from working, not a fee taken away and not a resale cut. A stamped Merit cannot be sold, so the Merit earns by doing the work, not by changing hands. Some of the retained can be spent on kit for this Merit, 0.1 NEAR per kit, from the Buy kit section below. The mint deposit is the 0.05 NEAR that went into the sub-account when the Merit was minted; it is not part of the job split, which is why the three lines add up to the balance.</p>";
    el("balancePanel").innerHTML = panelHtml;
    const wab = el("withdrawAllBtn");
    if (wab) wab.addEventListener("click", () => withdrawAll(withdrawable, wab));
    // The withdraw form is owner-only too. Hide the whole section
    // for a viewer who is not the owner, instead of destroying it:
    // the form's submit listener is attached once at script load,
    // so replacing the section's HTML would lose it. The balance
    // panel above already names the owner for non-owners.
    const ws = el("withdrawSection");
    if (ws) ws.style.display = isOwner ? "" : "none";

    // Buy kit with retained is owner-only too, same pattern: only
    // the holder sees the section. The kit price is a fixed 0.1 NEAR
    // read from the contract, with the same value as the fallback.
    const buySection = el("buyKitSection");
    if (buySection) buySection.style.display = isOwner ? "" : "none";

    // Deposit kit, withdraw kit, lend, and the demo test are
    // owner-only too. Their forms stay hidden (display:none in the
    // HTML) until this load confirms the connected wallet is the
    // owner, so a non-owner never briefly sees them and an owner
    // never briefly loses them once the wallet restores. A
    // non-owner, or no wallet at all, sees one short read-only line
    // instead of the actions.
    const kitActions = el("kitActionsPanel");
    if (kitActions) kitActions.style.display = isOwner ? "" : "none";
    const lendActions = el("lendActionsPanel");
    if (lendActions) lendActions.style.display = isOwner ? "" : "none";
    const testFormEl = el("testForm");
    if (testFormEl) testFormEl.style.display = isOwner ? "" : "none";
    const ownerNote = el("ownerActionsNote");
    if (ownerNote) ownerNote.style.display = isOwner ? "none" : "";
    let kitPriceYocto = "100000000000000000000000";
    try {
      const kp = await view("kit_price", {});
      if (kp != null) kitPriceYocto = String(kp);
    } catch (_) { /* fixed 0.1 NEAR fallback */ }
    const buyPrice = el("buyKitPrice");
    if (buyPrice) buyPrice.textContent = fmtYocto(kitPriceYocto) + " NEAR";
    const buyRetained = el("buyKitRetained");
    if (buyRetained) buyRetained.textContent = fmtYocto(m.balance_retained || "0") + " NEAR";

    // The stamp form is issuer-only. Ask the contract whether the
    // connected wallet is a whitelisted issuer; anyone else sees a
    // short note instead of a form they cannot use. When no wallet
    // is connected, the form stays hidden too.
    const stampSection = el("stampSection");
    const stampNote = el("stampNote");
    let walletIsIssuer = false;
    if (walletAccountId) {
      try { walletIsIssuer = await view("is_issuer", { account_id: walletAccountId }); } catch (_) { walletIsIssuer = false; }
    }
    if (stampSection) stampSection.style.display = walletIsIssuer ? "" : "none";
    if (stampNote) stampNote.style.display = walletIsIssuer ? "none" : "";

    const kit = m.kit || [];
    const kitIntro = "<p class=\"muted small\" style=\"margin-top:0\">The tools " + escapeHtml(TOKEN_ID) + " carries. Each tool is a record held inside this Merit, tied to a credential the Merit holds, so the holder always has the right tool for the work its stamps unlock.</p>";
    if (kit.length === 0) {
      el("kitList").innerHTML = kitIntro + "<p class=\"muted\">No kit inside " + escapeHtml(TOKEN_ID) + " yet. Deposit a tool below and it shows here by name.</p>";
    } else {
      const items = [];
      for (const kitId of kit) {
        let name = kitId;
        try {
          const k = await view("get_kit", { kit_token_id: kitId });
          if (k && k.name) name = k.name;
        } catch (_) { /* show the id when the kit read fails */ }
        items.push("<div class=\"card\"><div class=\"label\">Tool inside this Merit</div><p><strong>" + escapeHtml(name) + "</strong></p><p class=\"muted small\">" + escapeHtml(kitId) + " · held inside this Merit</p></div>");
      }
      if (seq !== loadSeq) return;
      el("kitList").innerHTML = kitIntro + "<div class=\"grid\">" + items.join("") + "</div>" +
        "<p class=\"muted small\">The job gate is the stamp, not the kit. A tool shows what the credential certifies the holder to use; removing a tool takes it out of the Merit but does not close a job the stamps already unlock.</p>";
    }

    const lend = m.lend || null;
    if (lend) {
      el("lendPanel").innerHTML = "<p>Lent to <strong>" + escapeHtml(lend.to) + "</strong> until <strong>" + escapeHtml(fmtNsDate(lend.expires_at)) + "</strong>.</p>";
    } else {
      el("lendPanel").innerHTML = "<p class=\"muted\">Not lent to anyone right now.</p>";
    }
  } catch (e) {
    el("meritSummary").innerHTML = "<p class=\"muted\">Could not load this Merit. " + escapeHtml(e.message || String(e)) + "</p>";
    el("stampList").innerHTML = "";
    el("balancePanel").innerHTML = "";
    el("kitList").innerHTML = "";
    el("lendPanel").innerHTML = "";
  }
  // A link from the Mint page lands here with #testSection so the
  // new holder goes straight to step two. Scroll again once the
  // page has rendered, since the async load shifts the layout.
  if (window.location.hash === "#testSection") {
    const sec = el("testSection");
    if (sec) { try { sec.scrollIntoView(); } catch (_) {} }
  }
}

// One primary next step, chosen from the Merit's own state:
// withdrawable balance first, then a blank Merit, then a stamped
// Merit that can take a job. Only one CTA, the right one.
// The withdraw step is owner-only: a viewer who is not the owner
// never sees a Withdraw button, because only the owner can withdraw.
function renderNextStep(m) {
  const wrap = el("nextStep");
  if (!wrap) return;
  const stamps = Array.isArray(m.stamps) ? m.stamps : [];
  const withdrawable = BigInt(m.balance_withdrawable || "0");
  const isOwner = Boolean(walletAccountId) && Boolean(m.owner_id) && walletAccountId === m.owner_id;
  let num = "1";
  let label = "Next step";
  let text = "";
  let action = "";
  if (withdrawable > 0n && isOwner) {
    num = "6";
    label = "Next step: withdraw";
    text = "Your Merit earned " + fmtYocto(m.balance_withdrawable) + " NEAR. Withdraw it to your wallet.";
    action = "<button type=\"button\" class=\"btn\" id=\"nextStepBtn\">Withdraw " + escapeHtml(fmtYocto(m.balance_withdrawable)) + " NEAR</button>";
  } else if (stamps.length === 0 && isOwner) {
    num = "2";
    label = "Next step: pass the demo test";
    text = "This Merit is blank. Pass the demo test to earn your first stamp and open gated jobs.";
    action = "<button type=\"button\" class=\"btn\" id=\"nextStepBtn\">Pass the demo test to earn your first stamp</button>";
  } else if (stamps.length === 0) {
    // A blank Merit viewed by someone who is not its owner: the
    // demo test is holder-only, so there is no action to offer here.
    num = "2";
    label = "Next step: pass the demo test";
    text = "This Merit is blank. Only its owner can pass the demo test to earn the first stamp.";
    action = "";
  } else {
    num = "4";
    label = "Next step: take a job";
    text = "Your stamps open gated jobs. Take one your Merit unlocks and get paid for the work.";
    action = "<a class=\"btn\" id=\"nextStepBtn\" href=\"jobs-offers.html\">Take a job your stamps unlock</a>";
  }
  wrap.innerHTML = "<div class=\"next-step\"><div class=\"next-step-card\">" +
    "<span class=\"next-step-num\" aria-hidden=\"true\">" + num + "</span>" +
    "<div class=\"next-step-body\"><div class=\"next-step-label\">" + escapeHtml(label) + "</div>" +
    "<p class=\"next-step-text\">" + escapeHtml(text) + "</p></div>" +
    action + "</div></div>";
  const btn = el("nextStepBtn");
  if (!btn) return;
  if (withdrawable > 0n && isOwner) {
    btn.addEventListener("click", () => withdrawAll(withdrawable, btn));
  } else if (stamps.length === 0 && isOwner) {
    btn.addEventListener("click", () => {
      const sec = el("testSection");
      if (sec) sec.scrollIntoView({ behavior: "smooth", block: "start" });
      const ans = el("testAnswer");
      if (ans) { try { ans.focus(); } catch (_) {} }
    });
  }
}

// Withdraw the whole withdrawable balance in one tap. The
// confirmation is recorded before the wallet call so it survives
// the wallet redirect, and shown only when the wallet returns with
// a transaction hash. Owner-only: the contract rejects any other
// caller, and this check stops it before a wallet prompt.
async function withdrawAll(amount, btn) {
  if (!needWallet()) return;
  if (MERIT_OWNER && walletAccountId !== MERIT_OWNER) { pageStatus("Only the owner of this Merit can withdraw."); return; }
  try { sessionStorage.setItem("merit-withdraw-confirm", fmtYocto(amount)); } catch (_) { /* storage unavailable */ }
  await sendWithPending(btn, "Sending withdraw. Confirm in your wallet.",
    "withdraw", { token_id: TOKEN_ID, amount: amount.toString() }, "0", undefined, undefined, "The NEAR is in your wallet once the chain confirms it.");
}

function needWallet() {
  if (!walletAccountId) { pageStatus("Connect your wallet first."); return false; }
  return true;
}
async function sendWithPending(btn, statusText, method, args, depositYocto, gas, statusEl, nextStep) {
  btn.disabled = true;
  const local = statusEl ? el(statusEl) : null;
  const showStatus = (msg) => { if (local) local.textContent = msg; pageStatus(msg); };
  showStatus(statusText);
  try {
    const res = await walletCall(contractId(), method, args, depositYocto || "0", gas);
    const hash = txHashFromWalletResult(res);
    const msg = "Sent. It will show here once the chain confirms it.";
    if (local) local.innerHTML = txStatusHtml(msg, hash, nextStep);
    setTxStatus(msg, hash, nextStep);
    await loadMerit();
    return true;
  } catch (e) {
    reportFailure(e);
    return false;
  } finally {
    btn.disabled = false;
  }
}

document.getElementById("withdrawForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!needWallet()) return;
  if (MERIT_OWNER && walletAccountId !== MERIT_OWNER) { pageStatus("Only the owner of this Merit can withdraw."); return; }
  let amount;
  try { amount = nearToYocto(el("withdrawAmount").value); } catch (e) { pageStatus(e.message); return; }
  if (amount <= 0n) { pageStatus("Enter an amount above zero."); return; }
  try { sessionStorage.setItem("merit-withdraw-confirm", fmtYocto(amount)); } catch (_) { /* storage unavailable */ }
  await sendWithPending(el("withdrawBtn"), "Sending withdraw. Confirm in your wallet.",
    "withdraw", { token_id: TOKEN_ID, amount: amount.toString() }, "0", undefined, undefined, "The NEAR is in your wallet once the chain confirms it.");
});

// Max fills the withdraw amount with the whole withdrawable balance.
document.getElementById("withdrawMaxBtn").addEventListener("click", () => {
  const input = el("withdrawAmount");
  if (input) input.value = fmtYocto(currentWithdrawable);
});

document.getElementById("depositKitForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!needWallet()) return;
  const kitId = el("depositKitId").value.trim();
  if (!kitId) { pageStatus("Enter a kit token id."); return; }
  await sendWithPending(el("depositKitBtn"), "Sending kit deposit. Confirm in your wallet.",
    "deposit_kit", { token_id: TOKEN_ID, kit_token_id: kitId }, "0", undefined, undefined, "The tool shows in the kit list once the chain confirms it.");
});

// Buy kit with retained: holder only, spends 0.1 NEAR of the Merit's
// retained balance on a kit, no deposit attached. The Merit reloads
// on success, so the new kit and the reduced retained balance show.
document.getElementById("buyKitForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!needWallet()) return;
  if (MERIT_OWNER && walletAccountId !== MERIT_OWNER) { pageStatus("Only the owner of this Merit can buy kit with its retained balance."); return; }
  const kitId = el("buyKitId").value.trim();
  if (!kitId) { pageStatus("Enter a kit id."); return; }
  await sendWithPending(el("buyKitBtn"), "Sending buy kit. Confirm in your wallet.",
    "buy_kit", { token_id: TOKEN_ID, kit_token_id: kitId }, "0", undefined, "buyKitStatus", "The kit shows in the kit list and the retained balance drops once the chain confirms it.");
});

document.getElementById("withdrawKitForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!needWallet()) return;
  const kitId = el("withdrawKitId").value.trim();
  if (!kitId) { pageStatus("Enter a kit token id."); return; }
  await sendWithPending(el("withdrawKitBtn"), "Sending kit withdraw. Confirm in your wallet.",
    "withdraw_kit", { token_id: TOKEN_ID, kit_token_id: kitId }, "0", undefined, undefined, "The tool leaves this Merit once the chain confirms it.");
});

document.getElementById("lendForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!needWallet()) return;
  const to = el("lendTo").value.trim();
  const until = el("lendUntil").value;
  if (!to) { pageStatus("Enter the account to lend to."); return; }
  let expiresAt;
  try { expiresAt = dateInputToNs(until); } catch (e) { pageStatus(e.message); return; }
  await sendWithPending(el("lendBtn"), "Sending lend. Confirm in your wallet.",
    "lend", { token_id: TOKEN_ID, to: to, expires_at: expiresAt }, "0", undefined, undefined, "The borrower can use this Merit until the expiry date.");
});

document.getElementById("revokeBtn").addEventListener("click", async () => {
  if (!needWallet()) return;
  await sendWithPending(el("revokeBtn"), "Sending revoke. Confirm in your wallet.",
    "revoke_lend", { token_id: TOKEN_ID }, "0", undefined, undefined, "The lend is revoked once the chain confirms it.");
});

document.getElementById("stampForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!needWallet()) return;
  const skill = el("stampSkill").value.trim();
  const level = parseInt(el("stampLevel").value, 10);
  if (!skill) { pageStatus("Enter a skill."); return; }
  if (!Number.isInteger(level) || level < 1) { pageStatus("Level must be 1 or more."); return; }
  await sendWithPending(el("stampBtn"), "Sending stamp. Confirm in your wallet.",
    "stamp", { token_id: TOKEN_ID, skill: skill, level: level }, "0", undefined, undefined, "The stamp shows on this Merit and it locks once the chain confirms it.");
});

document.getElementById("testForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!needWallet()) return;
  const answer = el("testAnswer").value.trim();
  if (!answer) { pageStatus("Enter an answer."); return; }
  const ok = await sendWithPending(el("testBtn"), "Sending answer. Confirm in your wallet.",
    "pass_test", { token_id: TOKEN_ID, answer: answer }, "0", undefined, "testStatus", "The merit-basics stamp shows on this Merit once the chain confirms it, and gated jobs open.");
  // After the test confirms, the Merit reloads with its new stamp.
  // Take the visitor up to the Merit card so they see it, instead
  // of leaving them at the test form with nothing visibly changed.
  if (ok) {
    const summary = el("meritSummary");
    if (summary) { try { summary.scrollIntoView({ behavior: "smooth", block: "start" }); } catch (_) { /* scroll unavailable */ } }
  }
});

window.meritWalletChanged = function () { loadMerit(); };
loadMerit();
