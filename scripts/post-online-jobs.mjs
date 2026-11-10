// Post diverse ONLINE jobs to the Merit board (testnet).
// The demo board was all welding (physical trade). These are online
// jobs so the board shows the range of work Merit covers.
// Poster: merit-poster.testnet (key in .testnet-accounts.json).
// Each job requires merit-basics 1 (so merit-2 can take it) and its
// completion stamp is the online skill, so doing the job earns that
// skill's credential. Small testnet pay, escrowed by the poster.
import {
  nearToYocto, loadConfig, loadAccounts, accountFor, rpcView, call,
} from './demo-common.mjs';

const cfg = loadConfig();
const CONTRACT_ID = cfg.contract_id;
const accounts = loadAccounts(cfg);
const poster = await accountFor(accounts, cfg, 'poster');

const getJob = (jobId) => rpcView(cfg, CONTRACT_ID, 'get_job', { job_id: jobId });

const JOBS = [
  {
    job_id: 'online-landing-page',
    title: 'Build a landing page',
    description: 'Build a responsive one-page landing page from the copy the poster supplies.',
    payment_near: '0.5',
    required_stamps: [{ skill: 'merit-basics', min_level: 1 }],
    completion_stamp: { skill: 'coding', level: 1 },
    criteria: 'A responsive landing page matching the supplied copy, with a live link to view it.',
  },
  {
    job_id: 'online-logo-design',
    title: 'Design a logo',
    description: 'Design a logo for a new product, delivered as SVG and PNG.',
    payment_near: '0.3',
    required_stamps: [{ skill: 'merit-basics', min_level: 1 }],
    completion_stamp: { skill: 'design', level: 1 },
    criteria: 'A logo delivered as SVG and PNG, in two variations (light and dark background).',
  },
  {
    job_id: 'online-product-copy',
    title: 'Write a product description',
    description: 'Write a clear 150-word product description for a new listing.',
    payment_near: '0.2',
    required_stamps: [{ skill: 'merit-basics', min_level: 1 }],
    completion_stamp: { skill: 'writing', level: 1 },
    criteria: 'A 150-word product description, clear and plain, no filler.',
  },
  {
    job_id: 'online-data-cleanup',
    title: 'Clean a customer list',
    description: 'Dedupe and standardise a customer list, return a clean CSV.',
    payment_near: '0.2',
    required_stamps: [{ skill: 'merit-basics', min_level: 1 }],
    completion_stamp: { skill: 'data-entry', level: 1 },
    criteria: 'A clean CSV: no duplicate rows, names and emails standardised.',
  },
];

for (const j of JOBS) {
  let existing = null;
  try { existing = await getJob(j.job_id); } catch (e) {
    if (!/job not found/i.test(String(e.message || e))) throw e;
  }
  if (existing) {
    console.log(`job ${j.job_id} already exists (status ${existing.status}), skipping`);
    continue;
  }
  const tx = await call(poster, cfg, CONTRACT_ID, 'create_job', {
    job_id: j.job_id,
    title: j.title,
    description: j.description,
    required_stamps: j.required_stamps,
    completion_stamp: j.completion_stamp,
    criteria: j.criteria,
    // No arbiter: since the audit fix (M-02) the DAO always arbitrates.
  }, { deposit: nearToYocto(j.payment_near) });
  // The tx hash returns before finality; poll until the job is visible.
  let job = null;
  for (let attempt = 1; attempt <= 20; attempt++) {
    try { job = await getJob(j.job_id); break; } catch (e) {
      if (!/job not found/i.test(String(e.message || e))) throw e;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  if (!job) throw new Error(`job ${j.job_id} did not appear after create (tx ${tx})`);
  console.log(`created ${j.job_id}: ${j.title} — ${j.payment_near} NEAR, status ${job.status}, tx ${tx}`);
}
console.log('done');
