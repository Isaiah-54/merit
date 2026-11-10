// Job board: list jobs with required stamps and payment, create jobs
// with escrowed payment, and accept or complete them with a Merit.
// The gate refusal is shown plainly when a Merit lacks a stamp.
function normStamps(job) {
  const raw = job.required_stamps || job.requiredStamps || [];
  return raw.map((s) => {
    if (typeof s === "string") return { skill: s, level: 1 };
    const level = s.level != null ? s.level : (s.min_level != null ? s.min_level : 1);
    return { skill: s.skill, level: level };
  });
}
function jobPaymentYocto(job) {
  return job.payment || job.amount || job.escrow || job.price || "0";
}
function jobStatus(job) {
  if (job.status) return job.status;
  return job.accepted_by ? "Accepted" : "Open";
}
function jobProposalId(job) {
  const keys = ["dao_proposal_id", "proposal_id", "dispute_proposal_id"];
  for (const k of keys) { if (job[k] != null) return job[k]; }
  return null;
}
function fmtCompletionStamp(job) {
  const cs = job.completion_stamp || job.completionStamp || null;
  if (!cs || !cs.skill) return "";
  return escapeHtml(cs.skill) + " level " + escapeHtml(String(cs.level != null ? cs.level : 1));
}
// Parse the "skill level" lines from the create form into the
// required_stamps shape the contract takes.
function parseRequiredStamps(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(/\s+/);
    const skill = parts[0];
    const level = parts.length > 1 ? parseInt(parts[1], 10) : 1;
    if (!skill) continue;
    if (!Number.isInteger(level) || level < 1) throw new Error("Each stamp level must be 1 or more.");
    out.push({ skill: skill, level: level });
  }
  return out;
}
function buildCreateJobCall(jobId, title, description, requiredStamps, completionStamp, criteria, paymentYocto) {
  return {
    method: "create_job",
    args: {
      job_id: jobId,
      title: title,
      description: description,
      required_stamps: requiredStamps.map((s) => ({ skill: s.skill, min_level: s.level })),
      completion_stamp: completionStamp,
      criteria: criteria,
    },
    depositYocto: paymentYocto,
    gas: window.GAS_150,
  };
}

async function loadJobs() {
  const list = el("jobList");
  try {
    const jobs = await view("list_jobs", {});
    if (!jobs || jobs.length === 0) {
      list.innerHTML = "<div class=\"panel\"><p>No jobs yet.</p><p class=\"muted\">Create the first one above. It names the stamps it needs, the payment held in escrow, and the acceptance criteria the work is judged against.</p></div>";
      return;
    }
    const cards = jobs.map((job) => {
      const stamps = normStamps(job);
      const stampText = stamps.length === 0
        ? "No stamp needed"
        : stamps.map((s) => escapeHtml(s.skill) + " " + escapeHtml(String(s.level))).join(", ");
      const status = jobStatus(job);
      const completion = fmtCompletionStamp(job);
      const proposalId = jobProposalId(job);
      let disputeLine = "";
      if (status === "Disputed") {
        disputeLine = proposalId != null
          ? "<p><a href=\"dao.html#proposal-" + escapeHtml(String(proposalId)) + "\">DAO proposal " + escapeHtml(String(proposalId)) + "</a></p>"
          : "<p><a href=\"dao.html\">See the DAO proposals</a></p>";
      }
      return "<div class=\"card\" data-job-id=\"" + escapeHtml(job.job_id) + "\">" +
        "<div class=\"label\">" + escapeHtml(status) + "</div>" +
        "<p><strong>" + escapeHtml(job.title || job.job_id) + "</strong></p>" +
        "<p class=\"muted\">" + escapeHtml(job.description || "") + "</p>" +
        "<p>Needs: " + stampText + "</p>" +
        "<p>Payment: <strong>" + escapeHtml(fmtYocto(jobPaymentYocto(job))) + " NEAR</strong></p>" +
        "<p>Arbiter DAO: <strong>" + escapeHtml(job.arbiter || window.DAO_ID || "Not named yet") + "</strong></p>" +
        (completion ? "<p>Completion stamp: <strong>" + completion + "</strong></p>" : "") +
        "<p>Acceptance criteria: " + escapeHtml(job.criteria || "Not posted yet.") + "</p>" +
        "<p>Dispute state: <strong>" + escapeHtml(status) + "</strong></p>" +
        (job.poster_evidence ? "<p class=\"muted small\">Poster evidence: <span class=\"hash\">" + escapeHtml(job.poster_evidence) + "</span></p>" : "") +
        (job.worker_evidence ? "<p class=\"muted small\">Worker evidence: <span class=\"hash\">" + escapeHtml(job.worker_evidence) + "</span></p>" : "") +
        disputeLine +
        "<p class=\"muted small\">Job " + escapeHtml(job.job_id) + "</p>" +
        "<label>Merit token id</label>" +
        "<input type=\"text\" class=\"acceptMerit\" placeholder=\"mymerit\" autocomplete=\"off\">" +
        "<p><button type=\"button\" class=\"checkBtn secondary\">Check access</button> " +
        "<button type=\"button\" class=\"acceptBtn\">Accept job</button> " +
        "<button type=\"button\" class=\"completeBtn secondary\">Complete job</button></p>" +
        "<p class=\"jobMsg muted small\"></p>" +
        "</div>";
    });
    list.innerHTML = "<div class=\"grid\">" + cards.join("") + "</div>";
    list.querySelectorAll(".card").forEach((card) => {
      const jobId = card.getAttribute("data-job-id");
      const meritInput = card.querySelector(".acceptMerit");
      const msg = card.querySelector(".jobMsg");
      const setMsg = (t) => { msg.textContent = t; };
      card.querySelector(".checkBtn").addEventListener("click", async () => {
        const tokenId = meritInput.value.trim();
        if (!tokenId) { setMsg("Enter a Merit token id first."); return; }
        setMsg("Checking access…");
        try {
          const ok = await view("can_access", { token_id: tokenId, job_id: jobId, account_id: walletAccountId || "" });
          setMsg(ok ? "Access open: this Merit has the required stamps." : "Access refused: this Merit lacks the required stamp.");
        } catch (e) { setMsg("Could not check access. " + (e.message || String(e))); }
      });
      card.querySelector(".acceptBtn").addEventListener("click", async () => {
        const tokenId = meritInput.value.trim();
        if (!walletAccountId) { pageStatus("Connect your wallet first."); return; }
        if (!tokenId) { setMsg("Enter a Merit token id first."); return; }
        const btn = card.querySelector(".acceptBtn");
        btn.disabled = true;
        setMsg("Checking access, then sending…");
        try {
          let ok = true;
          try { ok = await view("can_access", { token_id: tokenId, job_id: jobId, account_id: walletAccountId }); } catch (_) { /* precheck is best effort; the contract is the gate */ }
          if (!ok) {
            setMsg("Access refused: this Merit lacks the required stamp.");
            pageStatus("Access refused: this Merit lacks the required stamp. No money moved.");
            return;
          }
          pageStatus("Sending accept. Confirm in your wallet.");
          await walletCall(contractId(), "accept_job", { job_id: jobId, token_id: tokenId }, "0");
          pageStatus("Accept sent. It will show here once the chain confirms it.");
          setMsg("Accepted. Reload to see the new state.");
          await loadJobs();
        } catch (e) {
          const r = reportFailure(e);
          setMsg(r.text);
        } finally {
          btn.disabled = false;
        }
      });
      card.querySelector(".completeBtn").addEventListener("click", async () => {
        const tokenId = meritInput.value.trim();
        if (!walletAccountId) { pageStatus("Connect your wallet first."); return; }
        if (!tokenId) { setMsg("Enter a Merit token id first."); return; }
        const btn = card.querySelector(".completeBtn");
        btn.disabled = true;
        setMsg("Sending complete…");
        try {
          pageStatus("Sending complete. Confirm in your wallet.");
          await walletCall(contractId(), "complete_job", { job_id: jobId, token_id: tokenId }, "0");
          pageStatus("Complete sent. Payment lands in the Merit account once the chain confirms it.");
          setMsg("Completed. Reload to see the new state.");
          await loadJobs();
        } catch (e) {
          const r = reportFailure(e);
          setMsg(r.text);
        } finally {
          btn.disabled = false;
        }
      });
    });
  } catch (e) {
    list.innerHTML = "<p class=\"muted\">Could not load jobs. " + escapeHtml(e.message || String(e)) + "</p>";
  }
}

document.getElementById("createJobForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const btn = el("createJobBtn");
  if (!walletAccountId) { pageStatus("Connect your wallet first."); return; }
  const jobId = el("jobId").value.trim();
  if (!jobId) { pageStatus("Enter a job id."); return; }
  const title = el("jobTitle").value.trim();
  const description = el("jobDesc").value.trim();
  let requiredStamps;
  try { requiredStamps = parseRequiredStamps(el("jobStamps").value); } catch (e) { pageStatus(e.message); return; }
  const completionSkill = el("jobCompletionSkill").value.trim();
  const completionLevel = parseInt(el("jobCompletionLevel").value, 10);
  if (!completionSkill) { pageStatus("Enter a completion stamp skill."); return; }
  if (!Number.isInteger(completionLevel) || completionLevel < 1 || completionLevel > 3) { pageStatus("Completion stamp level must be 1 to 3."); return; }
  const criteria = el("jobCriteria").value.trim();
  if (!criteria) { pageStatus("Enter the acceptance criteria."); return; }
  let payment;
  try { payment = nearToYocto(el("jobPayment").value); } catch (e) { pageStatus(e.message); return; }
  if (payment <= 0n) { pageStatus("Enter a payment above zero."); return; }
  const call = buildCreateJobCall(jobId, title, description, requiredStamps, { skill: completionSkill, level: completionLevel }, criteria, payment.toString());
  btn.disabled = true;
  pageStatus("Sending job. Confirm in your wallet. The payment is held in escrow.");
  try {
    await walletCall(contractId(), call.method, call.args, call.depositYocto, call.gas);
    pageStatus("Job sent. It will appear here once the chain confirms it.");
    await loadJobs();
  } catch (e) {
    reportFailure(e);
  } finally {
    btn.disabled = false;
  }
});

window.meritWalletChanged = function () { /* list does not depend on the wallet */ };
loadJobs();
