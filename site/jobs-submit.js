// Submit your job: the worker's own page for the jobs they have
// taken. It lists the connected wallet's Accepted jobs (the worker
// Merit is owned by the connected account), each with the evidence
// form, so the finished work is submitted from one place instead of
// hunting for the job card under Job offers. Reuses the shared job
// helpers and the shared evidence form from jobs.js.
async function loadSubmitJobs() {
  const listEl = el("submitJobList");
  if (!listEl) return;
  if (!walletAccountId) {
    listEl.innerHTML = "<div class=\"panel\"><p style=\"margin:0\">Connect your wallet first.</p></div>";
    return;
  }
  listEl.innerHTML = "<p class=\"muted loading\">Loading your accepted jobs from the chain. This can take up to 30 seconds.</p>";
  let jobs = null;
  try {
    jobs = await withTimeout(view("list_jobs", { from_index: "0", limit: 50 }), 20000, "Loading the job list") || [];
    writeJobsCache(jobs);
  } catch (e) {
    const cached = readJobsCache();
    if (cached) jobs = cached.jobs;
  }
  if (!jobs) {
    listEl.innerHTML = "<p class=\"muted\">Could not load your accepted jobs.</p><button type=\"button\" class=\"btn secondary\" id=\"submitRetryBtn\">Try again</button>";
    const rb = el("submitRetryBtn");
    if (rb) rb.addEventListener("click", loadSubmitJobs);
    return;
  }
  const accepted = jobs.filter((j) => jobStatus(j) === "Accepted");
  // The worker is the Merit that took the job. Only jobs whose
  // worker Merit is owned by the connected account belong here.
  const mine = [];
  for (const job of accepted) {
    const worker = jobWorker(job);
    if (!worker) continue;
    try {
      const tok = await view("nft_token", { token_id: worker });
      if (tok && tok.owner_id === walletAccountId) mine.push(job);
    } catch (_) { /* a token the chain cannot read is not yours */ }
  }
  if (!mine.length) {
    listEl.innerHTML = "<div class=\"panel\"><p style=\"margin:0\">You have no accepted jobs yet. Take one from <a href=\"jobs-offers.html\"><strong>Job offers</strong></a> and it will appear here, ready for your evidence.</p></div>";
    return;
  }
  listEl.innerHTML = "<div class=\"grid\">" + mine.map((job) => {
    const worker = jobWorker(job);
    return "<div class=\"card\" data-job-id=\"" + escapeHtml(job.job_id) + "\">" +
      "<div class=\"job-card-top\"><div class=\"label\">" + escapeHtml(job.title || job.job_id) + "</div><span class=\"chip status\">Accepted</span></div>" +
      jobTypeHtml(job) +
      jobPayBannerHtml(job) +
      jobDescriptionHtml(job) +
      jobFactsHtml(job, "Accepted", { hidePay: true }) +
      (worker ? "<div class=\"kv\"><span>Worker</span><b><a class=\"mono\" href=\"merit.html?id=" + encodeURIComponent(worker) + "\">" + escapeHtml(worker) + "</a></b></div>" : "") +
      "<p><strong>Acceptance criteria</strong><br>" + escapeHtml(job.criteria || "Not posted yet.") + "</p>" +
      (job.worker_evidence ? "<div class=\"evidence-row\"><p class=\"small\"><strong>Worker evidence:</strong> " + evidenceHashHtml(job.worker_evidence) + (job.worker_evidence_ref ? " <button type=\"button\" class=\"btn secondary viewEvidenceBtn\" data-side=\"worker\">View evidence</button>" : "") + "</p><div class=\"evidenceContent\" aria-live=\"polite\"></div></div>" : "") +
      "<p class=\"muted small\">Job <span class=\"mono\">" + escapeHtml(job.job_id) + "</span> \u2022 Posted by <span class=\"mono\">" + escapeHtml(job.poster || "unknown") + "</span></p>" +
      (job.worker_evidence
        ? "<p class=\"muted small\">Evidence already submitted for this job. The poster reviews it, or the DAO judges it if the job is disputed.</p>"
        : evidenceFormHtml()) +
      "</div>";
  }).join("") + "</div>";
  listEl.querySelectorAll(".card").forEach((card) => {
    const j = mine.find((x) => x.job_id === card.getAttribute("data-job-id"));
    if (j) wireEvidenceForm(card, j, loadSubmitJobs);
  });
}

// A wallet change re-reads the submit list: which jobs are yours
// depends on the connected account.
window.meritWalletChanged = function () { loadJobs(); loadSubmitJobs(); };
loadSubmitJobs();
