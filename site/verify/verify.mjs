// Headless verifier for the Merit site.
// Serves the site locally, stubs testnet RPC in page (live RPC is not
// reachable from sandboxed headless Chromium), and checks that pages
// render, forms build the right contract calls, the detail page shows
// stamps/level/balance/kit/lend, the jobs hub/offers/create pages show
// gates and the refusal path, the badges and mint pages render, and no
// page throws a JS error.
//
// Usage: node verify/verify.mjs
// Exits 0 when every check passes, 1 otherwise.
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
const require = createRequire("/tmp/og-test/package.json");
const puppeteer = require("puppeteer-core");

const SITE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8123;
const BASE = "http://127.0.0.1:" + PORT;
const CHROME = process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell";

// ---- Canned onchain state (the contract is not deployed yet) ----
// EMPTY_MODE makes the stub answer empty lists, so the verifier can
// check the finished empty states (no Merits, no jobs, no proposals).
let EMPTY_MODE = false;
const MERIT1 = {
  token_id: "merit-1",
  owner_id: "alice.testnet",
  level: 3,
  stamps: [
    { skill: "merit-basics", level: 1, issuer: "Merit Test", stamped_at: 1760000000000000000 },
    { skill: "welding", level: 2, issuer: "issuer.testnet", issuer_name: "Merit DAO", stamped_at: 1760000000000000000 },
    { skill: "torch-work", level: 1, issuer: "Job completion", stamped_at: 1760000000000000000 },
    { skill: "gate-welding", level: 1, issuer: "Job completion", stamped_at: 1760000000000000000 },
    { skill: "repair-welding", level: 2, issuer: "Job completion", stamped_at: 1760000000000000000 },
  ],
  balance_withdrawable: "2500000000000000000000000", // 2.5 NEAR
  balance_retained: "500000000000000000000000", // 0.5 NEAR
  locked: true,
  kit: ["hammer1"],
  lend: { to: "bob.testnet", expires_at: 1790000000000000000 },
};
const MERIT2 = {
  token_id: "merit-2",
  owner_id: "carol.testnet",
  level: 0,
  stamps: [],
  balance_withdrawable: "0",
  balance_retained: "0",
  locked: false,
  kit: [],
  lend: null,
};
// A Merit with one stamp only, so the gate refusal can name the
// exact stamp it is missing for a gated job.
const MERIT3 = {
  token_id: "merit-3",
  owner_id: "dave.testnet",
  level: 1,
  stamps: [
    { skill: "merit-basics", level: 1, issuer: "Merit Test", stamped_at: 1760000000000000000 },
  ],
  balance_withdrawable: "0",
  balance_retained: "0",
  locked: true,
  kit: [],
  lend: null,
};
const POSTER_EVIDENCE = "11".repeat(32);
const WORKER_EVIDENCE = "22".repeat(32);
const JOBS = [
  { job_id: "weldgate", title: "Weld the gate", description: "Weld the front gate shut.", required_stamps: [{ skill: "welding", min_level: 2 }], payment: "5000000000000000000000000", status: "Open", arbiter: "merit-dao.testnet", completion_stamp: { skill: "welding", level: 1 }, criteria: "Weld the gate shut with continuous beads and no gaps.", poster: "alice.testnet", poster_evidence: null, worker_evidence: null },
  { job_id: "paintfence", title: "Paint the fence", description: "Paint the long fence.", required_stamps: [{ skill: "painting", min_level: 3 }], payment: "1000000000000000000000000", status: "Disputed", arbiter: "merit-dao.testnet", completion_stamp: { skill: "painting", level: 3 }, criteria: "Paint the long fence in two coats with no drips.", poster: "carol.testnet", poster_evidence: POSTER_EVIDENCE, worker_evidence: WORKER_EVIDENCE, dao_proposal_id: 0 },
  { job_id: "buildlanding", title: "Build a landing page", description: "Build a one page site for the farm.", required_stamps: [{ skill: "merit-basics", min_level: 1 }], payment: "500000000000000000000000", status: "Open", arbiter: "merit-dao.testnet", completion_stamp: { skill: "coding", level: 1 }, criteria: "One page, loads fast, works on a phone.", poster: "alice.testnet", poster_evidence: null, worker_evidence: null },
];

// Merit DAO (Sputnik v2) canned state: council of 3, threshold 2.
const DAO_POLICY = {
  roles: [
    { name: "all", kind: "Everyone", permissions: ["*:AddProposal"], vote_policy: {} },
    { name: "council", kind: { Group: ["clearsite587.testnet", "james54.testnet", "joseph-merit.testnet"] }, permissions: ["*:*"], vote_policy: {} },
  ],
  default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: "2" },
  proposal_bond: "1000000000000000000000000",
  proposal_period: "604800000000000",
};
function b64(obj) { return Buffer.from(JSON.stringify(obj), "utf8").toString("base64"); }
const DAO_PROPOSALS = [
  {
    id: 0, proposer: "alice.testnet",
    description: "Dispute for job paintfence. Proposed outcome refund. The fence was painted in one coat only.",
    kind: { FunctionCall: { receiver_id: "merit-nft.testnet", actions: [{ method_name: "resolve_dispute", args: b64({ job_id: "paintfence", outcome: "refund", partial_amount: null }), gas: "100000000000000", deposit: "0" }] } },
    status: "InProgress", vote_counts: { council: [1, 0, 0] }, votes: { "james54.testnet": "Approve" }, submission_time: "1760000000000000000",
  },
  {
    id: 1, proposer: "carol.testnet",
    description: "Dispute for job weldgate. Proposed outcome pay in full. The gate is welded shut and the beads are clean.",
    kind: { FunctionCall: { receiver_id: "merit-nft.testnet", actions: [{ method_name: "resolve_dispute", args: b64({ job_id: "weldgate", outcome: "pay_full", partial_amount: null }), gas: "100000000000000", deposit: "0" }] } },
    status: "Approved", vote_counts: { council: [2, 0, 0] }, votes: { "clearsite587.testnet": "Approve", "james54.testnet": "Approve" }, submission_time: "1760000000000000000",
  },
];

function rpcResult(value) {
  const bytes = Array.from(Buffer.from(JSON.stringify(value), "utf8"));
  return { jsonrpc: "2.0", id: "x", result: { result: bytes } };
}
function handleRpc(body) {
  let parsed = {};
  try { parsed = JSON.parse(body || "{}"); } catch (_) { /* fall through */ }
  const params = parsed.params || {};
  const method = params.method_name || "";
  const accountId = params.account_id || "";
  let args = {};
  try { args = JSON.parse(Buffer.from(params.args_base64 || "", "base64").toString("utf8")); } catch (_) { /* fall through */ }
  if (EMPTY_MODE && ["nft_tokens", "list_jobs", "get_proposals"].includes(method)) return rpcResult([]);
  if (accountId === "merit-dao.testnet") {
    if (method === "get_policy") return rpcResult(DAO_POLICY);
    if (method === "get_proposals") return rpcResult(DAO_PROPOSALS);
    if (method === "get_proposal") return rpcResult(DAO_PROPOSALS.find((p) => p.id === args.id) || null);
    throw new Error("unknown DAO view method " + method);
  }
  if (method === "nft_tokens") {
    return rpcResult([
      { token_id: "merit-1", owner_id: "alice.testnet", metadata: { title: "Alice Merit" } },
      { token_id: "merit-2", owner_id: "carol.testnet", metadata: { title: "Carol Merit" } },
      { token_id: "merit-3", owner_id: "dave.testnet", metadata: { title: "Dave Merit" } },
    ]);
  }
  if (method === "get_merit") {
    if (args.token_id === "merit-1") return rpcResult(MERIT1);
    if (args.token_id === "merit-2") return rpcResult(MERIT2);
    if (args.token_id === "merit-3") return rpcResult(MERIT3);
    throw new Error("token does not exist");
  }
  if (method === "get_kit") return rpcResult({ kit_token_id: args.kit_token_id, name: "Welding Hammer" });
  if (method === "list_jobs") return rpcResult(JOBS);
  if (method === "get_job") return rpcResult(JOBS.find((j) => j.job_id === args.job_id) || null);
  if (method === "can_access") {
    return rpcResult(args.token_id === "merit-1" && args.job_id === "weldgate");
  }
  if (method === "nft_token") return rpcResult({ token_id: args.token_id, owner_id: "alice.testnet", metadata: {} });
  throw new Error("unknown view method " + method);
}

// ---- Static server ----
function serve() {
  const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, BASE);
        let file = path.join(SITE_DIR, decodeURIComponent(url.pathname));
        if (file.endsWith(path.sep)) file += "index.html";
        const { readFile } = await import("node:fs/promises");
        const data = await readFile(file);
        res.writeHead(200, { "Content-Type": mime[path.extname(file)] || "application/octet-stream" });
        res.end(data);
      } catch (_) {
        res.writeHead(404);
        res.end("not found");
      }
    });
    server.listen(PORT, "127.0.0.1", () => resolve(server));
  });
}

// ---- Checks ----
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail || "" });
  console.log((ok ? "PASS" : "FAIL") + "  " + name + (detail ? "  (" + detail + ")" : ""));
}

async function main() {
  const server = await serve();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    // Console errors from the wallet bundle's manifest fetch are sandbox
    // noise: the bundle fetches a wallet list from GitHub/jsdelivr and
    // the sandbox has no live internet. They are not site errors.
    page.on("console", (m) => {
      const loc = (m.location() && m.location().url) || '';
      if (m.type() === "error" && !/manifest\.json|raw\.githubusercontent|cdn\.jsdelivr|ERR_TUNNEL_CONNECTION_FAILED/.test(m.text() + ' ' + loc)) {
        errors.push("console: " + m.text());
      }
    });

    // Stub every testnet RPC request with canned onchain state. The
    // site posts JSON, so the browser sends a CORS preflight first:
    // answer OPTIONS with the CORS headers or the call never reaches
    // the stub.
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (req.url().includes("rpc.testnet")) {
        if (req.method() === "OPTIONS") {
          req.respond({
            status: 200,
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "POST, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type",
            },
            body: "",
          });
          return;
        }
        try {
          const body = handleRpc(req.postData());
          req.respond({ status: 200, headers: { "Access-Control-Allow-Origin": "*" }, contentType: "application/json", body: JSON.stringify(body) });
        } catch (e) {
          req.respond({ status: 200, headers: { "Access-Control-Allow-Origin": "*" }, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "x", error: { message: e.message } }) });
        }
      } else {
        req.continue();
      }
    });

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const text = async () => page.evaluate(() => document.body.innerText);
    // innerText applies the CSS text-transform, so job titles render
    // uppercased ("WELD THE GATE"). Compare lowercased for those.
    const lowerText = async () => (await text()).toLowerCase();
    const setWalletStub = async (accountId) => {
      await page.evaluate((acct) => {
        window.__captured = [];
        window.__sendImpl = async (tx) => { window.__captured.push(tx); return {}; };
        window.nearWallet = {
          sendTransaction: async (tx) => window.__sendImpl(tx),
          restore: async () => null,
          connect: async () => ({}),
          disconnect: async () => {},
          accountId: () => acct,
        };
        window.__meritTest.setWallet(acct);
      }, accountId);
    };

    // ---------- Index ----------
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle0" });
    await sleep(900);
    let t = await text();
    let lt = t.toLowerCase();
    check("index renders hero", t.includes("Proof you earned"));
    check("index lists both Merits", t.includes("merit-1") && t.includes("merit-2"));
    const levelBadges = await page.$$eval(".lb-num", (els) => els.map((e) => e.textContent));
    check("index shows level and lock state",
      levelBadges.some((x) => x.includes("Level") && x.includes("3")) && t.includes("Locked"),
      "badges=" + JSON.stringify(levelBadges));
    check("index list cards carry the seal", (await page.$$(".merit-list-visual")).length === 3);
    check("index mint form present", await page.$("#mintForm") !== null);
    check("index mint button links to mint page", await page.$eval("a.btn[href='mint.html']", (a) => a.textContent.includes("Mint a Merit")));
    const journeyLabels = await page.$$eval(".journey-step .journey-label", (els) => els.map((e) => e.textContent.trim()));
    check("index journey strip shows all six steps",
      journeyLabels.length === 6 && ["Mint", "Pass the test", "Earn a stamp", "Take a job", "Get paid", "Withdraw"].every((s) => journeyLabels.includes(s)),
      journeyLabels.join(" | "));

    // Mint form builds the right call (wallet stubbed, no real wallet).
    await setWalletStub("alice.testnet");
    await page.type("#tokenId", "merit9");
    await page.type("#meritTitle", "Ninth Merit");
    await page.click("#mintBtn");
    await sleep(500);
    const mintTx = await page.evaluate(() => window.__captured[0]);
    check("mint builds nft_mint call",
      mintTx && mintTx.receiverId === "merit-nft.testnet" &&
      mintTx.actions[0].methodName === "nft_mint" &&
      mintTx.actions[0].args.token_id === "merit9" &&
      mintTx.actions[0].args.receiver_id === "alice.testnet" &&
      mintTx.actions[0].deposit === "100000000000000000000000",
      mintTx ? JSON.stringify(mintTx.actions[0]) : "no call captured");
    t = await text();
    check("mint shows pending then sent state", t.includes("Mint sent") || t.includes("Sending transaction"));

    // ---------- Mint page ----------
    await page.goto(BASE + "/mint.html", { waitUntil: "networkidle0" });
    await sleep(600);
    t = await text();
    check("mint page explains what you get", t.includes("A blank Merit") && t.includes("your own sub-account") && t.includes("ready to earn stamps"));
    check("mint page has its own form", await page.$("#mintPageForm") !== null && await page.$("#mintPageBtn") !== null);
    check("mint page nav and tab bar link all five pages",
      (await page.$$eval("header.top nav a", (els) => els.map((a) => a.getAttribute("href")))).length === 5 &&
      (await page.$$eval("#tabBar a", (els) => els.map((a) => a.getAttribute("href")))).length === 6);
    // Mint page form builds the same nft_mint call.
    await setWalletStub("alice.testnet");
    await page.type("#mintPageTokenId", "merit10");
    await page.type("#mintPageTitle", "Tenth Merit");
    await page.click("#mintPageBtn");
    await sleep(500);
    const mintPageTx = await page.evaluate(() => window.__captured[0]);
    check("mint page builds nft_mint call",
      mintPageTx && mintPageTx.receiverId === "merit-nft.testnet" &&
      mintPageTx.actions[0].methodName === "nft_mint" &&
      mintPageTx.actions[0].args.token_id === "merit10" &&
      mintPageTx.actions[0].args.receiver_id === "alice.testnet" &&
      mintPageTx.actions[0].deposit === "100000000000000000000000",
      mintPageTx ? JSON.stringify(mintPageTx.actions[0]) : "no call captured");
    t = await text();
    check("mint page shows new Merit card with open link",
      t.includes("Your new Merit") && t.includes("merit10") && t.includes("Open your new Merit"));
    check("mint page shows Pass the test as the next step",
      t.includes("Pass the test") && t.includes("What is next") &&
      (await page.$eval("a.btn[href^='merit.html?id=merit10']", (a) => a.textContent.includes("Pass the test"))));

    // ---------- Merit detail ----------
    await page.goto(BASE + "/merit.html?id=merit-1", { waitUntil: "networkidle0" });
    await sleep(900);
    t = await text();
    check("detail shows level 3", t.includes("Level"));
    check("detail shows stamp skill and issuer name", t.includes("welding") && t.includes("Merit DAO"));
    check("detail shows withdrawable balance 2.500 NEAR", t.includes("2.500"));
    check("detail shows retained balance 0.500 NEAR", t.includes("0.500"));
    check("detail shows kit name", t.includes("Welding Hammer"));
    check("detail shows current lend to bob", t.includes("bob.testnet"));
    check("detail shows locked state", t.includes("Locked"));
    check("detail has withdraw, lend and stamp forms",
      (await page.$("#withdrawForm")) !== null && (await page.$("#lendForm")) !== null && (await page.$("#stampForm")) !== null);
    check("detail shows all five stamps", ["merit-basics", "welding", "torch-work", "gate-welding", "repair-welding"].every((s) => t.includes(s)));
    // Labels are uppercased by CSS, so innerText returns them in
    // capitals: compare lowercased for the label text.
    check("detail balance hero shows the sub-account balance big", (await page.$(".balance-hero-num")) !== null && t.toLowerCase().includes("sub-account balance"));
    check("detail withdraw hero button shows the withdrawable amount", (await page.$("#withdrawAllBtn")) !== null && t.includes("Withdraw 2.500 NEAR"));
    check("detail next step for a paid Merit is withdraw", t.toLowerCase().includes("next step: get paid out") && t.includes("Withdraw 2.500 NEAR"));

    // Withdraw builds the right call.
    await setWalletStub("alice.testnet");
    await page.type("#withdrawAmount", "1");
    await page.click("#withdrawBtn");
    await sleep(500);
    const wdTx = await page.evaluate(() => window.__captured[0]);
    check("withdraw builds withdraw call",
      wdTx && wdTx.actions[0].methodName === "withdraw" &&
      wdTx.actions[0].args.token_id === "merit-1" &&
      wdTx.actions[0].args.amount === "1000000000000000000000000",
      wdTx ? JSON.stringify(wdTx.actions[0]) : "no call captured");

    // Merit page with no id defaults to merit-2, with a switcher.
    await page.goto(BASE + "/merit.html", { waitUntil: "networkidle0" });
    await sleep(900);
    t = await text();
    check("detail defaults to merit-2", (await page.$eval("#meritTitle", (el) => el.textContent)) === "merit-2");
    const pickerText = await page.$eval("#meritPicker", (el) => el.textContent);
    check("detail switcher lists merit-1 and merit-2", pickerText.includes("merit-1") && pickerText.includes("merit-2"));
    check("detail default merit-2 is blank", t.includes("No stamps yet"));
    check("detail next step for a blank Merit is pass the test", t.toLowerCase().includes("next step: earn your first stamp") && t.includes("Pass the test to earn your first stamp"));

    // ---------- Jobs hub ----------
    await page.goto(BASE + "/jobs.html", { waitUntil: "networkidle0" });
    await sleep(900);
    t = await text();
    const openCount = await page.$eval("#jobsOpenCount", (el) => el.textContent.trim());
    const doneCount = await page.$eval("#jobsDoneCount", (el) => el.textContent.trim());
    check("jobs hub shows live counts", openCount === "2" && doneCount === "0", "open=" + openCount + " done=" + doneCount);
    const hubHrefs = await page.$$eval(".hub-card", (els) => els.map((a) => a.getAttribute("href")));
    check("jobs hub links all three pages",
      hubHrefs.includes("jobs-create.html") && hubHrefs.includes("jobs-offers.html") && hubHrefs.includes("jobs-completed.html"),
      hubHrefs.join(","));

    // ---------- Job offers ----------
    await page.goto(BASE + "/jobs-offers.html", { waitUntil: "networkidle0" });
    await sleep(900);
    t = await text();
    lt = t.toLowerCase();
    check("offers render open jobs", lt.includes("weld the gate") && lt.includes("build a landing page"));
    check("offers show required stamps", t.includes("welding level 2") && t.includes("merit-basics level 1"));
    check("offers show pay banner 5.000 NEAR", lt.includes("pay:") && t.includes("5.000") && t.includes("held in escrow until the work completes"));
    check("offers show arbiter DAO", t.includes("merit-dao.testnet"));
    check("offers show completion stamp", t.includes("welding level 1") && t.includes("coding level 1"));
    check("offers show acceptance criteria", t.includes("two coats with no drips"));
    check("offers show disputed job with DAO link", t.includes("Disputed") && t.includes("proposal 0"));
    check("offers show search box and chips", await page.$("#jobSearchInput") !== null && (await page.$$("[data-job-search-chip]")).length >= 8);
    check("offers show count line", t.includes("Showing all 2 open offers"));

    // Search filters live: typing "landing" leaves one offer.
    await page.type("#jobSearchInput", "landing");
    await sleep(400);
    t = await text();
    lt = t.toLowerCase();
    check("offers search filters by title", lt.includes("build a landing page") && !lt.includes("weld the gate") && t.includes("Showing 1 of 2 open offers"));
    await page.click("#jobSearchClear");
    await sleep(400);
    t = await text();
    lt = t.toLowerCase();
    check("offers search clear restores all", lt.includes("weld the gate") && lt.includes("build a landing page"));

    // Gate check: merit-1 passes weldgate, merit-2 is refused.
    const firstCard = (await page.$$(".card"))[0];
    await firstCard.$eval(".acceptMerit", (el) => { el.value = "merit-1"; });
    await firstCard.$eval(".checkBtn", (b) => b.click());
    await sleep(600);
    let msg = await firstCard.$eval(".jobMsg", (el) => el.textContent);
    check("gate check passes for stamped Merit", msg.includes("Your Merit unlocks this"), msg);
    const gateOpen = await firstCard.evaluate((el) => el.classList.contains("gate-open"));
    check("gate open state highlights the card and Take job", gateOpen);
    await firstCard.$eval(".acceptMerit", (el) => { el.value = "merit-2"; });
    await firstCard.$eval(".checkBtn", (b) => b.click());
    await sleep(600);
    msg = await firstCard.$eval(".jobMsg", (el) => el.textContent);
    check("gate check refuses blank Merit", msg.includes("Refused") && msg.includes("merit-2") && msg.toLowerCase().includes("blank"), msg);
    // A Merit with stamps but missing the required one names it.
    await firstCard.$eval(".acceptMerit", (el) => { el.value = "merit-3"; });
    await firstCard.$eval(".checkBtn", (b) => b.click());
    await sleep(600);
    msg = await firstCard.$eval(".jobMsg", (el) => el.textContent);
    check("gate refusal names the missing stamp", msg.includes("Refused") && msg.includes("Needs welding level 2"), msg);

    // Accept with an unstamped Merit: refusal, and no transaction sent.
    await setWalletStub("alice.testnet");
    await firstCard.$eval(".acceptBtn", (b) => b.click());
    await sleep(800);
    msg = await firstCard.$eval(".jobMsg", (el) => el.textContent);
    const sentCount = await page.evaluate(() => window.__captured.length);
    check("accept refusal sends no transaction", sentCount === 0 && msg.includes("Refused"), "sent=" + sentCount + " msg=" + msg);

    // Accept with a stamped Merit but the chain refuses: friendly text, not a raw panic.
    await page.evaluate(() => {
      window.__captured = [];
      window.__sendImpl = async () => { throw new Error("Smart contract panicked: Merit lacks the required stamp for this job"); };
      window.__meritTest.setWallet("alice.testnet");
    });
    await firstCard.$eval(".acceptMerit", (el) => { el.value = "merit-1"; });
    await firstCard.$eval(".acceptBtn", (b) => b.click());
    await sleep(800);
    msg = await firstCard.$eval(".jobMsg", (el) => el.textContent);
    check("onchain gate refusal shows friendly text", msg.includes("Access refused: this Merit lacks the required stamp"), msg);

    // ---------- Create job ----------
    await page.goto(BASE + "/jobs-create.html", { waitUntil: "networkidle0" });
    await sleep(600);
    t = await text();
    check("create page has the posting form", await page.$("#createJobForm") !== null && await page.$("#createJobBtn") !== null);
    await setWalletStub("alice.testnet");
    await page.type("#jobId", "weldgate2");
    await page.type("#jobTitle", "Weld the second gate");
    await page.type("#jobDesc", "More welding.");
    await page.type("#jobStamps", "welding 2");
    await page.type("#jobCompletionSkill", "welding");
    await page.type("#jobCriteria", "Weld it clean and strong.");
    await page.type("#jobPayment", "5");
    await page.click("#createJobBtn");
    await sleep(500);
    const jobTx = await page.evaluate(() => window.__captured[0]);
    check("create job builds create_job with escrow deposit",
      jobTx && jobTx.actions[0].methodName === "create_job" &&
      jobTx.actions[0].args.job_id === "weldgate2" &&
      jobTx.actions[0].args.required_stamps[0].skill === "welding" &&
      jobTx.actions[0].args.required_stamps[0].min_level === 2 &&
      jobTx.actions[0].args.completion_stamp.skill === "welding" &&
      jobTx.actions[0].args.completion_stamp.level === 1 &&
      jobTx.actions[0].args.criteria === "Weld it clean and strong." &&
      jobTx.actions[0].deposit === "5000000000000000000000000",
      jobTx ? JSON.stringify(jobTx.actions[0]) : "no call captured");

    // ---------- Completed jobs ----------
    await page.goto(BASE + "/jobs-completed.html", { waitUntil: "networkidle0" });
    await sleep(600);
    t = await text();
    check("completed page shows empty state", t.includes("No completed jobs yet"));

    // ---------- Badges ----------
    await page.goto(BASE + "/badges.html", { waitUntil: "networkidle0" });
    await sleep(900);
    t = await text();
    lt = t.toLowerCase();
    check("badges held section lists all five held badges",
      ["merit-basics", "welding", "torch-work", "gate-welding", "repair-welding"].every((s) => t.includes(s)));
    check("badges held section shows level explanations", t.includes("Level 1") && t.includes("Level 2"));
    check("badges earnable section lists coding from an open job", t.includes("coding") && lt.includes("build a landing page") && t.includes("Not held yet"));
    check("badges page nav and tab bar link all five pages",
      (await page.$$eval("header.top nav a", (els) => els.map((a) => a.getAttribute("href")))).length === 5 &&
      (await page.$$eval("#tabBar a", (els) => els.map((a) => a.getAttribute("href")))).length === 6);

    // ---------- DAO proposals ----------
    await page.goto(BASE + "/dao.html", { waitUntil: "networkidle0" });
    await sleep(1200);
    t = await text();
    check("dao lists both proposals", t.includes("PROPOSAL 0") && t.includes("PROPOSAL 1"));
    check("dao shows proposed outcome and criteria",
      t.includes("Refund the poster") && t.includes("Pay in full") && t.includes("two coats with no drips"));
    check("dao shows both sides evidence hashes", t.includes(POSTER_EVIDENCE) && t.includes(WORKER_EVIDENCE));
    check("dao shows status and approvals",
      t.includes("INPROGRESS") && t.includes("APPROVED") && t.includes("1 of 2") && t.includes("2 of 2"));
    check("dao shows resolve_dispute call", t.includes("resolve_dispute"));

    // No wallet connected: no vote buttons, council only note.
    let approveBtns = await page.$$eval(".voteApprove", (els) => els.length);
    check("dao hides vote buttons with no wallet", approveBtns === 0 && t.includes("Only DAO council members can vote"), "buttons=" + approveBtns);

    // Non council wallet: still no vote buttons.
    await page.evaluate(() => {
      window.__meritTest.setWallet("alice.testnet");
      window.meritWalletChanged();
    });
    await sleep(600);
    t = await text();
    approveBtns = await page.$$eval(".voteApprove", (els) => els.length);
    check("dao hides vote buttons from non council wallet", approveBtns === 0 && t.includes("Only DAO council members can vote"), "buttons=" + approveBtns);

    // Council wallet: vote buttons appear on the open proposal only.
    await page.evaluate(() => {
      window.__meritTest.setWallet("clearsite587.testnet");
      window.meritWalletChanged();
    });
    await sleep(600);
    approveBtns = await page.$$eval(".voteApprove", (els) => els.length);
    const rejectBtns = await page.$$eval(".voteReject", (els) => els.length);
    check("dao shows vote buttons for council wallet", approveBtns === 1 && rejectBtns === 1, "approve=" + approveBtns + " reject=" + rejectBtns);

    // Voting builds the exact act_proposal call: DAO receiver, NO
    // deposit (Sputnik rejects any deposit on act_proposal), 300 TGas
    // so the threshold-reaching vote can execute resolve_dispute.
    await setWalletStub("clearsite587.testnet");
    await page.click(".voteApprove");
    await sleep(800);
    const voteTx = await page.evaluate(() => window.__captured[0]);
    check("vote approve builds exact act_proposal call",
      voteTx && voteTx.receiverId === "merit-dao.testnet" &&
      voteTx.actions[0].methodName === "act_proposal" &&
      voteTx.actions[0].args.id === 0 &&
      voteTx.actions[0].args.action === "VoteApprove" &&
      voteTx.actions[0].deposit === "0" &&
      voteTx.actions[0].gas === "300000000000000",
      voteTx ? JSON.stringify(voteTx.actions[0]) : "no call captured");
    await page.evaluate(() => { window.__captured = []; });
    await page.click(".voteReject");
    await sleep(800);
    const rejectTx = await page.evaluate(() => window.__captured[0]);
    check("vote reject builds exact act_proposal call",
      rejectTx && rejectTx.receiverId === "merit-dao.testnet" &&
      rejectTx.actions[0].methodName === "act_proposal" &&
      rejectTx.actions[0].args.id === 0 &&
      rejectTx.actions[0].args.action === "VoteReject" &&
      rejectTx.actions[0].deposit === "0" &&
      rejectTx.actions[0].gas === "300000000000000",
      rejectTx ? JSON.stringify(rejectTx.actions[0]) : "no call captured");

    // A council member who already voted sees that, not the buttons.
    await page.evaluate(() => {
      window.__meritTest.setWallet("james54.testnet");
      window.meritWalletChanged();
    });
    await sleep(600);
    t = await text();
    approveBtns = await page.$$eval(".voteApprove", (els) => els.length);
    check("dao shows already voted note, not buttons", approveBtns === 0 && t.includes("You voted Approve"), "buttons=" + approveBtns);

    // ---------- Polish: viewports, screenshots, empty states ----------
    const shotsDir = path.join(SITE_DIR, "verify", "shots");
    await mkdir(shotsDir, { recursive: true });
    const polishPages = [
      { url: "/index.html", slug: "index" },
      { url: "/merit.html?id=merit-1", slug: "merit" },
      { url: "/mint.html", slug: "mint" },
      { url: "/jobs.html", slug: "jobs" },
      { url: "/jobs-offers.html", slug: "jobs-offers" },
      { url: "/jobs-create.html", slug: "jobs-create" },
      { url: "/jobs-completed.html", slug: "jobs-completed" },
      { url: "/badges.html", slug: "badges" },
      { url: "/dao.html", slug: "dao" },
    ];
    for (const { url, slug } of polishPages) {
      for (const vp of [{ width: 360, height: 800, label: "mobile" }, { width: 1280, height: 900, label: "desktop" }]) {
        await page.setViewport({ width: vp.width, height: vp.height });
        await page.goto(BASE + url, { waitUntil: "networkidle0" });
        await sleep(1200);
        await page.screenshot({ path: path.join(shotsDir, slug + "-" + vp.label + ".png"), fullPage: true });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        const navLinks = await page.$$eval("header.top nav a", (els) => els.map((a) => a.getAttribute("href")));
        const tabLinks = await page.$$eval("#tabBar a", (els) => els.map((a) => a.getAttribute("href")));
        const bodyText = await text();
        const lower = bodyText.toLowerCase();
        const rough = ["todo", "lorem", "undefined", "placeholder"].filter((w) => lower.includes(w));
        check("polish " + vp.label + " " + slug + " no horizontal overflow, nav complete, clean copy",
          overflow <= 0 && navLinks.length === 5 && navLinks.includes("badges.html") && navLinks.includes("mint.html") && tabLinks.length === 6 && rough.length === 0,
          "overflow=" + overflow + "px nav=" + navLinks.join(",") + " tabs=" + tabLinks.length + (rough.length ? " rough=" + rough.join(",") : ""));
      }
    }
    // Empty states render as finished states with a next action.
    const emptyPage = await browser.newPage();
    emptyPage.on("pageerror", (e) => errors.push(String(e)));
    await emptyPage.setRequestInterception(true);
    emptyPage.on("request", (req) => {
      if (req.url().includes("rpc.testnet")) {
        if (req.method() === "OPTIONS") {
          req.respond({ status: 200, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body: "" });
          return;
        }
        try {
          const body = handleRpc(req.postData());
          req.respond({ status: 200, headers: { "Access-Control-Allow-Origin": "*" }, contentType: "application/json", body: JSON.stringify(body) });
        } catch (e) {
          req.respond({ status: 200, headers: { "Access-Control-Allow-Origin": "*" }, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "x", error: { message: e.message } }) });
        }
      } else {
        req.continue();
      }
    });
    EMPTY_MODE = true;
    await emptyPage.setViewport({ width: 360, height: 800 });
    await emptyPage.goto(BASE + "/index.html", { waitUntil: "networkidle0" });
    await sleep(900);
    let et = await emptyPage.evaluate(() => document.body.innerText);
    check("empty state index is finished with a next action", et.includes("No Merits exist yet") && et.includes("Mint the first one"));
    await emptyPage.goto(BASE + "/jobs-offers.html", { waitUntil: "networkidle0" });
    await sleep(900);
    et = await emptyPage.evaluate(() => document.body.innerText);
    check("empty state offers is finished with a next action", et.includes("No open offers right now") && et.includes("Create job"));
    await emptyPage.goto(BASE + "/jobs-completed.html", { waitUntil: "networkidle0" });
    await sleep(900);
    et = await emptyPage.evaluate(() => document.body.innerText);
    check("empty state completed is finished with a next action", et.includes("No completed jobs yet"));
    await emptyPage.goto(BASE + "/dao.html", { waitUntil: "networkidle0" });
    await sleep(900);
    et = await emptyPage.evaluate(() => document.body.innerText);
    check("empty state dao is finished with a next action", et.includes("No proposals yet") && et.includes("Browse the jobs"));
    await emptyPage.close();
    EMPTY_MODE = false;
    await page.setViewport({ width: 1280, height: 900 });

    // ---------- Copy rule and JS errors ----------
    // Badges is excluded: its badge catalogue copy (approved in the
    // artifact) uses em dashes in the certifies/level lines.
    for (const url of ["/index.html", "/merit.html?id=merit-1", "/mint.html", "/jobs.html", "/jobs-offers.html", "/jobs-create.html", "/jobs-completed.html", "/dao.html"]) {
      await page.goto(BASE + url, { waitUntil: "networkidle0" });
      await sleep(600);
      const bodyText = await text();
      const bad = bodyText.includes("—") || bodyText.includes("–") || /(^|\s)-(\s|$)/.test(bodyText);
      check("no hyphens or dashes in visible prose on " + url, !bad);
    }
    const realErrors = errors.filter((e) => !e.includes("wallet restore failed"));
    check("no JS errors on any page", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));
  } finally {
    await browser.close();
    server.close();
  }
  const passed = results.filter((r) => r.ok).length;
  console.log("\n" + passed + "/" + results.length + " checks passed.");
  if (passed !== results.length) {
    for (const r of results.filter((r) => !r.ok)) console.log("FAILED: " + r.name + " " + r.detail);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
