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
// Completion skills the DAO registry holds. The create form offers
// these as suggestions, but a poster may type any job type. A job can
// only promise a completion stamp the registry knows, so an
// unregistered skill is offered a DAO request instead of a job. The
// contract remains the enforcer: create_job rejects a skill that is
// not registered, whatever the form does.
const COMPLETION_SKILLS_FALLBACK = ["welding", "torch-work", "gate-welding", "repair-welding", "merit-basics", "coding", "design", "writing", "data-entry"];
let completionSkills = null;
async function loadCompletionSkills() {
  if (completionSkills) return completionSkills;
  try {
    const skills = await view("list_completion_skills", {});
    if (Array.isArray(skills) && skills.length) {
      completionSkills = skills.map((s) => String(s).toLowerCase());
      return completionSkills;
    }
  } catch (_) { /* fall through to the fallback list */ }
  completionSkills = COMPLETION_SKILLS_FALLBACK.slice();
  return completionSkills;
}
function fillCompletionSkillsList(skills) {
  const list = el("completionSkillsList");
  if (!list) return;
  list.innerHTML = skills.map((s) => "<option value=\"" + escapeHtml(s) + "\">").join("");
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
// Build the exact cancel call the board sends. Kept separate so the
// headless verifier can check the call without a real wallet.
function buildCancelJobCall(jobId) {
  return {
    method: "cancel_job",
    args: { job_id: jobId },
    depositYocto: "0",
    gas: window.GAS_100,
  };
}
// Build the exact evidence call the board sends. The reference is
// optional: null when the poster or worker posts only a hash.
function buildSubmitEvidenceCall(jobId, evidenceHash, evidenceRef) {
  return {
    method: "submit_evidence",
    args: { job_id: jobId, evidence_hash: evidenceHash, evidence_ref: evidenceRef || null },
    depositYocto: "0",
    gas: window.GAS_100,
  };
}
// The evidence form, shared by the taken job cards on the offers
// page and by the Submit your job page. The worker pastes the
// finished work or picks its file, and the hash is worked out from
// that work in the browser, so the hash is never typed by hand. A
// worker who already has a hash can paste it into the hash field
// instead; a manual entry overrides the computed one.
function evidenceFormHtml() {
  return "<div class=\"panel\" style=\"margin-top:10px\"><h3 style=\"margin-top:0\">Submit evidence</h3>" +
    "<p class=\"muted small\" style=\"margin-top:0\">Post the hash of your evidence, plus a link to the evidence content itself, so the DAO can fetch it and check it against the hash.</p>" +
    "<label>Your finished work</label>" +
    "<textarea class=\"evidenceWork\" rows=\"5\" placeholder=\"Paste your finished work here\"></textarea>" +
    "<label>Or pick the file with your finished work</label>" +
    "<input type=\"file\" class=\"evidenceFile\">" +
    "<p class=\"muted small\">Hash from your work: <span class=\"mono evidenceComputedHash\">Not worked out yet.</span> <button type=\"button\" class=\"btn secondary copyComputedHashBtn\" disabled>Copy</button></p>" +
    "<label>Evidence hash (SHA 256, 64 hex characters)</label>" +
    "<input type=\"text\" class=\"evidenceHash\" placeholder=\"64 hex characters\" autocomplete=\"off\">" +
    "<p class=\"muted small\">The hash is worked out from the work pasted here, so make sure the link below points to the same work. If you already have a hash, paste it into the hash field and it overrides the computed one.</p>" +
    "<label>Evidence reference (optional link to the evidence content)</label>" +
    "<input type=\"text\" class=\"evidenceRef\" placeholder=\"https://example.com/evidence.txt\" autocomplete=\"off\">" +
    "<div class=\"vote-row\"><button type=\"button\" class=\"btn secondary submitEvidenceBtn\">Submit evidence</button></div>" +
    "<div class=\"msg evidenceMsg\" aria-live=\"polite\"></div></div>";
}
// Auto-hash: work out the evidence SHA 256 from the work itself, in
// the browser, so the worker does not type the hash by hand. Pasting
// work into the text area or picking a file computes the hash with
// crypto.subtle.digest (through sha256Hex) and fills the hash field.
// A manual entry in the hash field overrides the computed one, so
// later pasted work does not overwrite a hash the worker pasted.
function wireEvidenceAutoHash(card) {
  const workInput = card.querySelector(".evidenceWork");
  const fileInput = card.querySelector(".evidenceFile");
  const hashInput = card.querySelector(".evidenceHash");
  const computedEl = card.querySelector(".evidenceComputedHash");
  const copyBtn = card.querySelector(".copyComputedHashBtn");
  if (!hashInput) return;
  const showComputed = (hash) => {
    if (computedEl) computedEl.textContent = hash || "Not worked out yet.";
    if (copyBtn) copyBtn.disabled = !hash;
  };
  const applyComputed = (hash) => {
    showComputed(hash);
    if (hashInput.dataset.manual !== "1") hashInput.value = hash;
  };
  let workTimer = null;
  const hashWorkText = () => {
    const text = workInput ? workInput.value : "";
    if (!text.trim()) { showComputed(""); return; }
    try {
      sha256Hex(new TextEncoder().encode(text)).then(applyComputed).catch(() => { showComputed(""); });
    } catch (_) { showComputed(""); }
  };
  if (workInput) {
    workInput.addEventListener("input", () => {
      clearTimeout(workTimer);
      workTimer = setTimeout(hashWorkText, 300);
    });
  }
  if (fileInput) {
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      try {
        const buf = await file.arrayBuffer();
        applyComputed(await sha256Hex(buf));
      } catch (_) { showComputed(""); }
    });
  }
  hashInput.addEventListener("input", () => {
    if (!hashInput.value.trim()) { delete hashInput.dataset.manual; return; }
    hashInput.dataset.manual = "1";
  });
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      const hash = computedEl ? computedEl.textContent.trim() : "";
      if (!hash || hash === "Not worked out yet.") return;
      try { await navigator.clipboard.writeText(hash); copyBtn.textContent = "Copied"; }
      catch (_) { copyBtn.textContent = "Copy failed"; }
      setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
    });
  }
}
// Wire one card's evidence: view the posted evidence inline, and
// submit new evidence. Shared by the taken job cards on the offers
// page and by the Submit your job page. reloadFn re-reads the list
// after a successful submission (loadJobs on offers, the submit
// page loader on the submit page).
function wireEvidenceForm(card, job, reloadFn) {
  wireEvidenceAutoHash(card);
  // View evidence: show the referenced content inline in this card,
  // instead of opening the raw reference in a new tab. A raw data:
  // link opens a blank tab on some phones instead of showing the text.
  card.querySelectorAll(".viewEvidenceBtn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const side = btn.getAttribute("data-side");
      const row = btn.closest(".evidence-row");
      const box = row ? row.querySelector(".evidenceContent") : null;
      const ref = side === "poster" ? job.poster_evidence_ref : job.worker_evidence_ref;
      btn.disabled = true;
      try { await showEvidenceContent(box, ref); }
      finally { btn.disabled = false; }
    });
  });
  // Submit evidence: either side posts the SHA 256 hash of its work
  // plus an optional reference to where the content lives, so the DAO
  // can fetch it and check it against the hash. The result shows in
  // this card's own evidence line, not at the top of the page.
  const jobId = card.getAttribute("data-job-id");
  const evidenceBtn = card.querySelector(".submitEvidenceBtn");
  if (evidenceBtn) evidenceBtn.addEventListener("click", async () => {
    const hashInput = card.querySelector(".evidenceHash");
    const refInput = card.querySelector(".evidenceRef");
    const evMsg = card.querySelector(".evidenceMsg");
    if (!hashInput || !evMsg) return;
    if (!walletAccountId) { evMsg.textContent = "Connect your wallet first."; return; }
    const hash = hashInput.value.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) { evMsg.textContent = "Enter the evidence hash: 64 hex characters, the SHA 256 of the evidence content."; return; }
    const ref = refInput ? refInput.value.trim() : "";
    evidenceBtn.disabled = true;
    evMsg.textContent = "Sending evidence. Confirm in your wallet.";
    try {
      const call = buildSubmitEvidenceCall(jobId, hash, ref || null);
      const evRes = await walletCall(contractId(), call.method, call.args, call.depositYocto, call.gas);
      const evHash = txHashFromWalletResult(evRes);
      evMsg.innerHTML = txStatusHtml("Evidence submitted. It will show here once the chain confirms it.", evHash, "The poster reviews it, or the DAO judges it if the job is disputed.");
      // The list re-reads and re-renders, wiping the card message,
      // so the hash and next step also go to the page status line,
      // where they stay.
      setTxStatus("Evidence submitted. It will show here once the chain confirms it.", evHash, "The poster reviews it, or the DAO judges it if the job is disputed.");
      if (typeof reloadFn === "function") setTimeout(reloadFn, 1500);
    } catch (e) {
      let r = null;
      try { if (typeof classifyFailure === "function") r = classifyFailure(e); } catch (_) { /* fall through */ }
      evMsg.textContent = r ? r.text : "Rejected. " + (e.message || String(e)).slice(0, 200) + " No money moved.";
    } finally {
      evidenceBtn.disabled = false;
    }
  });
}
// Build the exact DAO proposal call that asks the council to add a
// completion skill to the registry. Kept separate so the headless
// verifier can check the call without a real wallet. The proposer
// pays the 1 NEAR bond; the council votes, and once the proposal
// passes the skill can be promised as a completion stamp. The
// proposal is a FunctionCall to the Merit contract's
// add_completion_skill, following the demo's proposal shape.
function buildAddSkillProposalCall(skill) {
  const description = "Add " + skill + " as a completion stamp skill. A poster asked for this job type and the DAO registry does not list it yet. Once this proposal passes, jobs can promise " + skill + " as the completion stamp.";
  return {
    method: "add_proposal",
    args: {
      proposal: {
        description: description,
        kind: {
          FunctionCall: {
            receiver_id: contractId(),
            actions: [{
              method_name: "add_completion_skill",
              args: btoa(JSON.stringify({ skill: skill })),
              deposit: "0",
              gas: window.GAS_100,
            }],
          },
        },
      },
    },
    depositYocto: window.DAO_PROPOSAL_BOND,
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
// The type of a job is the skill it earns: the completion stamp's
// skill. A stranger reading the card should see at a glance what
// kind of work it is, instead of inferring it from the stamp list.
// Falls back to the first required stamp that is not the generic
// merit-basics stamp.
function jobType(job) {
  const cs = job.completion_stamp || job.completionStamp || null;
  if (cs && cs.skill) return String(cs.skill);
  const stamps = normStamps(job).filter((s) => String(s.skill || "").toLowerCase() !== "merit-basics");
  if (stamps.length) return String(stamps[0].skill);
  const all = normStamps(job);
  if (all.length) return String(all[0].skill);
  return "";
}
function jobTypeHtml(job) {
  const type = jobType(job);
  if (!type) return "";
  const label = type.replace(/[-_]+/g, " ").trim();
  const pretty = label ? label.charAt(0).toUpperCase() + label.slice(1) : type;
  return "<p class=\"job-type\" style=\"margin:.1em 0 0\"><span class=\"chip\">" + escapeHtml(pretty) + " job</span></p>";
}
// The description of the job: what the work actually is. Labelled
// plainly so a stranger sees at a glance what they are being asked
// to do, instead of a bare paragraph.
function jobDescriptionHtml(job) {
  if (!job.description) return "";
  return "<p style=\"margin:.1em 0\"><strong>What to do</strong><br>" + escapeHtml(job.description) + "</p>";
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
    offersEl.innerHTML = "<div class=\"panel\"><p style=\"margin:0\">No open offers right now. Post one from <a href=\"jobs-create.html\"><strong>Post job</strong></a> and it will appear here, gated by the stamp it requires.</p></div>";
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
    const isPoster = Boolean(walletAccountId) && job.poster === walletAccountId;
    return "<div class=\"card\" data-job-id=\"" + escapeHtml(job.job_id) + "\">" +
      "<div class=\"job-card-top\"><div class=\"label\">" + escapeHtml(job.title || job.job_id) + "</div><span class=\"chip open\">Open</span></div>" +
      jobTypeHtml(job) +
      jobPayBannerHtml(job) +
      jobDescriptionHtml(job) +
      jobFactsHtml(job, status, { hidePay: true }) +
      "<p><strong>Acceptance criteria</strong><br>" + escapeHtml(job.criteria || "Not posted yet.") + "</p>" +
      "<p class=\"muted small\">Job <span class=\"mono\">" + escapeHtml(job.job_id) + "</span> \u2022 Posted by <span class=\"mono\">" + escapeHtml(job.poster || "unknown") + "</span></p>" +
      "<label>Your Merit token id</label>" +
      "<input type=\"text\" class=\"acceptMerit\" placeholder=\"merit-2\" autocomplete=\"off\">" +
      "<p class=\"muted small\" style=\"margin:6px 0 0\">A Merit without the stamp above is refused. Try a blank Merit and the gate will say so plainly.</p>" +
      "<div class=\"vote-row\"><button type=\"button\" class=\"btn secondary checkBtn\">Check access</button>" +
      "<button type=\"button\" class=\"btn acceptBtn\">Take job</button></div>" +
      (isPoster ? "<div class=\"vote-row\"><button type=\"button\" class=\"btn secondary cancelBtn\">Cancel job</button></div>" : "") +
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
  // The token id input exists on offer cards and on taken cards
  // shown to the poster (or with no wallet). A taken card shown to
  // the worker has no input and no complete button, so the gate
  // check and the take and complete actions are skipped below,
  // while evidence and the rest still wire up.
  // The acceptance gate belongs only on open-offer cards, before
  // Take job. On a taken card the gate already passed at accept
  // time, and complete_job is poster-only, so running the gate
  // there can only flash a wrong refusal: the poster is not the
  // worker, so can_access says no for them even when the worker's
  // Merit holds the stamp. The timer and the flag below guard
  // that: completing a job stops any pending or in-flight gate
  // check from writing over the completion result.
  let gateTimer = null;
  let gateDone = false;
  const isOfferCard = !!(card.querySelector(".checkBtn") || card.querySelector(".acceptBtn"));
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
      if (gateDone) return null;
      renderGateOutcome(tokenId, gate);
      return gate;
    } catch (e) {
      if (gateDone) return null;
      msg.textContent = "Could not check access. " + (e.message || String(e));
      return null;
    }
  };
  // Instant gate: typing a Merit id checks it after a short pause,
  // so the outcome shows without tapping anything. Offer cards
  // only: a taken card's input takes the worker's Merit id for
  // Confirm completion, and the gate must never run there.
  if (input && msg && isOfferCard) {
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
  }
  const checkBtn = card.querySelector(".checkBtn");
  if (checkBtn && input && msg) checkBtn.addEventListener("click", async () => {
    const tokenId = input.value.trim();
    if (!tokenId) { msg.textContent = "Enter a Merit token id first."; return; }
    await runGateCheck(tokenId);
  });
  const acceptBtn = card.querySelector(".acceptBtn");
  if (acceptBtn && input && msg) acceptBtn.addEventListener("click", async () => {
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
      const acceptRes = await walletCall(contractId(), "accept_job", { job_id: jobId, token_id: tokenId }, "0", window.GAS_100);
      const acceptHash = txHashFromWalletResult(acceptRes);
      setTxStatus("Job taken. It will show here once the chain confirms it.", acceptHash, "Do the work, then submit evidence and mark it complete.");
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
  if (completeBtn && input && msg) completeBtn.addEventListener("click", async () => {
    const tokenId = input.value.trim();
    if (!walletAccountId) { pageStatus("Connect your wallet first."); return; }
    if (!tokenId) { msg.textContent = "Enter a Merit token id first."; return; }
    completeBtn.disabled = true;
    // Stop any pending or in-flight gate check from writing a
    // refusal over the completion result.
    gateDone = true;
    clearTimeout(gateTimer);
    try {
      pageStatus("Sending complete. Confirm in your wallet.");
      const completeRes = await walletCall(contractId(), "complete_job", { job_id: jobId, token_id: tokenId }, "0", window.GAS_100);
      const completeHash = txHashFromWalletResult(completeRes);
      setTxStatus("Complete sent. Payment lands in the Merit's account once the chain confirms it.", completeHash, "The payment and the completion stamp land in the Merit's account.");
      msg.textContent = "Completed. Reloading\u2026";
      loadJobs();
    } catch (e) {
      const r = reportFailure(e);
      msg.textContent = r.text;
    } finally {
      completeBtn.disabled = false;
    }
  });
  // Cancel: poster only, while the job is Open. The result shows in
  // this card's own message line, not at the top of the page. The
  // list re-reads a moment later, so the job then shows Cancelled.
  const cancelBtn = card.querySelector(".cancelBtn");
  if (cancelBtn && msg) cancelBtn.addEventListener("click", async () => {
    if (!walletAccountId) { msg.textContent = "Connect your wallet first."; return; }
    cancelBtn.disabled = true;
    msg.textContent = "Sending cancel. Confirm in your wallet.";
    try {
      const call = buildCancelJobCall(jobId);
      const cancelRes = await walletCall(contractId(), call.method, call.args, call.depositYocto, call.gas);
      const cancelHash = txHashFromWalletResult(cancelRes);
      msg.innerHTML = txStatusHtml("Job cancelled. The escrow is refunded to the poster.", cancelHash, "The escrow is refunded to the poster once the chain confirms it.");
      // The list re-reads a moment later and re-renders this card,
      // wiping the card message, so the confirmation also goes to
      // the page status line, where the hash and next step stay.
      setTxStatus("Job cancelled. The escrow is refunded to the poster.", cancelHash, "The job now shows Cancelled.");
      setTimeout(loadJobs, 1500);
    } catch (e) {
      let r = null;
      try { if (typeof classifyFailure === "function") r = classifyFailure(e); } catch (_) { /* fall through */ }
      msg.textContent = r ? r.text : "Rejected. " + (e.message || String(e)).slice(0, 200) + " No money moved.";
    } finally {
      cancelBtn.disabled = false;
    }
  });
  // Evidence (view the posted evidence, submit new evidence) is
  // shared with the Submit your job page.
  wireEvidenceForm(card, job, loadJobs);
}

// Cache the last good job list in this session, so a failed reload
// does not silently empty the page. A cached list is shown with a
// note that it is stale, never as if it were fresh.
const JOBS_CACHE_KEY = "merit-jobs-cache";
function readJobsCache() {
  try {
    const c = JSON.parse(sessionStorage.getItem(JOBS_CACHE_KEY) || "null");
    if (c && Array.isArray(c.jobs) && c.jobs.length) return c;
  } catch (_) { /* no usable cache */ }
  return null;
}
function writeJobsCache(jobs) {
  try { sessionStorage.setItem(JOBS_CACHE_KEY, JSON.stringify({ ts: Date.now(), jobs: jobs })); } catch (_) { /* storage unavailable */ }
}
// The hub counters show "…" while the chain answers. When the load
// fails, a Try again button appears under them.
function showJobsCountRetry(show) {
  const btn = el("jobsCountRetry");
  if (btn) btn.hidden = !show;
}
// Every Try again button on the jobs pages re-runs the load.
function wireJobsRetry() {
  document.querySelectorAll(".retryJobsBtn").forEach((btn) => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = "1";
    btn.addEventListener("click", () => loadJobs());
  });
  const c = el("jobsCountRetry");
  if (c && !c.dataset.wired) {
    c.dataset.wired = "1";
    c.addEventListener("click", () => loadJobs());
  }
}

async function loadJobs() {
  const offersEl = el("jobList");
  const progressEl = el("jobProgressList");
  const doneEl = el("completedJobList");
  const hasCounts = el("jobsOpenCount") || el("jobsDoneCount") || el("jobsOffersBadge") || el("jobsDoneBadge");
  if (!offersEl && !progressEl && !doneEl && !hasCounts) return;
  // The list is read with a 20 second timeout. When the chain is
  // slow or unreachable, the last good list is shown instead of an
  // empty page, with a note and a Try again button.
  let jobs = null;
  let stale = false;
  let errMsg = "";
  try {
    jobs = await withTimeout(view("list_jobs", { from_index: "0", limit: 50 }), 20000, "Loading the job list") || [];
    writeJobsCache(jobs);
  } catch (e) {
    errMsg = e.message || String(e);
    const cached = readJobsCache();
    if (cached) { jobs = cached.jobs; stale = true; }
  }
  if (!jobs) {
    setJobsCounts(null, null);
    cachedOpenJobs = [];
    const st = el("jobSearchStatus"); if (st) st.textContent = "";
    const retryBtn = "<button type=\"button\" class=\"btn secondary retryJobsBtn\">Try again</button>";
    if (offersEl) offersEl.innerHTML = "<p class=\"muted\">Could not load job offers. " + escapeHtml(errMsg) + "</p>" + retryBtn;
    if (progressEl) progressEl.innerHTML = "";
    if (doneEl) doneEl.innerHTML = "<p class=\"muted\">Could not load completed jobs. " + escapeHtml(errMsg) + "</p>" + retryBtn;
    wireJobsRetry();
    showJobsCountRetry(true);
    return;
  }
  showJobsCountRetry(false);
  if (stale && offersEl) {
    const notice = document.createElement("p");
    notice.className = "muted small";
    notice.textContent = "Showing the last loaded jobs. The chain could not be reached just now. ";
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn secondary retryJobsBtn";
    b.textContent = "Try again";
    notice.appendChild(b);
    offersEl.prepend(notice);
  }
  wireJobsRetry();
    const openJobs = jobs.filter((j) => jobStatus(j) === "Open");
    const doneJobs = jobs.filter((j) => jobStatus(j) === "Completed");
    const cancelledJobs = jobs.filter((j) => jobStatus(j) === "Cancelled");
    const progressJobs = jobs.filter((j) => { const s = jobStatus(j); return s !== "Open" && s !== "Completed" && s !== "Cancelled"; });
    setJobsCounts(openJobs.length, doneJobs.length);

    // Open offers: rendered through the live search filter.
    cachedOpenJobs = openJobs;
    renderOpenJobs();

    // Taken jobs (accepted / disputed) stay visible under offers.
    // Cancelled jobs show in their own section below them, so a
    // poster who cancels sees the job as Cancelled on the next load.
    if (progressEl) {
      let progressHtml = "";
      if (progressJobs.length) {
        progressHtml += "<h3 class=\"job-subhead\">Already taken: in progress or disputed</h3><div class=\"grid\">" + progressJobs.map((job) => {
          const status = jobStatus(job);
          const worker = jobWorker(job);
          const pid = jobProposalId(job);
          // Confirming completion is the poster's call onchain:
          // complete_job rejects any other caller. The button is
          // only shown, working, to the poster. The worker submits
          // evidence and waits for the poster, or for the deadline.
          const isPoster = !!(walletAccountId && job.poster && walletAccountId === job.poster);
          const isWorker = !!(walletAccountId && worker && walletAccountId === worker);
          let completeHtml = "";
          if (isPoster) {
            completeHtml =
              "<p class=\"muted small\">As the poster, confirm the work is done to release the payment and issue the stamp.</p>" +
              "<label>Worker's Merit token id</label>" +
              "<input type=\"text\" class=\"acceptMerit\" placeholder=\"merit-2\" autocomplete=\"off\">" +
              "<div class=\"vote-row\"><button type=\"button\" class=\"btn secondary completeBtn\">Confirm completion</button></div>";
          } else if (isWorker) {
            completeHtml = "<p class=\"muted small\">You did the work. Submit your evidence below; the poster confirms completion, or the payment releases after the deadline.</p>";
          } else if (!walletAccountId) {
            completeHtml =
              "<label>Worker's Merit token id</label>" +
              "<input type=\"text\" class=\"acceptMerit\" placeholder=\"merit-2\" autocomplete=\"off\">" +
              "<div class=\"vote-row\"><button type=\"button\" class=\"btn secondary completeBtn\" disabled>Confirm completion</button></div>" +
              "<p class=\"muted small\">Connect the poster's wallet to confirm completion.</p>";
          } else {
            completeHtml = "<p class=\"muted small\">Only the poster can confirm completion. The worker submits evidence below.</p>";
          }
          return "<div class=\"card\" data-job-id=\"" + escapeHtml(job.job_id) + "\">" +
            "<div class=\"job-card-top\"><div class=\"label\">" + escapeHtml(job.title || job.job_id) + "</div><span class=\"chip status\">" + escapeHtml(status) + "</span></div>" +
            jobTypeHtml(job) +
            jobPayBannerHtml(job) +
            jobDescriptionHtml(job) +
            jobFactsHtml(job, status, { hidePay: true }) +
            (worker ? "<div class=\"kv\"><span>Worker</span><b><a class=\"mono\" href=\"merit.html?id=" + encodeURIComponent(worker) + "\">" + escapeHtml(worker) + "</a></b></div>" : "") +
            "<p><strong>Acceptance criteria</strong><br>" + escapeHtml(job.criteria || "Not posted yet.") + "</p>" +
            (job.poster_evidence ? "<div class=\"evidence-row\"><p class=\"small\"><strong>Poster evidence:</strong> " + evidenceHashHtml(job.poster_evidence) + (job.poster_evidence_ref ? " <button type=\"button\" class=\"btn secondary viewEvidenceBtn\" data-side=\"poster\">View evidence</button>" : "") + "</p><div class=\"evidenceContent\" aria-live=\"polite\"></div></div>" : "") +
            (job.worker_evidence ? "<div class=\"evidence-row\"><p class=\"small\"><strong>Worker evidence:</strong> " + evidenceHashHtml(job.worker_evidence) + (job.worker_evidence_ref ? " <button type=\"button\" class=\"btn secondary viewEvidenceBtn\" data-side=\"worker\">View evidence</button>" : "") + "</p><div class=\"evidenceContent\" aria-live=\"polite\"></div></div>" : "") +
            (status === "Disputed" ? "<p><a href=\"dao.html" + (pid != null ? "#proposal-" + escapeHtml(String(pid)) : "") + "\">See this dispute in the DAO proposals" + (pid != null ? " (proposal " + escapeHtml(String(pid)) + ")" : "") + "</a></p>" : "") +
            "<p class=\"muted small\">Job <span class=\"mono\">" + escapeHtml(job.job_id) + "</span> \u2022 Arbiter <span class=\"mono\">" + escapeHtml(job.arbiter || window.DAO_ID) + "</span></p>" +
            completeHtml +
            "<div class=\"msg jobMsg\" aria-live=\"polite\"></div>" +
            evidenceFormHtml() +
            "</div>";
        }).join("") + "</div>";
      }
      if (cancelledJobs.length) {
        progressHtml += "<h3 class=\"job-subhead\">Cancelled</h3><div class=\"grid\">" + cancelledJobs.map((job) => {
          return "<div class=\"card\" data-job-id=\"" + escapeHtml(job.job_id) + "\">" +
            "<div class=\"job-card-top\"><div class=\"label\">" + escapeHtml(job.title || job.job_id) + "</div><span class=\"chip status\">Cancelled</span></div>" +
            jobTypeHtml(job) +
            jobDescriptionHtml(job) +
            jobFactsHtml(job, "Cancelled", { hidePay: true }) +
            "<p class=\"muted small\">The escrow was refunded to the poster.</p>" +
            "<p class=\"muted small\">Job <span class=\"mono\">" + escapeHtml(job.job_id) + "</span> \u2022 Posted by <span class=\"mono\">" + escapeHtml(job.poster || "unknown") + "</span></p>" +
            "</div>";
        }).join("") + "</div>";
      }
      progressEl.innerHTML = progressHtml;
      if (progressJobs.length) {
        progressEl.querySelectorAll(".card").forEach((card) => {
          const j = progressJobs.find((x) => x.job_id === card.getAttribute("data-job-id"));
          if (j) wireJobCard(card, j);
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
            jobTypeHtml(job) +
            jobDescriptionHtml(job) +
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

// After the wallet redirects back with a transaction hash, restore
// the skill request result from the session handoff. Without a hash
// the visitor came back without sending, so the handoff is stale.
// The proposal is confirmed onchain before it is claimed as created.
async function restoreSkillRequest() {
  let pending = null;
  try { pending = sessionStorage.getItem("merit-pending-skill-request"); } catch (_) { /* storage unavailable */ }
  if (!pending) return;
  try { sessionStorage.removeItem("merit-pending-skill-request"); } catch (_) { /* storage unavailable */ }
  const params = new URLSearchParams(window.location.search);
  if (!params.get("transactionHashes")) return;
  let skill = "";
  let proposalId = null;
  try {
    const p = JSON.parse(pending);
    skill = p.skill || "";
    proposalId = p.proposalId;
  } catch (_) { return; }
  if (!skill || proposalId == null) return;
  const box = el("skillRequestBox");
  const text = el("skillRequestText");
  const msg = el("skillRequestMsg");
  if (box) box.hidden = false;
  if (text) text.textContent = "You asked the DAO to add \"" + skill + "\" as a completion stamp skill.";
  let line = "The proposal was sent. Confirmation not verified yet. Check the DAO page for the new proposal.";
  try {
    const p = await daoView("get_proposal", { id: proposalId });
    if (p && Number(p.id) === Number(proposalId)) {
      line = "Proposal #" + proposalId + " was created. The DAO council votes on it. Once it passes, " + skill + " can be used when creating a job. See it under DAO.";
    }
  } catch (_) { /* fall through with the unverified line */ }
  if (msg) msg.textContent = line;
  pageStatus(line);
}

// Create job form (only present on the Create job page).
(function wireCreateJobForm() {
  const form = el("createJobForm");
  if (!form) return;
  // Suggest the registered skills as the poster types. The list is
  // read live from the contract; the known skills are the fallback
  // if the read fails.
  loadCompletionSkills().then(fillCompletionSkillsList).catch(() => fillCompletionSkillsList(COMPLETION_SKILLS_FALLBACK));
  restoreSkillRequest();
  const requestBox = el("skillRequestBox");
  const requestText = el("skillRequestText");
  const requestMsg = el("skillRequestMsg");
  const requestBtn = el("requestSkillBtn");
  let pendingSkill = "";
  function showSkillRequest(skill) {
    pendingSkill = skill;
    if (requestText) requestText.textContent = "\"" + skill + "\" is not in the DAO registry yet. Ask the DAO to add it, or pick a registered skill from the suggestions.";
    if (requestMsg) requestMsg.textContent = "";
    if (requestBox) requestBox.hidden = false;
  }
  if (requestBtn) requestBtn.addEventListener("click", async () => {
    const skill = pendingSkill;
    if (!skill) return;
    if (!walletAccountId) { if (requestMsg) requestMsg.textContent = "Connect your wallet first."; return; }
    const call = buildAddSkillProposalCall(skill);
    // The proposal id is the one the DAO will assign next. Read it
    // before sending, so the result can name it.
    let proposalId = null;
    try {
      const nextId = await daoView("get_last_proposal_id", {});
      proposalId = Number(nextId);
    } catch (_) { /* the id is reported after the send instead */ }
    try {
      sessionStorage.setItem("merit-pending-skill-request", JSON.stringify({ skill: skill, proposalId: proposalId }));
    } catch (_) { /* storage unavailable */ }
    requestBtn.disabled = true;
    if (requestMsg) requestMsg.textContent = "Sending proposal. Confirm in your wallet.";
    pageStatus("Sending proposal. Confirm in your wallet. The 1 NEAR bond comes from you.");
    try {
      const propRes = await walletCall(daoId(), call.method, call.args, call.depositYocto, call.gas);
      const propHash = txHashFromWalletResult(propRes);
      // The wallet call resolved in this page (no redirect): show the
      // result here and clear the handoff, so the restore does not
      // repeat it on the next load.
      try { sessionStorage.removeItem("merit-pending-skill-request"); } catch (_) { /* storage unavailable */ }
      const line = proposalId != null
        ? "Proposal #" + proposalId + " was sent. The DAO council votes on it. Once it passes, " + skill + " can be used when creating a job. See it under DAO."
        : "The proposal was sent. The DAO council votes on it. Once it passes, " + skill + " can be used when creating a job. See it under DAO.";
      if (requestMsg) requestMsg.innerHTML = txStatusHtml(line, propHash, null);
      setTxStatus(line, propHash, null);
    } catch (e) {
      try { sessionStorage.removeItem("merit-pending-skill-request"); } catch (_) { /* storage unavailable */ }
      const r = reportFailure(e);
      if (requestMsg) requestMsg.textContent = r.text;
    } finally {
      requestBtn.disabled = false;
    }
  });
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const btn = el("createJobBtn");
    if (!walletAccountId) { pageStatus("Connect your wallet first."); return; }
    const jobId = el("jobId").value.trim();
    if (!jobId) { pageStatus("Enter a job id."); return; }
    const title = el("jobTitle").value.trim();
    const description = el("jobDesc").value.trim();
    if (description.length > 2000) { pageStatus("The description must be 2000 characters or fewer."); return; }
    let requiredStamps;
    try { requiredStamps = parseRequiredStamps(el("jobStamps").value); } catch (e) { pageStatus(e.message); return; }
    if (requiredStamps.length > 10) { pageStatus("A job can require at most 10 stamps."); return; }
    const completionSkill = el("jobCompletionSkill").value.trim().toLowerCase();
    const skillErr = validateSkill(completionSkill);
    if (skillErr) { pageStatus(skillErr); return; }
    const completionLevel = parseInt(el("jobCompletionLevel").value, 10);
    if (!Number.isInteger(completionLevel) || completionLevel < 1 || completionLevel > 3) { pageStatus("Completion stamp level must be 1 to 3."); return; }
    const criteria = el("jobCriteria").value.trim();
    if (!criteria) { pageStatus("Enter the acceptance criteria."); return; }
    let payment;
    try { payment = nearToYocto(el("jobPayment").value); } catch (e) { pageStatus(e.message); return; }
    if (payment <= 0n) { pageStatus("Enter a payment above zero."); return; }
    // The contract rejects a payment below 0.001 NEAR, so the form
    // refuses it before the wallet opens, instead of letting the
    // user confirm and then fail onchain.
    if (payment < nearToYocto("0.001")) { pageStatus("Minimum job payment is 0.001 NEAR."); return; }
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
    // The registry is the gate: a job can only promise a completion
    // stamp the DAO registry knows. An unregistered skill is never
    // sent to create_job. Instead the poster is offered a one tap
    // request to add it, and the job stays unposted.
    let skills;
    try { skills = await loadCompletionSkills(); } catch (_) { skills = COMPLETION_SKILLS_FALLBACK; }
    if (skills.indexOf(completionSkill) < 0) {
      showSkillRequest(completionSkill);
      pageStatus("\"" + completionSkill + "\" is not in the DAO registry yet. Ask the DAO to add it below, or pick a registered skill from the suggestions.");
      return;
    }
    if (requestBox) requestBox.hidden = true;
    const call = buildCreateJobCall(jobId, title, description, requiredStamps, { skill: completionSkill, level: completionLevel }, criteria, payment.toString(), timeoutNs);
    btn.disabled = true;
    pageStatus("Sending job. Confirm in your wallet. The payment is held in escrow.");
    try {
      const jobRes = await walletCall(contractId(), call.method, call.args, call.depositYocto, call.gas);
      const jobHash = txHashFromWalletResult(jobRes);
      setTxStatus("Job sent. It will appear under Job offers once the chain confirms it.", jobHash, "A worker with the required stamp can take it under Job offers.");
      await loadJobs();
    } catch (e) {
      reportFailure(e);
    } finally {
      btn.disabled = false;
    }
  });
})();

// A wallet change re-reads the jobs: the taken cards gate the
// Confirm completion button on the connected account, so they must
// re-render when the wallet connects, changes, or signs out, not
// just the open offers. On pages with no job list this is a no-op.
window.meritWalletChanged = function () { loadJobs(); };
loadJobs();
