// Merit detail page: stamps, level, account balance, kit, lend state,
// plus the withdraw, lend, stamp and test actions. Reads go through RPC;
// writes go through the wallet. Defaults to merit-2, with a switcher
// to every other Merit.
const params = new URLSearchParams(window.location.search);
let TOKEN_ID = params.get("id") || "";
let meritData = null;
let meritTokensCache = [];

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
  const picker = el("meritPicker");
  try { meritTokensCache = await view("nft_tokens", { from_index: "0", limit: 50 }) || []; }
  catch (_) { meritTokensCache = []; }
  if (!TOKEN_ID) {
    if (!meritTokensCache.length) {
      el("meritTitle").textContent = "Merit";
      if (picker) picker.innerHTML = "";
      el("meritSummary").innerHTML = "<div class=\"panel\"><p style=\"margin:0\">No Merits exist yet. <a href=\"mint.html\">Mint one on the Mint page</a>.</p></div>";
      el("stampList").innerHTML = ""; el("balancePanel").innerHTML = "";
      el("kitList").innerHTML = ""; el("lendPanel").innerHTML = "";
      return;
    }
    // No token chosen in the link: open the demo Merit, merit-2, by
    // default instead of leaving the visitor on the first token.
    const def = meritTokensCache.find((t) => t.token_id === "merit-2") || meritTokensCache[0];
    TOKEN_ID = def.token_id;
  }
  if (picker) {
    picker.innerHTML = meritTokensCache.length
      ? "<div class=\"merit-switch\"><span class=\"muted small\"><strong>Viewing:</strong></span>" + meritTokensCache.map((t) =>
          "<a class=\"chip" + (t.token_id === TOKEN_ID ? " active" : "") + "\" href=\"merit.html?id=" + encodeURIComponent(t.token_id) + "\">" + escapeHtml(t.token_id) + "</a>").join("") + "</div>"
      : "";
  }
  document.getElementById("meritTitle").textContent = TOKEN_ID;
  try {
    const m = await view("get_merit", { token_id: TOKEN_ID });
    meritData = m;
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
      "<div class=\"mc-meta\">Owner <span class=\"mono\">" + escapeHtml(m.owner_id || "Not recorded") + "</span></div>" +
      "<div class=\"mc-meta\">Own sub-account <span class=\"mono\">" + escapeHtml(meritAccountId()) + "</span>, where job payments land</div>" +
      "<div class=\"mc-meta\">" + escapeHtml(tier.label) + " tier \u2022 " + stamps.length + (stamps.length === 1 ? " stamp" : " stamps") + " earned. The seal follows the level: every Merit at this level carries the same seal, whatever its skills</div>" +
      "<p style=\"margin:10px 0 0\"><span class=\"tier-chip tier-" + tier.key + "\">" + escapeHtml(tier.label) + " tier</span> &nbsp;<span class=\"chip " + (locked ? "locked" : "open") + "\">" + (locked ? "Locked, stamped, cannot be sold" : "Open, not stamped yet") + "</span></p>" +
      "</div>" +
      levelBadgeHtml(level, stamps, ", computed onchain from its stamps") +
      "</div></div>";

    if (!stamps.length) {
      el("stampList").innerHTML = "<div class=\"panel\"><p style=\"margin:0\">No stamps yet. This Merit is blank. It cannot take a gated job until a whitelisted issuer stamps it.</p></div>";
    } else {
      el("stampList").innerHTML = "<div class=\"stamp-grid\">" + stamps.map((s) => {
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

    el("balancePanel").innerHTML =
      "<div class=\"kv\"><span>Sub-account balance</span><b id=\"subBal\">\u2026</b></div>" +
      "<div class=\"kv\"><span>Withdrawable (95%)</span><b>" + escapeHtml(fmtYocto(m.balance_withdrawable || "0")) + " NEAR</b></div>" +
      "<div class=\"kv\"><span>Retained by the Merit (5%)</span><b>" + escapeHtml(fmtYocto(m.balance_retained || "0")) + " NEAR</b></div>" +
      "<p class=\"muted small\" style=\"margin-bottom:0\">Job payments split 95% withdrawable / 5% retained, enforced by the contract. The retained part stays in the Merit's own account.</p>";
    try {
      const bal = await rpcAccountBalance(meritAccountId());
      const b = el("subBal");
      if (b) b.textContent = fmtYocto(bal) + " NEAR";
    } catch (_) {
      const b = el("subBal");
      if (b) b.textContent = "Not readable";
    }

    const kit = m.kit || [];
    if (kit.length === 0) {
      el("kitList").innerHTML = "<p class=\"muted\">No kit inside this Merit yet.</p>";
    } else {
      const items = [];
      for (const kitId of kit) {
        let name = kitId;
        try {
          const k = await view("get_kit", { kit_token_id: kitId });
          if (k && k.name) name = k.name;
        } catch (_) { /* show the id when the kit read fails */ }
        items.push("<div class=\"card\"><div class=\"label\">Kit</div><p><strong>" + escapeHtml(name) + "</strong></p><p class=\"muted small\">" + escapeHtml(kitId) + "</p></div>");
      }
      el("kitList").innerHTML = "<div class=\"grid\">" + items.join("") + "</div>";
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
}

function needWallet() {
  if (!walletAccountId) { pageStatus("Connect your wallet first."); return false; }
  return true;
}
async function sendWithPending(btn, statusText, method, args, depositYocto, gas) {
  btn.disabled = true;
  pageStatus(statusText);
  try {
    await walletCall(contractId(), method, args, depositYocto || "0", gas);
    pageStatus("Sent. It will show here once the chain confirms it.");
    await loadMerit();
  } catch (e) {
    reportFailure(e);
  } finally {
    btn.disabled = false;
  }
}

document.getElementById("withdrawForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!needWallet()) return;
  let amount;
  try { amount = nearToYocto(el("withdrawAmount").value); } catch (e) { pageStatus(e.message); return; }
  if (amount <= 0n) { pageStatus("Enter an amount above zero."); return; }
  await sendWithPending(el("withdrawBtn"), "Sending withdraw. Confirm in your wallet.",
    "withdraw", { token_id: TOKEN_ID, amount: amount.toString() }, "0");
});

document.getElementById("depositKitForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!needWallet()) return;
  const kitId = el("depositKitId").value.trim();
  if (!kitId) { pageStatus("Enter a kit token id."); return; }
  await sendWithPending(el("depositKitBtn"), "Sending kit deposit. Confirm in your wallet.",
    "deposit_kit", { token_id: TOKEN_ID, kit_token_id: kitId }, "0");
});

document.getElementById("withdrawKitForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!needWallet()) return;
  const kitId = el("withdrawKitId").value.trim();
  if (!kitId) { pageStatus("Enter a kit token id."); return; }
  await sendWithPending(el("withdrawKitBtn"), "Sending kit withdraw. Confirm in your wallet.",
    "withdraw_kit", { token_id: TOKEN_ID, kit_token_id: kitId }, "0");
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
    "lend", { token_id: TOKEN_ID, to: to, expires_at: expiresAt }, "0");
});

document.getElementById("revokeBtn").addEventListener("click", async () => {
  if (!needWallet()) return;
  await sendWithPending(el("revokeBtn"), "Sending revoke. Confirm in your wallet.",
    "revoke_lend", { token_id: TOKEN_ID }, "0");
});

document.getElementById("stampForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!needWallet()) return;
  const skill = el("stampSkill").value.trim();
  const level = parseInt(el("stampLevel").value, 10);
  if (!skill) { pageStatus("Enter a skill."); return; }
  if (!Number.isInteger(level) || level < 1) { pageStatus("Level must be 1 or more."); return; }
  await sendWithPending(el("stampBtn"), "Sending stamp. Confirm in your wallet.",
    "stamp", { token_id: TOKEN_ID, skill: skill, level: level }, "0");
});

document.getElementById("testForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!needWallet()) return;
  const answer = el("testAnswer").value.trim();
  if (!answer) { pageStatus("Enter an answer."); return; }
  await sendWithPending(el("testBtn"), "Sending answer. Confirm in your wallet.",
    "pass_test", { token_id: TOKEN_ID, answer: answer }, "0");
});

window.meritWalletChanged = function () { /* detail does not depend on the wallet */ };
loadMerit();
