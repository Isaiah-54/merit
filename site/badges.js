// Badges page: every badge a Merit can carry, in one place.
// Held badges are read live from the stamps onchain; earnable badges
// come from the open jobs' completion stamps, with the four online
// jobs as a fallback if the jobs read fails. Badge design comes from
// the level, never the skill (see common.js seal helpers).
function badgeJobStatus(job) {
  return job.status || (job.accepted_by ? "Accepted" : "Open");
}
function badgeJobPayment(job) {
  return job.payment || job.amount || job.escrow || job.price || "0";
}

async function loadBadges() {
  const wrap = el("badgeGallery");
  const sum = el("badgeSummary");
  try {
    const tokens = await view("nft_tokens", { from_index: "0", limit: 50 }) || [];
    const bySkill = new Map();
    let totalStamps = 0;
    for (const t of tokens) {
      try {
        const m = await view("get_merit", { token_id: t.token_id });
        for (const s of (m.stamps || [])) {
          const key = String(s.skill || "").trim();
          if (!key) continue;
          totalStamps++;
          if (!bySkill.has(key)) bySkill.set(key, { skill: key, issuers: new Set(), holders: [] });
          const rec = bySkill.get(key);
          const iss = s.issuer_name || s.issuer;
          if (iss) rec.issuers.add(String(iss));
          rec.holders.push({ token_id: t.token_id, level: Number(s.level) || 0 });
        }
      } catch (_) { /* a Merit that fails to load simply contributes no stamps */ }
    }
    const recs = Array.from(bySkill.values()).sort((a, b) => {
      const ia = BADGE_ORDER.indexOf(a.skill.toLowerCase()), ib = BADGE_ORDER.indexOf(b.skill.toLowerCase());
      const oa = ia < 0 ? 99 : ia, ob = ib < 0 ? 99 : ib;
      return oa - ob || b.holders.length - a.holders.length || a.skill.localeCompare(b.skill);
    });

    // Earnable badges: completion stamps of the open jobs that no
    // Merit holds yet. Live jobs win; the fallback list keeps the four
    // online badges visible if the jobs read fails.
    const heldKeys = new Set(recs.map((r) => r.skill.toLowerCase()));
    const earnableMap = new Map();
    const addEarnable = (skill, level, jobTitle, jobId, payment) => {
      const key = String(skill || "").trim().toLowerCase();
      if (!key || heldKeys.has(key)) return;
      if (!earnableMap.has(key)) earnableMap.set(key, { skill: String(skill).trim(), level: Number(level) || 1, jobs: [] });
      const rec = earnableMap.get(key);
      if (jobTitle && !rec.jobs.some((j) => j.title === jobTitle)) rec.jobs.push({ title: jobTitle, jobId: jobId || "", payment: payment || null });
    };
    try {
      const jobs = await view("list_jobs", {}) || [];
      for (const job of jobs) {
        if (badgeJobStatus(job) !== "Open") continue;
        const cs = job.completion_stamp || job.completionStamp || null;
        if (cs && cs.skill) addEarnable(cs.skill, cs.level != null ? cs.level : 1, job.title || job.job_id, job.job_id, badgeJobPayment(job));
      }
    } catch (_) { /* jobs unreadable; the fallback below still applies */ }
    for (const f of EARNABLE_FALLBACK) addEarnable(f.skill, f.level, f.jobTitle, "", null);
    const earnables = Array.from(earnableMap.values()).sort((a, b) => {
      const ia = BADGE_ORDER.indexOf(a.skill.toLowerCase()), ib = BADGE_ORDER.indexOf(b.skill.toLowerCase());
      const oa = ia < 0 ? 99 : ia, ob = ib < 0 ? 99 : ib;
      return oa - ob || a.skill.localeCompare(b.skill);
    });

    if (!recs.length && !earnables.length) {
      sum.textContent = "";
      wrap.innerHTML = "<div class=\"panel\"><p style=\"margin:0\">No stamps have been issued yet, so no badges exist onchain. Once a whitelisted issuer stamps a Merit, its badge appears here.</p></div>";
      return;
    }
    const parts = [];
    if (recs.length) parts.push(recs.length + (recs.length === 1 ? " badge type held" : " badge types held") + " \u2022 " + totalStamps + (totalStamps === 1 ? " stamp" : " stamps") + " issued across " + tokens.length + (tokens.length === 1 ? " Merit" : " Merits"));
    if (earnables.length) parts.push(earnables.length + (earnables.length === 1 ? " badge earnable" : " badges earnable") + " from open jobs");
    sum.textContent = parts.join(" \u2022 ") + ".";

    let html = "";
    if (recs.length) {
      html += "<h2 class=\"badge-section-title\">Held badges</h2>" +
        "<p class=\"badge-section-note\">Badges Merits already carry, read live from the stamps onchain.</p>" +
        "<div class=\"badge-grid\">" + recs.map((rec) => {
          const holders = rec.holders.slice().sort((a, b) => b.level - a.level || a.token_id.localeCompare(b.token_id));
          const issuers = Array.from(rec.issuers);
          const holderRows = holders.map((h) => {
            let pips = "";
            for (let i = 0; i < Math.min(h.level, 10); i++) pips += "<i></i>";
            return "<div class=\"holder-row\"><a class=\"mono\" href=\"merit.html?id=" + encodeURIComponent(h.token_id) + "\">" + escapeHtml(h.token_id) + "</a>" +
              "<span class=\"holder-lv\"><span class=\"holder-pips pips-lv" + sealLevelNum(h.level) + "\" aria-hidden=\"true\">" + pips + "</span>Level " + escapeHtml(String(h.level)) + "</span></div>";
          }).join("");
          const levels = Array.from(new Set(rec.holders.map((h) => h.level))).sort((a, b) => a - b);
          const topLevel = levels.length ? levels[levels.length - 1] : 1;
          const levelLines = levels.map((l) =>
            "<div class=\"level-line\"><span class=\"mini-seal " + sealClass(l) + "\" aria-hidden=\"true\">" + levelEmblem(l) + "</span><span class=\"lv-tag lv" + sealLevelNum(l) + "\">Level " + escapeHtml(String(l)) + "</span><span>" + escapeHtml(badgeLevelLine(rec.skill, l)) + "</span></div>").join("");
          return "<div class=\"badge-card\"><div class=\"stamp-seal " + sealClass(topLevel) + "\">" + levelEmblem(topLevel) + "</div>" +
            "<h3>" + escapeHtml(rec.skill) + "</h3>" +
            "<p><span class=\"chip status\">" + holders.length + (holders.length === 1 ? " Merit holds this" : " Merits hold this") + "</span></p>" +
            "<p class=\"certifies\">" + escapeHtml(badgeCertifies(rec.skill)) + "</p>" +
            (levelLines ? "<div class=\"badge-levels\">" + levelLines + "</div>" : "") +
            "<p class=\"issued\">Issued by " + (issuers.length ? issuers.map((i) => "<span class=\"mono\">" + escapeHtml(i) + "</span>").join(", ") : "a whitelisted issuer (name not recorded onchain)") + "</p>" +
            "<div class=\"badge-holders\"><div class=\"bh-label\">Held by</div>" + holderRows + "</div></div>";
        }).join("") + "</div>";
    }
    if (earnables.length) {
      html += "<h2 class=\"badge-section-title\">Earnable badges</h2>" +
        "<p class=\"badge-section-note\">These badges are not held yet. Each one is the completion stamp of an open job. Finish the job and the stamp lands on your Merit.</p>" +
        "<div class=\"badge-grid\">" + earnables.map((rec) => {
          const levelLine = "<div class=\"level-line\"><span class=\"mini-seal " + sealClass(rec.level) + "\" aria-hidden=\"true\">" + levelEmblem(rec.level) + "</span><span class=\"lv-tag lv" + sealLevelNum(rec.level) + "\">Level " + escapeHtml(String(rec.level)) + "</span><span>" + escapeHtml(badgeLevelLine(rec.skill, rec.level)) + "</span></div>";
          const jobRows = rec.jobs.map((j) =>
            "<p style=\"margin:.15em 0\"><a href=\"jobs-offers.html\"><strong>" + escapeHtml(j.title) + "</strong></a>" +
            (j.payment ? ", pays <strong>" + escapeHtml(fmtYocto(j.payment)) + " NEAR</strong>" : "") + "</p>").join("");
          return "<div class=\"badge-card earnable\"><div class=\"stamp-seal " + sealClass(rec.level) + "\">" + levelEmblem(rec.level) + "</div>" +
            "<h3>" + escapeHtml(rec.skill) + "</h3>" +
            "<p><span class=\"chip not-held\">Not held yet</span></p>" +
            "<p class=\"certifies\">" + escapeHtml(badgeCertifies(rec.skill)) + "</p>" +
            "<div class=\"badge-levels\">" + levelLine + "</div>" +
            "<div class=\"earns-from\"><div class=\"ef-label\">Earn it from</div>" + jobRows + "</div>" +
            "<p class=\"not-held-note\">No Merit holds this badge yet. Complete the job above and the stamp is issued to your Merit.</p></div>";
        }).join("") + "</div>";
    }
    wrap.innerHTML = html;
  } catch (e) {
    sum.textContent = "";
    wrap.innerHTML = "<p class=\"muted\">Could not load badges. " + escapeHtml(e.message || String(e)) + "</p>";
  }
}

window.meritWalletChanged = function () { /* badges do not depend on the wallet */ };
loadBadges();
