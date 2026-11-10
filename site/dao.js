// DAO proposals page: list the Merit DAO proposals, show the job,
// proposed outcome, acceptance criteria and both sides evidence
// hashes for each, and let council members vote Approve or Reject.
// Voting calls the DAO act_proposal with 1 yoctoNEAR, through the
// same wallet flow as every other write on this site.
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
    depositYocto: "1",
    gas: window.GAS_100,
  };
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
    html += "<p>Poster evidence: <span class=\"hash\">" + escapeHtml(posterEvidence || "None submitted") + "</span></p>";
    html += "<p>Worker evidence: <span class=\"hash\">" + escapeHtml(workerEvidence || "None submitted") + "</span></p>";
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
  });
}

window.meritWalletChanged = function () { renderProposals(); };
loadProposals();
