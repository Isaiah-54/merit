// DAO proposals page: list the Merit DAO proposals, show the job,
// proposed outcome, acceptance criteria and both sides evidence
// hashes for each, and let council members vote Approve or Reject.
// Voting calls the DAO act_proposal with 0 deposit and 300 TGas,
// through the same wallet flow as every other write on this site.
// act_proposal rejects any deposit, and the threshold-reaching vote
// executes the proposal's own call inside the same transaction,
// so 100 TGas is not enough.
let daoPolicy = null;
let daoProposals = [];
let daoJobs = {};

function daoThreshold(policy) {
  try {
    const vp = policy && policy.default_vote_policy;
    let t = vp && vp.threshold;
    if (Array.isArray(t)) return parseInt(t[0], 10);
    if (t && typeof t === "object") {
      if (t.threshold != null) return parseInt(t.threshold, 10);
      return 0;
    }
    const n = parseInt(t, 10);
    return Number.isInteger(n) ? n : 0;
  } catch (_) { return 0; }
}
function daoCouncil(policy) {
  try {
    const roles = (policy && policy.roles) || [];
    const council = roles.find((r) => r.name === "council");
    const kind = council && council.kind;
    if (kind && Array.isArray(kind.Group)) return kind.Group;
    if (kind && Array.isArray(kind.group)) return kind.group;
    return [];
  } catch (_) { return []; }
}
function isCouncilMember() {
  if (!walletAccountId) return false;
  return daoCouncil(daoPolicy).indexOf(walletAccountId) >= 0;
}

// Decode the FunctionCall inside a Sputnik proposal kind, if any.
// Returns { receiverId, methodName, args } or null.
function parseProposalCall(p) {
  try {
    const kind = p.kind || {};
    const fc = kind.FunctionCall || kind.function_call || kind.Functioncall || null;
    if (!fc || !fc.actions || !fc.actions.length) return null;
    const action = fc.actions[0];
    let args = {};
    const raw = action.args;
    if (typeof raw === "string" && raw) {
      try {
        args = JSON.parse(atob(raw));
      } catch (_) {
        try { args = JSON.parse(raw); } catch (_) { args = {}; }
      }
    } else if (raw && typeof raw === "object") {
      args = raw;
    }
    return { receiverId: fc.receiver_id || "", methodName: action.method_name || "", args: args };
  } catch (_) { return null; }
}
function outcomeText(outcome, partialAmount) {
  if (outcome === "pay_full") return "Pay in full and issue the stamp";
  if (outcome === "refund") return "Refund the poster and issue no stamp";
  if (outcome === "partial") {
    const amt = partialAmount != null ? " of " + fmtYocto(partialAmount) + " NEAR to the worker" : "";
    return "Pay partial" + amt + " and issue no stamp";
  }
  return outcome ? String(outcome) : "No outcome stated";
}
function proposalVotes(p) {
  const votes = p.votes || {};
  const approve = [];
  const reject = [];
  const remove = [];
  for (const account of Object.keys(votes)) {
    const v = votes[account];
    if (v === "Approve") approve.push(account);
    else if (v === "Reject") reject.push(account);
    else if (v === "Remove") remove.push(account);
  }
  // Fall back to the onchain vote counts when the votes map is empty.
  if (approve.length === 0 && reject.length === 0 && p.vote_counts) {
    const counts = p.vote_counts.council || p.vote_counts.Council || null;
    if (Array.isArray(counts)) {
      return { approveCount: Number(counts[0] || 0), rejectCount: Number(counts[1] || 0), approve: approve, reject: reject, remove: remove, myVote: votes[walletAccountId] || null };
    }
  }
  return { approveCount: approve.length, rejectCount: reject.length, approve: approve, reject: reject, remove: remove, myVote: votes[walletAccountId] || null };
}

// Build the exact vote call the page sends. Kept separate so the
// headless verifier can check the call without a real wallet.
function buildVoteCall(id, action) {
  return {
    method: "act_proposal",
    args: { id: id, action: action },
    depositYocto: "0",
    gas: window.GAS_300,
  };
}

// Fetch the content an evidence reference points to, hash it
// client-side, and compare it with the hash recorded onchain.
// Returns { status, text } where status is match, mismatch, missing
// or none. A fetch that fails is reported as missing, never as a
// match: an unverifiable reference must not look verified.
async function verifyEvidence(job, side) {
  const isPoster = side === "poster";
  const hash = isPoster ? job.poster_evidence : job.worker_evidence;
  const ref = isPoster ? job.poster_evidence_ref : job.worker_evidence_ref;
  if (!hash) return { status: "none", text: "No evidence hash onchain to compare against." };
  if (!ref) return { status: "missing", text: "Missing: no evidence reference was posted, so there is nothing to fetch." };
  if (!window.crypto || !crypto.subtle) return { status: "missing", text: "Missing: this browser cannot compute a hash to verify the content." };
  let res;
  try {
    res = await fetch(evidenceRefUrl(ref));
  } catch (_) {
    return { status: "missing", text: "Missing: the referenced content could not be fetched." };
  }
  if (!res || !res.ok) return { status: "missing", text: "Missing: the referenced content could not be fetched." };
  let bytes;
  try {
    bytes = await res.arrayBuffer();
  } catch (_) {
    return { status: "missing", text: "Missing: the referenced content could not be fetched." };
  }
  let digest;
  try {
    digest = await sha256Hex(bytes);
  } catch (_) {
    return { status: "missing", text: "Missing: the content hash could not be computed." };
  }
  if (digest === String(hash).toLowerCase()) return { status: "match", text: "Match: the fetched content hashes to the onchain hash." };
  return { status: "mismatch", text: "Mismatch: the fetched content does not hash to the onchain hash." };
}

// The proposal freezes the evidence set: its description records the
// evidence hashes as they stood when the proposal was made. If the
// hash now onchain for a side is not among the hashes recorded in
// the description, that side's evidence was swapped after the
// proposal. No hashes recorded means nothing to compare, so no flag.
function evidenceChangedFlags(job, description) {
  const descHashes = (String(description || "").match(/[0-9a-fA-F]{64}/g) || []).map((h) => h.toLowerCase());
  if (!descHashes.length || !job) return { poster: false, worker: false };
  return {
    poster: !!job.poster_evidence && descHashes.indexOf(String(job.poster_evidence).toLowerCase()) < 0,
    worker: !!job.worker_evidence && descHashes.indexOf(String(job.worker_evidence).toLowerCase()) < 0,
  };
}

// One evidence row: the onchain hash, a View evidence button that
// shows the content inline on this page, and a Verify control that
// fetches the content and checks it against the hash. The content is
// shown inline because a raw data: link opens a blank tab on some
// phones instead of showing the text.
function evidenceRowHtml(label, hash, ref, jobId, side) {
  let h = "<div class=\"evidence-row\"><p>" + label + " evidence: ";
  if (hash) {
    h += "<span class=\"hash\">" + escapeHtml(hash) + "</span>";
    if (ref) {
      h += " <button type=\"button\" class=\"btn secondary viewEvidenceBtn\" data-job-id=\"" + escapeHtml(jobId || "") + "\" data-side=\"" + side + "\">View evidence</button>";
    } else {
      h += " <span class=\"muted small\">No reference posted, so the content cannot be fetched.</span>";
    }
    h += " <button type=\"button\" class=\"btn secondary verifyEvidenceBtn\" data-job-id=\"" + escapeHtml(jobId || "") + "\" data-side=\"" + side + "\">Verify</button> <span class=\"evidenceVerifyMsg muted small\" aria-live=\"polite\"></span>";
  } else {
    h += "None submitted";
  }
  return h + "</p><div class=\"evidenceContent\" aria-live=\"polite\"></div></div>";
}

async function loadProposals() {
  const list = el("proposalList");
  try {
    const policy = await daoView("get_policy", {});
    daoPolicy = policy;
    const proposals = await daoView("get_proposals", { from_index: 0, limit: 20 });
    daoProposals = Array.isArray(proposals) ? proposals : [];
    daoJobs = {};
    // Fetch the disputed job for each proposal that calls
    // resolve_dispute, so the criteria and evidence hashes shown are
    // the live onchain job record.
    for (const p of daoProposals) {
      const call = parseProposalCall(p);
      const jobId = call && call.args && call.args.job_id;
      if (jobId && !daoJobs[jobId]) {
        try { daoJobs[jobId] = await view("get_job", { job_id: jobId }); } catch (_) { daoJobs[jobId] = null; }
      }
    }
    renderProposals();
  } catch (e) {
    list.innerHTML = "<p class=\"muted\">Could not load proposals. " + escapeHtml(e.message || String(e)) + "</p>";
  }
}

function renderProposals() {
  const list = el("proposalList");
  if (!daoPolicy && (!daoProposals || daoProposals.length === 0)) return;
  if (!daoProposals || daoProposals.length === 0) {
    list.innerHTML = "<div class=\"panel\"><p>No proposals yet.</p><p class=\"muted\">A proposal appears here when a disputed job is sent to the DAO.</p><p><a class=\"btn secondary\" href=\"jobs.html\">Browse the jobs</a></p></div>";
    return;
  }
  const threshold = daoThreshold(daoPolicy);
  const cards = daoProposals.map((p) => {
    const call = parseProposalCall(p);
    const jobId = call && call.args ? call.args.job_id : null;
    const outcome = call && call.args ? call.args.outcome : null;
    const partialAmount = call && call.args ? call.args.partial_amount : null;
    const job = jobId ? daoJobs[jobId] : null;
    const criteria = job && job.criteria ? job.criteria : null;
    const posterEvidence = job ? job.poster_evidence : null;
    const workerEvidence = job ? job.worker_evidence : null;
    const posterRef = job ? job.poster_evidence_ref : null;
    const workerRef = job ? job.worker_evidence_ref : null;
    const changed = job ? evidenceChangedFlags(job, p.description) : { poster: false, worker: false };
    const status = p.status || "InProgress";
    const votes = proposalVotes(p);
    const isResolve = call && call.methodName === "resolve_dispute";
    let html = "<div class=\"card\" id=\"proposal-" + escapeHtml(String(p.id)) + "\" data-proposal-id=\"" + escapeHtml(String(p.id)) + "\">" +
      "<div class=\"label\">Proposal " + escapeHtml(String(p.id)) + " · " + escapeHtml(status) + "</div>" +
      "<p>" + escapeHtml(p.description || "No description posted for this proposal.") + "</p>";
    if (jobId) html += "<p>Job: <strong>" + escapeHtml(jobId) + "</strong></p>";
    if (isResolve) {
      html += "<p>Proposed outcome: <strong>" + escapeHtml(outcomeText(outcome, partialAmount)) + "</strong></p>";
      html += "<p class=\"muted small\">Calls resolve_dispute on the Merit contract. When this proposal passes, the DAO carries out the outcome.</p>";
    } else if (call) {
      html += "<p>Calls <strong>" + escapeHtml(call.methodName) + "</strong> on " + escapeHtml(call.receiverId) + "</p>";
    }
    if (criteria) html += "<p>Acceptance criteria: " + escapeHtml(criteria) + "</p>";
    else if (jobId) html += "<p>Acceptance criteria: Not shown onchain for this job.</p>";
    html += evidenceRowHtml("Poster", posterEvidence, posterRef, jobId, "poster");
    html += evidenceRowHtml("Worker", workerEvidence, workerRef, jobId, "worker");
    if (changed.poster) html += "<p class=\"evidence-flag\">Poster evidence changed after this proposal was made: the hash onchain no longer matches the hash recorded in the proposal.</p>";
    if (changed.worker) html += "<p class=\"evidence-flag\">Worker evidence changed after this proposal was made: the hash onchain no longer matches the hash recorded in the proposal.</p>";
    html += "<p>Approvals: <strong>" + escapeHtml(String(votes.approveCount)) + " of " + escapeHtml(String(threshold)) + "</strong></p>";
    if (votes.approve.length) html += "<p class=\"muted small\">Approved by " + votes.approve.map(escapeHtml).join(", ") + "</p>";
    if (votes.reject.length) html += "<p class=\"muted small\">Rejected by " + votes.reject.map(escapeHtml).join(", ") + "</p>";
    if (status === "InProgress") {
      if (!walletAccountId) {
        html += "<p class=\"muted\">Connect your wallet to vote. Only DAO council members can vote.</p>";
      } else if (!isCouncilMember()) {
        html += "<p class=\"muted\">Only DAO council members can vote. Switch to a council member's wallet to vote.</p>";
      } else if (votes.myVote) {
        html += "<p class=\"muted\">You voted " + escapeHtml(votes.myVote) + " on this proposal.</p>";
      } else {
        html += "<p><button type=\"button\" class=\"voteApprove\">Vote Approve</button> " +
          "<button type=\"button\" class=\"voteReject secondary\">Vote Reject</button></p>";
      }
    } else {
      html += "<p class=\"muted\">This proposal is " + escapeHtml(status) + ". Voting is closed.</p>";
    }
    html += "<p class=\"proposalMsg muted small\"></p></div>";
    return html;
  });
  list.innerHTML = "<div class=\"grid\">" + cards.join("") + "</div>";
  list.querySelectorAll(".card").forEach((card) => {
    const id = parseInt(card.getAttribute("data-proposal-id"), 10);
    const msg = card.querySelector(".proposalMsg");
    const vote = async (action, btn) => {
      if (!walletAccountId) { pageStatus("Connect your wallet first."); return; }
      const call = buildVoteCall(id, action);
      btn.disabled = true;
      if (msg) msg.textContent = "Sending vote…";
      pageStatus("Sending vote. Confirm in your wallet.");
      try {
        await walletCall(daoId(), call.method, call.args, call.depositYocto, call.gas);
        pageStatus("Vote sent. It will show here once the chain confirms it.");
        if (msg) msg.textContent = "Vote sent. Reload to see the new count.";
        await loadProposals();
      } catch (e) {
        const r = reportFailure(e);
        if (msg) msg.textContent = r.text;
      } finally {
        btn.disabled = false;
      }
    };
    const approveBtn = card.querySelector(".voteApprove");
    if (approveBtn) approveBtn.addEventListener("click", () => vote("VoteApprove", approveBtn));
    const rejectBtn = card.querySelector(".voteReject");
    if (rejectBtn) rejectBtn.addEventListener("click", () => vote("VoteReject", rejectBtn));
    card.querySelectorAll(".viewEvidenceBtn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const jobId = btn.getAttribute("data-job-id");
        const side = btn.getAttribute("data-side");
        const job = daoJobs[jobId];
        const row = btn.closest(".evidence-row");
        const box = row ? row.querySelector(".evidenceContent") : null;
        if (!job) { if (box) box.textContent = "The job record could not be read."; return; }
        const ref = side === "poster" ? job.poster_evidence_ref : job.worker_evidence_ref;
        btn.disabled = true;
        try { await showEvidenceContent(box, ref); }
        finally { btn.disabled = false; }
      });
    });
    card.querySelectorAll(".verifyEvidenceBtn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const jobId = btn.getAttribute("data-job-id");
        const side = btn.getAttribute("data-side");
        const job = daoJobs[jobId];
        const msgEl = btn.parentElement ? btn.parentElement.querySelector(".evidenceVerifyMsg") : null;
        if (!job) { if (msgEl) msgEl.textContent = "Missing: the job record could not be read."; return; }
        if (msgEl) msgEl.textContent = "Fetching the referenced content…";
        btn.disabled = true;
        try {
          const r = await verifyEvidence(job, side);
          if (msgEl) msgEl.textContent = r.text;
        } finally {
          btn.disabled = false;
        }
      });
    });
  });
}

window.meritWalletChanged = function () { renderProposals(); };
loadProposals();
