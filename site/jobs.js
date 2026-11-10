// Job board: the Jobs hub (jobs.html) plus the three job pages
// (jobs-create.html, jobs-offers.html, jobs-completed.html). One
// shared script, page aware: it fetches the job list once and renders
// into whichever containers the current page has, so the hub shows
// only live counts, the offers page shows the searchable open jobs
// and the taken ones, and the completed page shows finished jobs.
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
function setJobsCounts(openCount, doneCount) {
  const openTxt = openCount == null ? "\u2026" : String(openCount);
  const doneTxt = doneCount == null ? "\u2026" : String(doneCount);
  if (el("jobsOpenCount")) el("jobsOpenCount").textContent = openTxt;
  if (el("jobsDoneCount")) el("jobsDoneCount").textContent = doneTxt;
  if (el("jobsOffersBadge")) el("jobsOffersBadge").textContent = openCount == null ? "\u2026" : openCount + (openCount === 1 ? " open" : " open");
  if (el("jobsDoneBadge")) el("jobsDoneBadge").textContent = doneCount == null ? "\u2026" : doneCount + " done";
}
function jobTimeoutText(job) {
  try {
    const ns = BigInt(job.timeout_ns || "0");
    if (ns <= 0n) return "";
    const secs = Number(ns / 1000000000n);
    if (secs >= 86400) return Math.round(secs / 86400) + (Math.round(secs / 86400) === 1 ? " day" : " days") + " after the job is taken";
    if (secs >= 3600) return Math.round(secs / 3600) + (Math.round(secs / 3600) === 1 ? " hour" : " hours") + " after the job is taken";
    if (secs >= 60) return Math.round(secs / 60) + (Math.round(secs / 60) === 1 ? " minute" : " minutes") + " after the job is taken";
    return secs + " seconds after the job is taken";
  } catch (_) { return ""; }
}
function jobDeadlineText(job) {
  if (job.deadline) return fmtNsDate(job.deadline);
  const t = jobTimeoutText(job);
  return t ? t : "Not recorded onchain";
}
function jobWorker(job) {
  return job.accepted_by || job.worker || job.taken_by || job.worker_id || null;
}
function fmtNsDate(ns) {
  try {
    const ms = Number(BigInt(ns) / 1000000n);
    return new Date(ms).toLocaleString();
  } catch (_) { return String(ns); }
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
    out.push({ skill: skill, min_level: level });
  }
  return out;
}
function buildCreateJobCall(jobId, title, description, requiredStamps, completionStamp, criteria, paymentYocto, timeoutNs) {
  const args = {
    job_id: jobId,
    title: title,
    description: description,
    required_stamps: requiredStamps.map((s) => ({ skill: s.skill, min_level: (s.min_level != null ? s.min_level : s.level) })),
    completion_stamp: completionStamp,
    criteria: criteria,
  };
  if (timeoutNs != null) args.timeout_ns = timeoutNs;
  return {
    method: "create_job",
    args: args,
    depositYocto: paymentYocto,
    gas: window.GAS_150,
  };
}
// The gate check, onchain, plus whether the Merit is blank and
// exactly which required stamps it is missing, so a refusal can
// name the stamp instead of saying only that the door stayed shut.
async function checkGate(tokenId, job) {
  let stamps = [];
  let blank = false;
  try {
    const m = await view("get_merit", { token_id: tokenId });
    stamps = Array.isArray(m.stamps) ? m.stamps : [];
    blank = stamps.length === 0;
  } catch (_) { blank = true; }
  const ok = await view("can_access", { token_id: tokenId, job_id: job.job_id, account_id: walletAccountId || "" });
  const required = normStamps(job);
  const missing = required.filter((req) => {
    const held = stamps.find((s) => String(s.skill).toLowerCase() === String(req.skill).toLowerCase());
    return !held || (Number(held.level) || 0) < req.level;
  });
  return { ok: !!ok, blank: blank, missing: missing };
}
function jobFactsHtml(job, status, opts) {
  const hidePay = !!(opts && opts.hidePay);
  const stamps = normStamps(job);
  const stampText = stamps.length ? stamps.map((s) => escapeHtml(s.skill) + " level " + escapeHtml(String(s.level))).join(", ") : "No stamp needed";
  const cs = job.completion_stamp || job.completionStamp || null;
  return (hidePay ? "" : "<div class=\"kv\"><span>Pay " + (status === "Completed" ? "paid" : "(in escrow)") + "</span><b>" + escapeHtml(fmtYocto(jobPaymentYocto(job))) + " NEAR</b></div>") +
    "<div class=\"kv\"><span>Stamp required</span><b>" + stampText + "</b></div>" +
    (cs && cs.skill ? "<div class=\"kv\"><span>" + (status === "Completed" ? "Stamp issued" : "Completion stamp") + "</span><b>" + escapeHtml(cs.skill) + " level " + escapeHtml(String(cs.level != null ? cs.level : 1)) + "</b></div>" : "") +
    "<div class=\"kv\"><span>Deadline</span><b>" + escapeHtml(jobDeadlineText(job)) + "</b></div>";
}
function jobPayBannerHtml(job) {
  return "<div class=\"job-pay-banner\"><span class=\"pay-label\">Pay:</span><span class=\"pay-amount\">" + escapeHtml(fmtYocto(jobPaymentYocto(job))) + " NEAR</span><span class=\"pay-note\">held in escrow until the work completes</span></div>";
}

// ---- Job offers search: live filter by title and by skill / type ----
let cachedOpenJobs = [];
let jobSearchQuery = "";
function normSearchText(s) { return String(s == null ? "" : s).toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim(); }
function jobSearchHaystack(job) {
  const parts = [job.title || "", job.job_id || "", job.description || "", job.criteria || ""];
  for (const s of normStamps(job)) parts.push(String(s.skill || ""));
  const cs = job.completion_stamp || job.completionStamp || null;
  if (cs && cs.skill) parts.push(String(cs.skill));
  return normSearchText(parts.join(" "));
}
function jobMatchesSearch(job, rawQuery) {
  const q = normSearchText(rawQuery);
  if (!q) return true;
  const hay = jobSearchHaystack(job);
  return q.split(" ").every((tok) => hay.indexOf(tok) >= 0);
}
function clearJobSearch() {
  const input = el("jobSearchInput");
  if (input) { input.value = ""; try { input.focus(); } catch (_) {} }
  jobSearchQuery = "";
  renderOpenJobs();
}
function renderOpenJobs() {
  const offersEl = el("jobList");
  if (!offersEl) return;
  const input = el("jobSearchInput");
  if (input) jobSearchQuery = input.value;
  const total = cachedOpenJobs.length;
  const filtered = cachedOpenJobs.filter((j) => jobMatchesSearch(j, jobSearchQuery));
  const clearBtn = el("jobSearchClear");
  if (clearBtn) clearBtn.hidden = !String(jobSearchQuery || "").trim();
  const statusEl = el("jobSearchStatus");
  if (statusEl) {
    if (!total) statusEl.textContent = "";
    else if (!String(jobSearchQuery || "").trim()) statusEl.textContent = "Showing all " + total + (total === 1 ? " open offer." : " open offers.");
    else statusEl.textContent = "Showing " + filtered.length + " of " + total + " open offers for \u201C" + String(jobSearchQuery).trim() + "\u201D.";
  }
  document.querySelectorAll("[data-job-search-chip]").forEach((btn) => {
    const v = btn.getAttribute("data-job-search-chip") || "";
    const active = normSearchText(v) === normSearchText(jobSearchQuery);
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  });
  if (!total) {
    offersEl.innerHTML = "<div class=\"panel\"><p style=\"margin:0\">No open offers right now. Post one from <a href=\"jobs-create.html\"><strong>Create job</strong></a> and it will appear here, gated by the stamp it requires.</p></div>";
    return;
  }
  if (!filtered.length) {
    offersEl.innerHTML = "<div class=\"panel\"><p style=\"margin:0 0 8px\"><strong>No open jobs match \u201C" + escapeHtml(String(jobSearchQuery).trim()) + "\u201D.</strong></p><p class=\"muted\" style=\"margin:0 0 12px\">Try a skill like welding, torch-work, gate-welding or repair-welding, or part of a job title.</p><button type=\"button\" class=\"btn secondary\" id=\"jobSearchClearInline\">Clear search and show all offers</button></div>";
    const inline = el("jobSearchClearInline");
    if (inline) inline.addEventListener("click", clearJobSearch);
    return;
  }
  offersEl.innerHTML = "<div class=\"grid\">" + filtered.map((job) => {
    const status = jobStatus(job);
    return "<div class=\"card\" data-job-id=\"" + escapeHtml(job.job_id) + "\">" +
      "<div class=\"job-card-top\"><div class=\"label\">" + escapeHtml(job.title || job.job_id) + "</div><span class=\"chip open\">Open</span></div>" +
      jobPayBannerHtml(job) +
      (job.description ? "<p style=\"margin:.1em 0\">" + escapeHtml(job.description) + "</p>" : "") +
      jobFactsHtml(job, status, { hidePay: true }) +
      "<p><strong>Acceptance criteria</strong><br>" + escapeHtml(job.criteria || "Not posted yet.") + "</p>" +
      "<p class=\"muted small\">Job <span class=\"mono\">" + escapeHtml(job.job_id) + "</span> \u2022 Posted by <span class=\"mono\">" + escapeHtml(job.poster || "unknown") + "</span></p>" +
      "<label>Your Merit token id</label>" +
      "<input type=\"text\" class=\"acceptMerit\" placeholder=\"merit-2\" autocomplete=\"off\">" +
      "<p class=\"muted small\" style=\"margin:6px 0 0\">A Merit without the stamp above is refused. Try a blank Merit and the gate will say so plainly.</p>" +
      "<div class=\"vote-row\"><button type=\"button\" class=\"btn secondary checkBtn\">Check access</button>" +
      "<button type=\"button\" class=\"btn acceptBtn\">Take job</button></div>" +
      "<div class=\"msg jobMsg\" aria-live=\"polite\"></div>" +
      "</div>";
  }).join("") + "</div>";
  offersEl.querySelectorAll(".card").forEach((card) => {
    const j = filtered.find((x) => x.job_id === card.getAttribute("data-job-id"));
    wireJobCard(card, j || { job_id: card.getAttribute("data-job-id"), required_stamps: [] });
  });
}
function wireJobCard(card, job) {
  const jobId = card.getAttribute("data-job-id");
  const input = card.querySelector(".acceptMerit");
  const msg = card.querySelector(".jobMsg");
  if (!input || !msg) return;
  const showRefusal = (tokenId, gate) => {
    let why;
    if (gate.blank) {
      why = "Merit " + tokenId + " is blank: it holds no stamps at all, so it cannot take a gated job.";
    } else if (gate.missing && gate.missing.length) {
      const need = gate.missing.map((s) => s.skill + " level " + s.level).join(", ");
      why = "Merit " + tokenId + " does not hold the required stamp for this job. Needs " + need + ".";
    } else {
      why = "Merit " + tokenId + " does not hold the required stamp for this job.";
    }
    msg.innerHTML = "<div class=\"gate-need\">Refused. " + escapeHtml(why) + " No money moved.</div>";
  };
  // One place renders the gate outcome: green and prominent when
  // the Merit unlocks the job, plain and specific when it does not.
  const renderGateOutcome = (tokenId, gate) => {
    if (gate.ok) {
      card.classList.add("gate-open");
      card.classList.remove("gate-closed");
      msg.innerHTML = "<div class=\"granted\">Your Merit unlocks this. " + escapeHtml(tokenId) + " holds the required stamps and can take this job.</div>";
    } else {
      card.classList.add("gate-closed");
      card.classList.remove("gate-open");
      showRefusal(tokenId, gate);
    }
  };
  const runGateCheck = async (tokenId) => {
    msg.innerHTML = "<p class=\"muted loading\">Checking the Merit's stamps onchain…</p>";
    try {
      const gate = await checkGate(tokenId, job);
      renderGateOutcome(tokenId, gate);
      return gate;
    } catch (e) {
      msg.textContent = "Could not check access. " + (e.message || String(e));
      return null;
    }
  };
  // Instant gate: typing a Merit id checks it after a short pause,
  // so the outcome shows without tapping anything.
  let gateTimer = null;
  input.addEventListener("input", () => {
    const tokenId = input.value.trim();
    clearTimeout(gateTimer);
    if (!tokenId) {
      msg.textContent = "";
      card.classList.remove("gate-open", "gate-closed");
      return;
    }
    gateTimer = setTimeout(() => { runGateCheck(tokenId); }, 600);
  });
  const checkBtn = card.querySelector(".checkBtn");
  if (checkBtn) checkBtn.addEventListener("click", async () => {
    const tokenId = input.value.trim();
    if (!tokenId) { msg.textContent = "Enter a Merit token id first."; return; }
    await runGateCheck(tokenId);
  });
  const acceptBtn = card.querySelector(".acceptBtn");
  if (acceptBtn) acceptBtn.addEventListener("click", async () => {
    const tokenId = input.value.trim();
    if (!walletAccountId) { pageStatus("Connect your wallet first."); return; }
    if (!tokenId) { msg.textContent = "Enter a Merit token id first."; return; }
    acceptBtn.disabled = true;
    msg.innerHTML = "<p class=\"muted loading\">Checking the gate first…</p>";
    try {
      let gate = { ok: true, blank: false, missing: [] };
      try { gate = await checkGate(tokenId, job); } catch (_) { /* precheck is best effort; the contract is the gate */ }
      if (!gate.ok) {
        renderGateOutcome(tokenId, gate);
        pageStatus("Refused. This Merit lacks the required stamp. No money moved.");
        return;
      }
      renderGateOutcome(tokenId, gate);
      pageStatus("Sending take job. Confirm in your wallet.");
      await walletCall(contractId(), "accept_job", { job_id: jobId, token_id: tokenId }, "0", window.GAS_100);
      pageStatus("Job taken. It will show here once the chain confirms it.");
      msg.textContent = "Taken. Reloading…";
      loadJobs();
    } catch (e) {
      const r = reportFailure(e);
      msg.textContent = r.text;
    } finally {
      acceptBtn.disabled = false;
    }
  });
  const completeBtn = card.querySelector(".completeBtn");
  if (completeBtn) completeBtn.addEventListener("click", async () => {
    const tokenId = input.value.trim();
    if (!walletAccountId) { pageStatus("Connect your wallet first."); return; }
    if (!tokenId) { msg.textContent = "Enter a Merit token id first."; return; }
    completeBtn.disabled = true;
    try {
      pageStatus("Sending complete. Confirm in your wallet.");
      await walletCall(contractId(), "complete_job", { job_id: jobId, token_id: tokenId }, "0", window.GAS_100);
      pageStatus("Complete sent. Payment lands in the Merit's account once the chain confirms it.");
      msg.textContent = "Completed. Reloading\u2026";
      loadJobs();
    } catch (e) {
      const r = reportFailure(e);
      msg.textContent = r.text;
    } finally {
      completeBtn.disabled = false;
    }
  });
}

async function loadJobs() {
  const offersEl = el("jobList");
  const progressEl = el("jobProgressList");
  const doneEl = el("completedJobList");
  const hasCounts = el("jobsOpenCount") || el("jobsDoneCount") || el("jobsOffersBadge") || el("jobsDoneBadge");
  if (!offersEl && !progressEl && !doneEl && !hasCounts) return;
  try {
    const jobs = await view("list_jobs", {}) || [];
    const openJobs = jobs.filter((j) => jobStatus(j) === "Open");
    const doneJobs = jobs.filter((j) => jobStatus(j) === "Completed");
    const progressJobs = jobs.filter((j) => { const s = jobStatus(j); return s !== "Open" && s !== "Completed"; });
    setJobsCounts(openJobs.length, doneJobs.length);

    // Open offers: rendered through the live search filter.
    cachedOpenJobs = openJobs;
    renderOpenJobs();

    // Taken jobs (accepted / disputed) stay visible under offers.
    if (progressEl) {
      if (!progressJobs.length) {
        progressEl.innerHTML = "";
      } else {
        progressEl.innerHTML = "<h3 class=\"job-subhead\">Already taken: in progress or disputed</h3><div class=\"grid\">" + progressJobs.map((job) => {
          const status = jobStatus(job);
          const worker = jobWorker(job);
          const pid = jobProposalId(job);
          return "<div class=\"card\" data-job-id=\"" + escapeHtml(job.job_id) + "\">" +
            "<div class=\"job-card-top\"><div class=\"label\">" + escapeHtml(job.title || job.job_id) + "</div><span class=\"chip status\">" + escapeHtml(status) + "</span></div>" +
            jobPayBannerHtml(job) +
            (job.description ? "<p style=\"margin:.1em 0\">" + escapeHtml(job.description) + "</p>" : "") +
            jobFactsHtml(job, status, { hidePay: true }) +
            (worker ? "<div class=\"kv\"><span>Worker</span><b><a class=\"mono\" href=\"merit.html?id=" + encodeURIComponent(worker) + "\">" + escapeHtml(worker) + "</a></b></div>" : "") +
            "<p><strong>Acceptance criteria</strong><br>" + escapeHtml(job.criteria || "Not posted yet.") + "</p>" +
            (job.poster_evidence ? "<p class=\"small\"><strong>Poster evidence</strong><br><span class=\"mono\">" + escapeHtml(job.poster_evidence) + "</span></p>" : "") +
            (job.worker_evidence ? "<p class=\"small\"><strong>Worker evidence</strong><br><span class=\"mono\">" + escapeHtml(job.worker_evidence) + "</span></p>" : "") +
            (status === "Disputed" ? "<p><a href=\"dao.html" + (pid != null ? "#proposal-" + escapeHtml(String(pid)) : "") + "\">See this dispute in the DAO proposals" + (pid != null ? " (proposal " + escapeHtml(String(pid)) + ")" : "") + "</a></p>" : "") +
            "<p class=\"muted small\">Job <span class=\"mono\">" + escapeHtml(job.job_id) + "</span> \u2022 Arbiter <span class=\"mono\">" + escapeHtml(job.arbiter || window.DAO_ID) + "</span></p>" +
            "<label>Your Merit token id</label>" +
            "<input type=\"text\" class=\"acceptMerit\" placeholder=\"merit-2\" autocomplete=\"off\">" +
            "<div class=\"vote-row\"><button type=\"button\" class=\"btn secondary completeBtn\">Mark complete</button></div>" +
            "<div class=\"msg jobMsg\" aria-live=\"polite\"></div>" +
            "</div>";
        }).join("") + "</div>";
        progressEl.querySelectorAll(".card").forEach((card) => {
          const j = progressJobs.find((x) => x.job_id === card.getAttribute("data-job-id"));
          wireJobCard(card, j || { job_id: card.getAttribute("data-job-id"), required_stamps: [] });
        });
      }
    }

    // Completed jobs and their outcomes.
    if (doneEl) {
      if (!doneJobs.length) {
        doneEl.innerHTML = "<div class=\"panel\"><p style=\"margin:0\">No completed jobs yet. When a taken job is marked complete, its pay, the stamp it issued and its worker will be recorded here.</p></div>";
      } else {
        doneEl.innerHTML = "<div class=\"grid\">" + doneJobs.map((job) => {
          const cs = job.completion_stamp || job.completionStamp || null;
          const worker = jobWorker(job);
          const stampText = cs && cs.skill ? escapeHtml(cs.skill) + " level " + escapeHtml(String(cs.level != null ? cs.level : 1)) : "No stamp recorded";
          const csLevel = cs && cs.level != null ? cs.level : 1;
          return "<div class=\"card\">" +
            "<div class=\"job-card-top\"><div class=\"label\">" + escapeHtml(job.title || job.job_id) + "</div><span class=\"chip status\">Completed</span></div>" +
            (job.description ? "<p style=\"margin:.1em 0\">" + escapeHtml(job.description) + "</p>" : "") +
            "<div class=\"kv\"><span>Amount paid</span><b>" + escapeHtml(fmtYocto(jobPaymentYocto(job))) + " NEAR</b></div>" +
            "<div class=\"kv\"><span>Stamp issued</span><b>" + stampText + "</b></div>" +
            "<div class=\"kv\"><span>Worker</span><b>" + (worker ? "<a class=\"mono\" href=\"merit.html?id=" + encodeURIComponent(worker) + "\">" + escapeHtml(worker) + "</a>" : "Not recorded onchain") + "</b></div>" +
            "<div class=\"kv\"><span>Deadline</span><b>" + escapeHtml(jobDeadlineText(job)) + "</b></div>" +
            "<div class=\"outcome-row\"><div class=\"stamp-seal " + sealClass(csLevel) + "\">" + levelEmblem(csLevel) + "</div><div><strong>" + escapeHtml(fmtYocto(jobPaymentYocto(job))) + " NEAR paid</strong> out of escrow \u2022 <strong>" + stampText + "</strong> stamped" + (worker ? " onto <span class=\"mono\">" + escapeHtml(worker) + "</span>" : "") + ".</div></div>" +
            "<p class=\"muted small\" style=\"margin-bottom:0\">Job <span class=\"mono\">" + escapeHtml(job.job_id) + "</span> \u2022 Posted by <span class=\"mono\">" + escapeHtml(job.poster || "unknown") + "</span></p>" +
            "</div>";
        }).join("") + "</div>";
      }
    }
  } catch (e) {
    setJobsCounts(null, null);
    cachedOpenJobs = [];
    const st = el("jobSearchStatus"); if (st) st.textContent = "";
    if (offersEl) offersEl.innerHTML = "<p class=\"muted\">Could not load job offers. " + escapeHtml(e.message || String(e)) + "</p>";
    if (progressEl) progressEl.innerHTML = "";
    if (doneEl) doneEl.innerHTML = "<p class=\"muted\">Could not load completed jobs. " + escapeHtml(e.message || String(e)) + "</p>";
  }
}

// Wire the offers search: typing filters live, Clear and the quick
// chips reset or set the query. The input itself is static HTML, so
// the query survives the re-renders loadJobs triggers.
(function wireJobSearch() {
  const input = el("jobSearchInput");
  if (input) input.addEventListener("input", () => renderOpenJobs());
  const clear = el("jobSearchClear");
  if (clear) clear.addEventListener("click", clearJobSearch);
  document.querySelectorAll("[data-job-search-chip]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const v = btn.getAttribute("data-job-search-chip") || "";
      const inp = el("jobSearchInput");
      if (inp) inp.value = v;
      jobSearchQuery = v;
      renderOpenJobs();
      if (inp && v) { try { inp.focus(); } catch (_) {} }
    });
  });
})();

// Create job form (only present on the Create job page).
(function wireCreateJobForm() {
  const form = el("createJobForm");
  if (!form) return;
  form.addEventListener("submit", async (ev) => {
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
    // Deadline is optional. When given, it becomes a timeout in
    // nanoseconds from now, which the contract takes as timeout_ns.
    let timeoutNs = null;
    const deadlineEl = el("jobDeadline");
    const deadlineVal = deadlineEl ? deadlineEl.value : "";
    if (deadlineVal) {
      const ms = new Date(deadlineVal + "T00:00:00Z").getTime();
      if (Number.isNaN(ms)) { pageStatus("Pick a valid deadline date."); return; }
      const diffMs = ms - Date.now();
      if (diffMs <= 0) { pageStatus("The deadline must be in the future."); return; }
      timeoutNs = (BigInt(diffMs) * 1000000n).toString();
    }
    const call = buildCreateJobCall(jobId, title, description, requiredStamps, { skill: completionSkill, level: completionLevel }, criteria, payment.toString(), timeoutNs);
    btn.disabled = true;
    pageStatus("Sending job. Confirm in your wallet. The payment is held in escrow.");
    try {
      await walletCall(contractId(), call.method, call.args, call.depositYocto, call.gas);
      pageStatus("Job sent. It will appear under Job offers once the chain confirms it.");
      await loadJobs();
    } catch (e) {
      reportFailure(e);
    } finally {
      btn.disabled = false;
    }
  });
})();

window.meritWalletChanged = function () { /* lists do not depend on the wallet */ };
loadJobs();
