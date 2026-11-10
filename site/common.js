// Shared helpers for the Merit site. Same patterns as OwnGround:
// the @fastnear/wallet 2.5.0 bundle for signing, RPC fallback for reads,
// the one button wallet toggle. Testnet only.
const YOCTO_PER_NEAR = 10n ** 24n;
const RPC_TIMEOUT_MS = 10000;

function el(id) { return document.getElementById(id); }
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
// Merit token id allowlist: lowercase letters, digits, dots and
// underscores only, 1-64 chars, starting with a letter or digit.
// No spaces: a space is the most common mistake, so it gets its own
// message naming the fix.
function validateTokenId(id) {
  const s = String(id || "");
  if (!s) return "The token id is empty.";
  if (s.length > 64) return "The token id must be 64 characters or fewer.";
  if (s.includes(" ")) return "The token id cannot contain spaces. Use lowercase letters, digits, dots and underscores only, for example ai-agent instead of ai agent.";
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(s)) {
    return "The token id can only use lowercase letters, digits, dots and underscores, with no spaces, and must start with a letter or digit.";
  }
  return "";
}
function fmtYocto(yocto) {
  const y = BigInt(yocto);
  const whole = y / YOCTO_PER_NEAR;
  const frac = Number((y % YOCTO_PER_NEAR) * 1000n / YOCTO_PER_NEAR);
  return whole.toString() + "." + String(frac).padStart(3, "0");
}
function nearToYocto(s) {
  const parts = String(s).trim().split(".");
  const whole = parts[0] || "0";
  const frac = (parts[1] || "").padEnd(24, "0").slice(0, 24);
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(frac)) throw new Error("Enter an amount in NEAR, digits only.");
  return BigInt(whole) * YOCTO_PER_NEAR + BigInt(frac || "0");
}
function pageStatus(msg) {
  const s = el("pageStatus");
  if (s) s.textContent = msg;
}
// Turn an evidence reference into a fetchable URL. A plain web link
// or data link is used as posted; an IPFS CID or ipfs link opens
// through a public gateway. Anything else is returned as posted.
function evidenceRefUrl(ref) {
  const r = String(ref || "").trim();
  if (/^https?:\/\//i.test(r) || r.indexOf("data:") === 0) return r;
  if (r.indexOf("ipfs://") === 0) return "https://ipfs.io/ipfs/" + r.slice(7);
  if (/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[a-z0-9]{50,})$/.test(r)) return "https://ipfs.io/ipfs/" + r;
  return r;
}
// SHA-256 of a byte buffer, as lowercase hex, for checking fetched
// evidence against the hash recorded onchain.
async function sha256Hex(buf) {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
// Fetch the content an evidence reference points to, as text.
// Works for data: links and for web links that allow fetching.
// Returns { ok: true, text } or { ok: false, reason }.
async function fetchEvidenceText(ref) {
  if (!ref) return { ok: false, reason: "No reference was posted." };
  let res;
  try {
    res = await fetch(evidenceRefUrl(ref));
  } catch (_) {
    return { ok: false, reason: "The referenced content could not be fetched." };
  }
  if (!res || !res.ok) return { ok: false, reason: "The referenced content could not be fetched." };
  try {
    return { ok: true, text: await res.text() };
  } catch (_) {
    return { ok: false, reason: "The referenced content could not be read." };
  }
}
// Show fetched evidence content inline in a container element,
// instead of navigating away to the raw reference. A raw data: link
// opens a blank tab on some phones, so the content is read here and
// shown on the page. On fetch failure (a web link blocked by the
// host), the reference is offered as an external link instead.
async function showEvidenceContent(container, ref) {
  if (!container) return;
  container.textContent = "Loading evidence…";
  const r = await fetchEvidenceText(ref);
  if (r.ok) {
    const pre = document.createElement("pre");
    pre.className = "evidence-text";
    pre.textContent = r.text;
    container.innerHTML = "";
    container.appendChild(pre);
    return;
  }
  container.innerHTML = "";
  const span = document.createElement("span");
  span.className = "muted small";
  span.textContent = r.reason + " ";
  const a = document.createElement("a");
  a.href = evidenceRefUrl(ref);
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = "Open the reference";
  container.appendChild(span);
  container.appendChild(a);
}
// Show a classified failure, never a bare "transaction failed".
function reportFailure(err) {
  let r = null;
  try {
    if (typeof classifyFailure === "function") r = classifyFailure(err);
  } catch (_) { /* classifier unavailable */ }
  if (!r) {
    const m = err && err.message ? err.message : String(err);
    r = { category: "contract", text: "Rejected. " + m.slice(0, 200) + " No money moved." };
  }
  pageStatus(r.text);
  return r;
}
function nearLink(txHash) {
  return "https://testnet.nearblocks.io/txns/" + txHash;
}

// Confirm a transaction onchain before claiming success. Returns
// "confirmed", "failed", or "unknown" (not yet visible onchain).
async function checkTxStatus(txHash, accountId) {
  for (const url of window.RPC_ENDPOINTS) {
    try {
      const res = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: "tx", method: "tx",
          params: [txHash, accountId],
        }),
      });
      const data = await res.json();
      if (data.error) return "unknown";
      const status = data.result && data.result.status;
      if (!status) return "unknown";
      if (status.SuccessValue !== undefined || status.SuccessReceiptId !== undefined) return "confirmed";
      if (status.Failure !== undefined) return "failed";
      return "unknown";
    } catch (e) { /* try the next endpoint */ }
  }
  return "unknown";
}

async function fetchWithTimeout(url, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
  try {
    return await fetch(url, { ...(opts || {}), signal: ctrl.signal });
  } finally { clearTimeout(timer); }
}

// Race every RPC endpoint and take the first success. A failed endpoint
// only loses the race; all failing still throws.
async function rpcViewCall(accountId, method, args) {
  const attempts = window.RPC_ENDPOINTS.map(async (url) => {
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: method, method: "query",
        params: {
          request_type: "call_function",
          account_id: accountId,
          method_name: method,
          args_base64: btoa(JSON.stringify(args || {})),
          finality: "final",
        },
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || "RPC error");
    const bytes = data.result && data.result.result;
    if (!bytes) throw new Error("Empty RPC result");
    return JSON.parse(new TextDecoder().decode(new Uint8Array(bytes)));
  });
  return Promise.any(attempts).catch((e) => {
    const first = e && e.errors && e.errors[0];
    throw first || e;
  });
}

async function rpcAccountBalance(accountId) {
  for (const url of window.RPC_ENDPOINTS) {
    try {
      const res = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: "balance", method: "query",
          params: { request_type: "view_account", account_id: accountId, finality: "final" },
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || "RPC error");
      return BigInt(data.result.amount);
    } catch (e) { /* try next endpoint */ }
  }
  throw new Error("Could not read account balance");
}

// ---- Wallet connect (FastNEAR wallet 2.5.0) ----
let walletAccountId = null;
function fastnear() {
  if (typeof window.nearWallet === "undefined") {
    throw new Error("FastNear wallet library not loaded. Check the script tag.");
  }
  return window.nearWallet;
}
function currentAccountId(nw) {
  try {
    const id = nw.accountId({ network: window.NETWORK });
    return typeof id === "string" && id ? id : null;
  } catch (_) {
    return null;
  }
}
function walletChanged() {
  if (typeof window.meritWalletChanged === "function") {
    window.meritWalletChanged();
  }
}
async function initWallet() {
  if (typeof window === "undefined") return;
  let skipRestore = false;
  try { skipRestore = localStorage.getItem("merit-wallet-disconnected") === "1" || sessionStorage.getItem("merit-wallet-disconnected") === "1"; } catch (_) { /* storage unavailable */ }
  if (!skipRestore) {
    try {
      const nw = fastnear();
      const restored = await nw.restore({ network: window.NETWORK });
      const id = (restored && typeof restored.accountId === "string" && restored.accountId) || currentAccountId(nw);
      if (id) walletAccountId = id;
    } catch (e) { console.warn("wallet restore failed", e); }
  }
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("transactionHashes")) {
      const hashes = params.get("transactionHashes").split(",");
      // Never show success before the chain confirms it: check the
      // receipt status first, and say so honestly if it is not visible.
      const account = walletAccountId;
      let state = "unknown";
      if (account) {
        for (let attempt = 0; attempt < 3 && state === "unknown"; attempt++) {
          state = await checkTxStatus(hashes[0], account);
          if (state === "unknown" && attempt < 2) await new Promise((r) => setTimeout(r, 1500));
        }
      }
      if (state === "confirmed") {
        const s = el("pageStatus");
        if (s) {
          s.innerHTML = "Transaction <a href=\"" + escapeHtml(nearLink(hashes[0])) + "\" target=\"_blank\" rel=\"noopener\">" +
            escapeHtml(hashes[0]) + "</a> is confirmed onchain.";
        }
      } else if (state === "failed") {
        reportFailure("Smart contract panicked: the transaction failed onchain");
      } else {
        const s = el("pageStatus");
        if (s) {
          s.innerHTML = "Transaction <a href=\"" + escapeHtml(nearLink(hashes[0])) + "\" target=\"_blank\" rel=\"noopener\">" +
            escapeHtml(hashes[0]) + "</a> was sent. Confirmation not verified yet. Check it on Nearblocks.";
        }
      }
      window.history.replaceState({}, "", window.location.pathname + window.location.search + window.location.hash);
    }
  } catch (_) { /* ignore */ }
  refreshWalletBtn();
  walletChanged();
}
function refreshWalletBtn() {
  const btn = el("connectBtn");
  if (!btn) return;
  let libOk = true;
  try { fastnear(); } catch (_) { libOk = false; }
  if (!libOk) { btn.textContent = "Wallet unavailable"; btn.disabled = true; return; }
  const id = walletAccountId;
  btn.textContent = id ? id + " (sign out)" : "Connect wallet";
  if (btn.title !== undefined) btn.title = id ? "Tap to sign out" : "";
  btn.disabled = false;
}
async function disconnectWallet() {
  try { localStorage.setItem("merit-wallet-disconnected", "1"); } catch (_) { /* storage unavailable */ }
  try { sessionStorage.setItem("merit-wallet-disconnected", "1"); } catch (_) { /* storage unavailable */ }
  try {
    const nw = fastnear();
    try { await nw.disconnect({ network: window.NETWORK }); } catch (_) { /* wallet already signed out */ }
    try {
      const drop = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.indexOf("selected-wallet") >= 0 || k.indexOf("signedAccountId") >= 0 || k.indexOf("near-wallet") >= 0 || k.indexOf("fastnear") >= 0)) drop.push(k);
      }
      drop.forEach((k) => { try { localStorage.removeItem(k); } catch (_) {} });
    } catch (_) { /* storage unavailable */ }
    pageStatus("Signed out.");
  } catch (_) { /* library missing, clear local state anyway */ }
  walletAccountId = null;
  refreshWalletBtn();
  walletChanged();
}
async function toggleWallet() {
  let nw;
  try { nw = fastnear(); } catch (_) { pageStatus("Wallet library did not load. Check your connection and reload."); return; }
  if (walletAccountId) { await disconnectWallet(); return; }
  try { localStorage.removeItem("merit-wallet-disconnected"); } catch (_) { /* storage unavailable */ }
  try { sessionStorage.removeItem("merit-wallet-disconnected"); } catch (_) { /* storage unavailable */ }
  try {
    pageStatus("Opening wallet selector…");
    const result = await nw.connect({ network: window.NETWORK });
    const id = (result && typeof result.accountId === "string" && result.accountId) || currentAccountId(nw);
    if (typeof id !== "string" || !id) { pageStatus("Could not determine the connected account. Try again."); return; }
    walletAccountId = id;
    refreshWalletBtn();
    pageStatus("");
    walletChanged();
  } catch (e) { pageStatus("Wallet error: " + String(e.message).slice(0, 160)); }
}
async function walletCall(contractId, method, args, depositYocto, gas) {
  const nw = fastnear();
  return nw.sendTransaction({
    receiverId: contractId,
    network: window.NETWORK,
    actions: [{
      type: "FunctionCall",
      methodName: method,
      args: args,
      gas: (gas || window.GAS_100).toString(),
      deposit: depositYocto.toString(),
    }],
  });
}

// ---- Contract reads (no wallet needed) ----
function contractId() { return window.CONTRACT_ID; }
function deployed() { return Boolean(window.CONTRACT_ID); }
async function view(method, args) {
  if (!deployed()) throw new Error("Contract not deployed yet");
  return rpcViewCall(window.CONTRACT_ID, method, args);
}

// ---- Merit DAO reads (Sputnik v2, no wallet needed) ----
function daoId() { return window.DAO_ID; }
function daoDeployed() { return Boolean(window.DAO_ID); }
async function daoView(method, args) {
  if (!daoDeployed()) throw new Error("Merit DAO not deployed yet");
  return rpcViewCall(window.DAO_ID, method, args);
}

// Apply the brand name to every element marked data-brand.
function applyBrand() {
  document.querySelectorAll("[data-brand]").forEach((n) => { n.textContent = window.BRAND_NAME; });
  document.title = document.title.replace("OwnGround", window.BRAND_NAME);
}
document.addEventListener("DOMContentLoaded", applyBrand);

// ---- Level-based badge design ----
// A badge's design comes from its LEVEL, never its skill or profession.
// Level 1 is a matte bronze seal with a single chevron, level 2 a
// polished silver seal with a double chevron, level 3 a rich gold seal
// with a star and a double rim. The same level looks identical for
// welding, coding, design, writing or any other skill; the skill is
// the name written on the badge, not a different design. Levels above
// 3 carry the level 3 emblem; the number beside the seal still states
// the true level.
function sealLevelNum(level) {
  const n = Number(level) || 1;
  return n < 1 ? 1 : (n > 3 ? 3 : n);
}
function sealClass(level) { return "seal-lv" + sealLevelNum(level); }
function levelEmblem(level) {
  const n = sealLevelNum(level);
  const wrap = (p) => "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\">" + p + "</svg>";
  if (n === 1) return wrap("<path d=\"m5 15.5 7-6.5 7 6.5\"/>");
  if (n === 2) return wrap("<path d=\"m5 12.5 7-6 7 6\"/><path d=\"m5 18.5 7-6 7 6\"/>");
  return wrap("<polygon points=\"12 3 14.9 8.9 21.4 9.6 16.6 14.1 17.9 20.5 12 17.2 6.1 20.5 7.4 14.1 2.6 9.6 9.1 8.9\" fill=\"currentColor\" stroke=\"none\"/>");
}
function blankEmblem() {
  return "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><circle cx=\"12\" cy=\"8\" r=\"6\"/><path d=\"M15.477 12.89 17 22l-5-3-5 3 1.523-9.11\"/></svg>";
}
// The Merit seal's tier comes from the Merit's level alone:
// bronze 0-3, silver 4-6, gold 7+. Every Merit at the same tier
// carries the same seal, whatever skills its stamps name.
function meritTier(level) {
  const n = Number(level) || 0;
  if (n >= 7) return { key: "gold", label: "Gold" };
  if (n >= 4) return { key: "silver", label: "Silver" };
  return { key: "bronze", label: "Bronze" };
}
let badgeUid = 0;
// The holographic layer inside the seal: a glowing blue rosette
// medallion the level emblem sits on, laurel branches flanking it,
// and faint light rays. Built in code so the petals and leaves are
// placed by angle, not hand-written one by one.
function badgeHolo(uid) {
  let petals = "";
  for (let k = 0; k < 12; k++) {
    petals += "<ellipse cx=\"60\" cy=\"9\" rx=\"8\" ry=\"14\" transform=\"rotate(" + (k * 30) + " 60 44)\"/>";
  }
  const leaves = [[44, 92, -50], [36, 78, -35], [30, 62, -20], [28, 46, -5], [76, 92, 50], [84, 78, 35], [90, 62, 20], [92, 46, 5]];
  let laurel = "";
  for (const l of leaves) {
    laurel += "<ellipse cx=\"" + l[0] + "\" cy=\"" + l[1] + "\" rx=\"4\" ry=\"9\" transform=\"rotate(" + l[2] + " " + l[0] + " " + l[1] + ")\"/>";
  }
  return "<svg class=\"badge-holo\" viewBox=\"0 0 120 120\" aria-hidden=\"true\">" +
    "<defs><radialGradient id=\"" + uid + "-disc\" cx=\"50%\" cy=\"42%\" r=\"65%\">" +
    "<stop offset=\"0%\" stop-color=\"#8fe9ff\"/><stop offset=\"45%\" stop-color=\"#2f7fe0\"/><stop offset=\"100%\" stop-color=\"#123a8f\"/></radialGradient>" +
    "<linearGradient id=\"" + uid + "-petal\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">" +
    "<stop offset=\"0%\" stop-color=\"#bfefff\"/><stop offset=\"100%\" stop-color=\"#1d5fd6\"/></linearGradient></defs>" +
    "<g stroke=\"rgba(255,255,255,0.10)\" stroke-width=\"1.5\">" +
    "<line x1=\"60\" y1=\"60\" x2=\"14\" y2=\"10\"/><line x1=\"60\" y1=\"60\" x2=\"106\" y2=\"10\"/>" +
    "<line x1=\"60\" y1=\"60\" x2=\"8\" y2=\"60\"/><line x1=\"60\" y1=\"60\" x2=\"112\" y2=\"60\"/>" +
    "<line x1=\"60\" y1=\"60\" x2=\"14\" y2=\"110\"/><line x1=\"60\" y1=\"60\" x2=\"106\" y2=\"110\"/></g>" +
    "<g fill=\"url(#" + uid + "-petal)\" opacity=\"0.9\">" + petals + "</g>" +
    "<g fill=\"#7fe3c0\" opacity=\"0.85\">" + laurel + "</g>" +
    "<circle cx=\"60\" cy=\"44\" r=\"27\" fill=\"url(#" + uid + "-disc)\"/>" +
    "<circle cx=\"60\" cy=\"44\" r=\"27\" fill=\"none\" stroke=\"rgba(255,255,255,0.55)\" stroke-width=\"1.5\"/>" +
    "<circle cx=\"60\" cy=\"44\" r=\"21\" fill=\"none\" stroke=\"rgba(255,255,255,0.25)\" stroke-width=\"1\"/></svg>";
}
function meritBadgeArt(tokenId, level, stamps) {
  const list = Array.isArray(stamps) ? stamps : [];
  const tier = meritTier(level);
  const emblemLevel = tier.key === "gold" ? 3 : tier.key === "silver" ? 2 : 1;
  const hasStamps = list.length > 0;
  let pips = "";
  for (let i = 0; i < Math.min(list.length, 8); i++) pips += "<i></i>";
  const uid = "badgering" + (++badgeUid);
  const countLabel = list.length + (list.length === 1 ? " stamp" : " stamps");
  const ring = "MERIT \u2022 NEAR TESTNET \u2022 LEVEL " + (Number(level) || 0) + " \u2022 " + tier.label.toUpperCase() + " TIER \u2022 ";
  return "<div class=\"merit-badge tier-" + tier.key + "\" role=\"img\" aria-label=\"" + escapeHtml(tier.label) + " tier Merit seal, level " + escapeHtml(String(level)) + ", " + escapeHtml(countLabel) + "\">" +
    "<div class=\"badge-core\">" + badgeHolo(uid) +
    "<div class=\"badge-icon\">" + (hasStamps ? levelEmblem(emblemLevel) : blankEmblem()) + "</div>" +
    "<div class=\"badge-skill\">" + (hasStamps ? "Level " + escapeHtml(String(level)) : "No stamps yet") + "</div>" +
    (pips ? "<div class=\"badge-pips\" aria-hidden=\"true\">" + pips + "</div>" : "") +
    "</div>" +
    "<svg class=\"badge-ringtext\" viewBox=\"0 0 120 120\" aria-hidden=\"true\"><defs><path id=\"" + uid + "\" d=\"M60,60 m-51,0 a51,51 0 1,1 102,0 a51,51 0 1,1 -102,0\"/></defs>" +
    "<text><textPath href=\"#" + uid + "\" textLength=\"316\" lengthAdjust=\"spacingAndGlyphs\">" + escapeHtml(ring) + "</textPath></text></svg>" +
    "<div class=\"badge-count\">" + escapeHtml(countLabel) + "</div></div>";
}
function meritRings() {
  return "<svg class=\"rings\" viewBox=\"0 0 200 200\" aria-hidden=\"true\" fill=\"none\" stroke=\"#ffffff\">" +
    "<circle cx=\"100\" cy=\"100\" r=\"96\" stroke-width=\"1\"/><circle cx=\"100\" cy=\"100\" r=\"72\" stroke-width=\"1\"/>" +
    "<circle cx=\"100\" cy=\"100\" r=\"48\" stroke-width=\"1\"/><circle cx=\"100\" cy=\"100\" r=\"24\" stroke-width=\"1\"/></svg>";
}
function levelBadgeHtml(level, stamps, capSuffix) {
  const tier = meritTier(level);
  const n = Array.isArray(stamps) ? stamps.length : null;
  const cap = tier.label + " tier" + (n != null ? " \u2022 " + n + (n === 1 ? " stamp" : " stamps") : "") + (capSuffix || "");
  return "<div class=\"level-badge\"><div class=\"lb-num tier-" + tier.key + "\"><span>Level</span><b>" + escapeHtml(String(level)) + "</b></div><div class=\"lb-cap\">" + escapeHtml(cap) + "</div></div>";
}

// ---- Badge catalogue ----
// What each stamp type certifies, in the order the Badges page shows
// them. Any stamp skill found onchain that is not listed here still
// appears, with the generic wording below.
const BADGE_ORDER = ["merit-basics", "welding", "torch-work", "gate-welding", "repair-welding", "coding", "design", "writing", "data-entry"];
const BADGE_CERTIFIES = {
  "merit-basics": "Certifies the demo onboarding check for the Merit system. The holder passed the public demo test and has been grounded in how Merits, stamps and gated jobs work. This is a demo stamp, not proof of a real skill, and gated jobs should not treat it as a high trust credential.",
  "welding": "Certifies welding skill \u2014 joining metal to a standard an issuer has inspected. Higher levels mark heavier, more demanding welding work.",
  "torch-work": "Certifies torch work \u2014 cutting and heating metal with a torch, done safely and to the line the job required.",
  "gate-welding": "Certifies gate welding \u2014 fabricating and hanging gates so they swing true, latch cleanly and hold under load.",
  "repair-welding": "Certifies repair welding \u2014 diagnosing broken metalwork and welding it back to working strength, including work judged through a DAO dispute.",
  "coding": "Certifies coding skill \u2014 building working web pages and small tools that run in the browser and do what the brief asked.",
  "design": "Certifies design skill \u2014 creating clear, usable visuals and layouts that match the brief and read well on any screen.",
  "writing": "Certifies writing skill \u2014 clear, accurate copy written to brief, in the right tone and length for its reader.",
  "data-entry": "Certifies data entry \u2014 accurate, tidy data work: cleaning, sorting and formatting records without errors."
};
// Badges earnable from the open jobs' completion stamps. The live open
// jobs are read on the Badges page and take precedence; these entries
// are the fallback so the four online badges still show if a job read
// fails or a job has just been taken.
const EARNABLE_FALLBACK = [
  { skill: "coding", level: 1, jobTitle: "Build a landing page" },
  { skill: "design", level: 1, jobTitle: "Design a logo" },
  { skill: "writing", level: 1, jobTitle: "Write a product description" },
  { skill: "data-entry", level: 1, jobTitle: "Clean a customer list" }
];
function badgeCertifies(skill) {
  return BADGE_CERTIFIES[String(skill || "").toLowerCase()] ||
    "Certifies " + skill + " \u2014 a skill recorded onchain by a whitelisted stamp issuer for work actually done.";
}
// One short line per level actually held onchain, saying what that
// level of the badge proves. Levels not listed for a skill fall back
// to the generic band wording in badgeLevelLine.
const BADGE_LEVEL_LINES = {
  "merit-basics": {
    1: "Proves the demo onboarding check is done: the holder knows how Merits, stamps and gated jobs work. This is a demo stamp, not proof of a real skill.",
    2: "Proves the system used confidently \u2014 earning, lending and taking gated jobs without guidance.",
    3: "Proves deep command of the Merit system, trusted to model it for new holders."
  },
  "welding": {
    1: "Proves a sound basic weld on straightforward joints \u2014 clean, fused and fit for ordinary work.",
    2: "Proves independent welding to standard on regular fabrication work, without supervision.",
    3: "Proves demanding, structural welding to an inspected standard \u2014 the level the toughest gated jobs trust."
  },
  "torch-work": {
    1: "Proves safe torch cutting and heating along a marked line, with a clean edge.",
    2: "Proves independent torch work on shaped and angled cuts, edges kept clean.",
    3: "Proves precision torch work on demanding cuts, where one bad cut would ruin the piece."
  },
  "gate-welding": {
    1: "Proves a standard gate fabricated and hung so it swings true and latches cleanly.",
    2: "Proves larger gates built and fitted independently, aligned and balanced under load.",
    3: "Proves heavy or custom gate work to an inspected standard, hinges and frame holding under load."
  },
  "repair-welding": {
    1: "Proves a simple weld repair that returns a broken item to everyday use.",
    2: "Proves a broken piece diagnosed and welded back to working strength without supervision \u2014 including dispute-judged work.",
    3: "Proves heavily damaged or structural metalwork restored to full strength."
  },
  "coding": {
    1: "Proves a working page or tool built to brief \u2014 code that runs, looks right and does the job asked.",
    2: "Proves independent coding on a fuller build, structured cleanly and checked before delivery.",
    3: "Proves demanding builds to an inspected standard \u2014 complex logic handled reliably."
  },
  "design": {
    1: "Proves a clean, usable design delivered to brief \u2014 layout, type and colour working together.",
    2: "Proves independent design work with a consistent system across screens or assets.",
    3: "Proves polished, inspected design work \u2014 a complete visual identity or interface to standard."
  },
  "writing": {
    1: "Proves clear copy written to brief \u2014 accurate, readable and in the right tone.",
    2: "Proves independent writing shaped for its audience, edited and ready to publish.",
    3: "Proves demanding writing to an inspected standard \u2014 long or specialist work handled with authority."
  },
  "data-entry": {
    1: "Proves accurate data entry on a real list \u2014 cleaned, sorted and formatted without errors.",
    2: "Proves larger data work handled independently, consistent and error-checked.",
    3: "Proves demanding data work to an inspected standard \u2014 messy records made reliable at scale."
  }
};
function badgeLevelLine(skill, level) {
  const per = BADGE_LEVEL_LINES[String(skill || "").toLowerCase()];
  if (per && per[level]) return per[level];
  const name = String(skill || "this skill");
  if (level <= 1) return "Proves the foundation of " + name + " \u2014 the basic skill, shown on real work and checked by the issuer.";
  if (level === 2) return "Proves " + name + " applied independently, to a standard the issuer has inspected.";
  if (level === 3) return "Proves " + name + " on demanding work, to an inspected standard.";
  return "Proves mastery-level " + name + ", well beyond the standard gated jobs require.";
}

// Test hook used by the headless verifier only: lets the verifier set a
// connected account and capture the exact call a form builds, without a
// real wallet. Never used by the site itself. Setting the wallet here
// also fires walletChanged, exactly like a real connect, so pages that
// re-render on wallet change (for example the Merit detail page showing
// owner-only withdraw UI) update the same way they do for a real user.
window.__meritTest = {
  setWallet: function (id) { walletAccountId = id; refreshWalletBtn(); walletChanged(); },
  getWallet: function () { return walletAccountId; },
};
