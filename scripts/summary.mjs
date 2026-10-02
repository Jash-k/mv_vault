import fs from 'node:fs';
const mode = process.argv[2];
if (!/^[a-z]+$/.test(mode)) throw new Error('Invalid mode');
let summary = `## Vault: ${mode}\n\n`;
try {
 const r = JSON.parse(fs.readFileSync(`.runs/${mode}/candidate/result.json`));
 summary += `- Source SHA: ${r.sourceSha}\n- Degraded: **${r.degraded}**\n- Duration: ${r.durationSeconds}s\n- Due backlog: ${r.backlog}\n- Requests: ${r.http.requests}\n`;
 if (r.archive) summary += `- A–Z: cycle ${r.archive.cycle}, letter ${r.archive.letter}, next listing page ${r.archive.page}\n`;
 summary += '\n```json\n' + JSON.stringify(r.counts, null, 2) + '\n```\n';
 if (r.problems.length) summary += '\nProblems:\n' + r.problems.map(p => '- ' + p).join('\n') + '\n';
 summary += '\nThis report describes the candidate. Check the Publish step for whether it reached the default branch.\n';
} catch { summary += 'No final report: inspect the failed step and diagnostic artifact. Candidate was not approved.\n'; }
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
console.log(summary);
