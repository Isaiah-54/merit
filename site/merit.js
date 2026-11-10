// Merit detail page: stamps, level, account balance, kit, lend state,
// plus the withdraw, lend, stamp and test actions. Reads go through RPC;
// writes go through the wallet.
const params = new URLSearchParams(window.location.search);
const TOKEN_ID = params.get("id") || "";
let meritData = null;

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
  if (!TOKEN_ID) {
    el("meritSummary").innerHTML = "<p class=\"muted\">No Merit id in the link. Go back to the list and pick one.</p>";
    return;
  }
  document.getElementById("meritTitle").textContent = TOKEN_ID;
  try {
    const m = await view("get_merit", { token_id: TOKEN_ID });
    meritData = m;
    const locked = m.locked ? "Locked" : "Open";
    el("meritSummary").innerHTML =
      "<div class=\"grid\">" +
      "<div class=\"card tone-blue\"><div class=\"label\">Owner</div><p>" + escapeHtml(m.owner_id || "Not recorded yet") + "</p></div>" +
      "<div class=\"card tone-green\"><div class=\"label\">Level</div><div class=\"big\">" + escapeHtml(String(m.level != null ? m.level : 0)) + "</div></div>" +
      "<div class=\"card tone-amber\"><div class=\"label\">State</div><p>" + escapeHtml(locked) + "</p>" +
      "<p class=\"muted small\">" + (m.locked ? "Stamped, so it cannot be sold. It can still be lent." : "Not stamped yet, so it can still be sold.") + "</p></div>" +
      "<div class=\"card tone-purple\"><div class=\"label\">Own account</div><p>" + escapeHtml(meritAccountId()) + "</p></div>" +
      "</div>";

    const stamps = m.stamps || [];
    if (stamps.length === 0) {
      el("stampList").innerHTML = "<p class=\"muted\">No stamps yet. This Merit is blank.</p>";
    } else {
      const rows = stamps.map((s) => {
        const name = s.issuer_name ? "<strong>" + escapeHtml(s.issuer_name) + "</strong><br><span class=\"muted small\">" + escapeHtml(s.issuer || "") + "</span>" : escapeHtml(s.issuer || "");
        return "<tr><td>" + escapeHtml(s.skill) + "</td><td>" + escapeHtml(String(s.level)) + "</td><td>" + name + "</td><td>" + escapeHtml(s.stamped_at != null ? fmtNsDate(s.stamped_at) : "") + "</td></tr>";
      }).join("");
      el("stampList").innerHTML = "<div class=\"tableScroll\"><table><thead><tr><th>Skill</th><th>Level</th><th>Issuer</th><th>Stamped</th></tr></thead><tbody>" + rows + "</tbody></table></div>";
    }

    el("balancePanel").innerHTML =
      "<p>Withdrawable: <strong>" + escapeHtml(fmtYocto(m.balance_withdrawable || "0")) + " NEAR</strong></p>" +
      "<p>Retained: <strong>" + escapeHtml(fmtYocto(m.balance_retained || "0")) + " NEAR</strong></p>" +
      "<p class=\"muted small\">The Merit keeps 5 percent of every job it unlocks. The retained part stays in its own account.</p>";

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
