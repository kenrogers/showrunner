import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectArtifacts, type ArtifactStatus } from '../artifacts.js';
import { legalActions, nextRecommendedAction, stageProgress } from '../domain/controller.js';
import type { ProductionState } from '../domain/schema.js';
import { referenceReadinessForShot } from '../references.js';

export async function renderProductionPages(state: ProductionState, dir: string): Promise<string[]> {
  const pagesDir = join(dir, 'pages');
  await mkdir(pagesDir, { recursive: true });
  const artifacts = await inspectArtifacts(state, dir);
  const pages = [
    ['production.html', renderProductionPage(state, artifacts)],
    ['review.html', renderReviewPage(state, artifacts)],
  ] as const;
  const written: string[] = [];
  for (const [name, html] of pages) {
    const path = join(pagesDir, name);
    await writeFile(path, html, 'utf-8');
    written.push(path);
  }
  return written;
}

function renderProductionPage(state: ProductionState, artifacts: ArtifactStatus[]): string {
  const progress = stageProgress(state).map((item) => `<li class="${item.status}">${esc(item.stage)}</li>`).join('');
  const playable = artifacts.find((artifact) => artifact.kind === 'export' && artifact.exists)
    ?? artifacts.find((artifact) => artifact.kind === 'take' && artifact.exists);
  const artifactRows = renderArtifactRows(artifacts);
  const filmPackage = renderFilmPackage(state);
  const referenceSets = renderReferenceSets(state);
  const finishedShots = renderFinishedShots(state);
  const shots = state.shots.map((shot) => {
    const takes = state.takes.filter((take) => take.shotId === shot.id);
    const readiness = referenceReadinessForShot(state, shot);
    return `
      <tr>
        <td>${esc(shot.id)}</td>
        <td>${esc(shot.intent)}</td>
        <td class="prompt">${esc(shot.promptDraft)}</td>
        <td>${esc(shot.status)}</td>
        <td>${shot.referenceSetIds.length} sets<br><span class="muted">${readiness.ready ? 'ready' : `missing ${readiness.missingRequiredKinds.join(', ')}`}</span></td>
        <td>${takes.map((take) => esc(`${take.id}:${take.status}`)).join('<br>')}</td>
        <td>${esc(shot.selectedTakeId ?? '-')}</td>
      </tr>`;
  }).join('');
  return layout(state, `
    <section>
      <h2>Brief</h2>
      <p>${esc(state.production.brief)}</p>
      <div class="metrics">
        <span>Stage <strong>${esc(state.production.stage)}</strong></span>
        <span>Target <strong>${state.production.target.runtimeSeconds}s ${esc(state.production.target.aspectRatio)} MP4</strong></span>
        <span>Budget <strong>$${state.production.budgetGuardrail.spentUsd.toFixed(2)} / $${state.production.budgetGuardrail.maxUsd.toFixed(2)}</strong></span>
        <span>Routing <strong>${esc(state.production.routing.policy)}</strong></span>
      </div>
    </section>
    <section>
      <h2>Stage Gates</h2>
      <ol class="stages">${progress}</ol>
    </section>
    ${renderActivitySection(state)}
    ${filmPackage}
    ${referenceSets}
    ${playable ? `
      <section>
        <h2>Playable</h2>
        <video controls src="../${esc(playable.path)}"></video>
      </section>
    ` : ''}
    <section>
      <h2>Artifacts</h2>
      <table>
        <thead><tr><th>Kind</th><th>ID</th><th>Status</th><th>Path</th></tr></thead>
        <tbody>${artifactRows || '<tr><td colspan="4">No media artifacts yet.</td></tr>'}</tbody>
      </table>
    </section>
    ${finishedShots}
    <section>
      <h2>Shots</h2>
      <table>
        <thead><tr><th>Shot</th><th>Intent</th><th>Prompt</th><th>Status</th><th>Refs</th><th>Takes</th><th>Selected</th></tr></thead>
        <tbody>${shots || '<tr><td colspan="7">No shots yet.</td></tr>'}</tbody>
      </table>
    </section>
  `);
}

function renderActivitySection(state: ProductionState): string {
  const nextAction = nextRecommendedAction(state)?.type;
  const pendingApprovals = state.approvals.filter((approval) => approval.status === 'pending');
  const recentEvents = state.eventLog.slice(-20);
  const roleRows = Object.entries(state.production.routing.roles ?? {})
    .map(([role, selection]) => `
      <tr>
        <td>${esc(role)}</td>
        <td>${esc(selection.model)}</td>
      </tr>`)
    .join('');
  const modalityRows = Object.entries(state.production.routing.modalities ?? {})
    .map(([modality, selection]) => `
      <tr>
        <td>${esc(modality)}</td>
        <td>${selection.preferredModels.map(esc).join('<br>')}</td>
      </tr>`)
    .join('');
  const costRows = state.costs.slice(-10)
    .map((cost) => `
      <tr>
        <td>${esc(cost.createdAt.replace('T', ' ').slice(0, 19))}</td>
        <td>${esc(cost.kind)}<br><span class="muted">${esc(cost.subjectId)}</span></td>
        <td>$${cost.costUsd.toFixed(4)}</td>
      </tr>`)
    .join('');
  const approvalRows = pendingApprovals
    .map((approval) => `
      <tr>
        <td>${esc(approval.kind)}</td>
        <td>${esc(approval.subjectId)}</td>
        <td>${approval.costUsd === undefined ? '-' : `$${approval.costUsd.toFixed(2)}`}</td>
        <td>${esc(approval.reason)}</td>
      </tr>`)
    .join('');

  return `
    <section>
      <h2>Activity</h2>
      <div class="metrics">
        <span>Next <strong>${esc(formatAction(nextAction))}</strong></span>
        <span>Allowed <strong>${esc(legalActions(state).map(formatAction).join(', '))}</strong></span>
        <span>Pending approvals <strong>${pendingApprovals.length}</strong></span>
        <span>Last event <strong>${esc(recentEvents.at(-1) ?? 'No events yet.')}</strong></span>
      </div>
      <div class="activity-grid">
        <details open>
          <summary>Recent Events</summary>
          <ol class="event-list">${recentEvents.map((event) => `<li>${esc(event)}</li>`).join('') || '<li>No events yet.</li>'}</ol>
        </details>
        <details open>
          <summary>Model Routing</summary>
          <table>
            <thead><tr><th>Role</th><th>Model</th></tr></thead>
            <tbody>${roleRows || '<tr><td colspan="2">No text roles routed yet.</td></tr>'}</tbody>
          </table>
          <table>
            <thead><tr><th>Media</th><th>Preferred Models</th></tr></thead>
            <tbody>${modalityRows || '<tr><td colspan="2">No media models routed yet.</td></tr>'}</tbody>
          </table>
        </details>
        <details>
          <summary>Approvals</summary>
          <table>
            <thead><tr><th>Kind</th><th>Subject</th><th>Cost</th><th>Reason</th></tr></thead>
            <tbody>${approvalRows || '<tr><td colspan="4">No pending approvals.</td></tr>'}</tbody>
          </table>
        </details>
        <details>
          <summary>Cost Ledger</summary>
          <table>
            <thead><tr><th>Time</th><th>Item</th><th>Cost</th></tr></thead>
            <tbody>${costRows || '<tr><td colspan="3">No costs recorded yet.</td></tr>'}</tbody>
          </table>
        </details>
      </div>
    </section>`;
}

function renderFinishedShots(state: ProductionState): string {
  if (state.finishedShots.length === 0) return '';
  const rows = state.finishedShots.map((item) => `
    <tr>
      <td>${esc(item.id)}</td>
      <td>${esc(item.takeId)}<br><span class="muted">${esc(item.shotId)}</span></td>
      <td>${esc(item.status)}</td>
      <td>${esc(item.pipeline.adapter)}<br><span class="muted">${esc(item.pipeline.targetResolution)} ${item.pipeline.frameRate ?? '-'}fps · cleanup ${item.pipeline.cleanup ? 'on' : 'off'} · grain ${item.pipeline.grain ? 'on' : 'off'}</span></td>
      <td>${esc(item.outputPath)}</td>
    </tr>`).join('');
  return `
    <section>
      <h2>Finished Shots</h2>
      <table>
        <thead><tr><th>ID</th><th>Take</th><th>Status</th><th>Pipeline</th><th>Output</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
}

function renderReferenceSets(state: ProductionState): string {
  if (state.referenceSets.length === 0) return '';
  const rows = state.referenceSets.map((set) => {
    const refs = set.referenceIds
      .map((id) => state.references.find((reference) => reference.id === id))
      .filter((reference): reference is ProductionState['references'][number] => Boolean(reference));
    return `
      <tr>
        <td>${esc(set.id)}</td>
        <td>${esc(set.name)}<br><span class="muted">${esc(set.purpose)}</span></td>
        <td>${set.requiredKinds.map(esc).join('<br>')}</td>
        <td>${refs.map((reference) => `${esc(reference.id)} <span class="muted">${esc(reference.kind)} ${reference.path ? 'ready' : 'missing'}</span>`).join('<br>')}</td>
      </tr>`;
  }).join('');
  return `
    <section>
      <h2>Reference Sets</h2>
      <table>
        <thead><tr><th>Set</th><th>Name</th><th>Required</th><th>References</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
}

function renderFilmPackage(state: ProductionState): string {
  const pack = state.filmPackage;
  if (!pack) return '';
  return `
    <section>
      <h2>Film Package</h2>
      <div class="metrics">
        <span>Hero <strong>${esc(pack.visualContinuity.hero)}</strong></span>
        <span>Guide <strong>${esc(pack.visualContinuity.guide ?? '-')}</strong></span>
        <span>Palette <strong>${esc(pack.visualContinuity.palette)}</strong></span>
        <span>Frame chaining <strong>${pack.visualContinuity.frameChaining ? 'required' : 'off'}</strong></span>
      </div>
      ${pack.productionProcess ? `
        <h3>Production Process</h3>
        <div class="metrics">
          <span>Kind <strong>${esc(pack.productionProcess.kind)}</strong></span>
          <span>Goal <strong>${esc(pack.productionProcess.primaryGoal)}</strong></span>
          <span>Audio <strong>${esc(pack.productionProcess.audioPlan)}</strong></span>
        </div>
        <p>${esc(pack.productionProcess.processSummary)}</p>
        <h3>Process Priorities</h3>
        <ul>${pack.productionProcess.planningPriorities.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>
        <h3>Required Assets</h3>
        <ul>${pack.productionProcess.requiredAssets.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>
        <h3>Review Criteria</h3>
        <ul>${pack.productionProcess.reviewCriteria.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>
      ` : ''}
      ${pack.storyTreatment ? `
        <h3>Story Treatment</h3>
        <table>
          <tbody>
            <tr><th>Format</th><td>${esc(pack.storyTreatment.format)}</td></tr>
            <tr><th>Story</th><td>${esc(pack.storyTreatment.storyType)}</td></tr>
            <tr><th>Protagonist</th><td>${esc(pack.storyTreatment.protagonist)}</td></tr>
            <tr><th>Goal</th><td>${esc(pack.storyTreatment.goal)}</td></tr>
            <tr><th>Obstacle</th><td>${esc(pack.storyTreatment.obstacle)}</td></tr>
            <tr><th>Stakes</th><td>${esc(pack.storyTreatment.stakes)}</td></tr>
            <tr><th>Ending</th><td>${esc(pack.storyTreatment.ending)}</td></tr>
          </tbody>
        </table>
        <h3>Grounding Rules</h3>
        <ul>${pack.storyTreatment.groundingRules.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>
      ` : ''}
      ${pack.audioStrategy ? `
        <h3>Audio Strategy</h3>
        <div class="metrics">
          <span>Mode <strong>${esc(pack.audioStrategy.mode)}</strong></span>
          <span>Music <strong>${pack.audioStrategy.musicRequired ? 'required' : 'optional'}</strong></span>
          <span>Dialogue <strong>${esc(pack.audioStrategy.dialogueApproach ?? '-')}</strong></span>
          <span>Narration <strong>${esc(pack.audioStrategy.narrationApproach ?? '-')}</strong></span>
        </div>
      ` : ''}
      <h3>Motifs</h3>
      <ul>${pack.visualContinuity.motifs.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>
      <h3>Forbidden</h3>
      <ul>${pack.visualContinuity.forbidden.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>
      <h3>Narration</h3>
      <table>
        <thead><tr><th>ID</th><th>Shot</th><th>Timing</th><th>Text</th></tr></thead>
        <tbody>${pack.narration.map((line) => `
          <tr>
            <td>${esc(line.id)}</td>
            <td>${esc(line.shotId)}</td>
            <td>${line.startSeconds}-${line.endSeconds}s</td>
            <td>${esc(line.text)}${line.audioPath ? `<br><span class="muted">${esc(line.audioPath)}</span>` : ''}</td>
          </tr>
        `).join('')}</tbody>
      </table>
      <h3>Dialogue</h3>
      <table>
        <thead><tr><th>ID</th><th>Shot</th><th>Character</th><th>Text</th></tr></thead>
        <tbody>${pack.dialogue.map((line) => `
          <tr>
            <td>${esc(line.id)}</td>
            <td>${esc(line.shotId)}</td>
            <td>${esc(line.character)}</td>
            <td>${esc(line.text)}${line.audioPath ? `<br><span class="muted">${esc(line.audioPath)}</span>` : ''}</td>
          </tr>
        `).join('') || '<tr><td colspan="4">No dialogue planned.</td></tr>'}</tbody>
      </table>
      <h3>Music</h3>
      ${pack.music ? `
        <p>${esc(pack.music.prompt)}${pack.music.required ? ' <strong>Required.</strong>' : ''}${pack.music.audioPath ? `<br><span class="muted">${esc(pack.music.audioPath)}</span>` : ''}</p>
      ` : '<p>No music cue planned.</p>'}
    </section>`;
}

function renderReviewPage(state: ProductionState, artifacts: ArtifactStatus[]): string {
  const reviews = state.takeReviews.map((review) => `
    <article>
      <h3>${esc(review.takeId)}: ${esc(review.verdict)}</h3>
      <p>${review.findings.map(esc).join('<br>')}</p>
    </article>`).join('');
  const final = state.finalReviews.at(-1);
  return layout(state, `
    <section>
      <h2>Take Reviews</h2>
      ${reviews || '<p>No take reviews yet.</p>'}
    </section>
    <section>
      <h2>Final Review</h2>
      ${final ? `
        <p><strong>${esc(final.verdict)}</strong>${final.routedStage ? ` routed to ${esc(final.routedStage)}` : ''}</p>
        <ul>${final.requiredFixes.map((fix) => `<li>${esc(fix)}</li>`).join('')}</ul>
      ` : '<p>No final review yet.</p>'}
    </section>
    <section>
      <h2>Artifact Verification</h2>
      <table>
        <thead><tr><th>Kind</th><th>ID</th><th>Status</th><th>Path</th></tr></thead>
        <tbody>${renderArtifactRows(artifacts) || '<tr><td colspan="4">No artifacts to verify.</td></tr>'}</tbody>
      </table>
    </section>
  `);
}

function renderArtifactRows(artifacts: ArtifactStatus[]): string {
  return artifacts.map((artifact) => `
    <tr>
      <td>${esc(artifact.kind)}</td>
      <td>${esc(artifact.id)}</td>
      <td>${artifact.exists ? `exists (${formatBytes(artifact.sizeBytes ?? 0)})` : 'missing'}</td>
      <td>${esc(artifact.path)}${artifact.note ? `<br><span class="muted">${esc(artifact.note)}</span>` : ''}</td>
    </tr>`).join('');
}

function layout(state: ProductionState, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(state.production.title)} - Showrunner</title>
  <style>
    :root { color-scheme: light dark; --bg:#101114; --fg:#f4efe3; --muted:#a8a092; --line:#34302a; --accent:#f2b84b; --ok:#87c06a; --card:#191a1f; }
    body { margin:0; font:15px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--bg); color:var(--fg); }
    header, main { max-width:1100px; margin:0 auto; padding:24px; }
    header { border-bottom:1px solid var(--line); }
    h1 { margin:0 0 6px; font-size:28px; letter-spacing:0; }
    h2 { margin:0 0 14px; font-size:18px; }
    section, article { border:1px solid var(--line); background:var(--card); border-radius:8px; padding:18px; margin:16px 0; }
    video { width:100%; max-height:70vh; background:#050506; border-radius:8px; }
    table { width:100%; border-collapse:collapse; table-layout:fixed; }
    th, td { padding:10px; border-bottom:1px solid var(--line); vertical-align:top; text-align:left; }
    th { color:var(--muted); font-weight:600; }
    td { overflow-wrap:anywhere; }
    th:nth-child(1), td:nth-child(1) { width:70px; }
    th:nth-child(3), td:nth-child(3) { width:38%; }
    .prompt { color:#ded7c7; font-size:13px; line-height:1.45; }
    .metrics { display:grid; grid-template-columns:repeat(auto-fit, minmax(190px, 1fr)); gap:10px; margin-top:18px; }
    .metrics span { border:1px solid var(--line); border-radius:6px; padding:10px; color:var(--muted); }
    .metrics strong { display:block; color:var(--fg); margin-top:4px; }
    .stages { display:flex; flex-wrap:wrap; gap:8px; padding:0; list-style:none; }
    .stages li { border:1px solid var(--line); border-radius:999px; padding:6px 10px; color:var(--muted); }
    .stages .done { color:var(--ok); }
    .stages .current { color:var(--accent); border-color:var(--accent); }
    .activity-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:16px; margin-top:18px; }
    .activity-grid table { table-layout:auto; margin-top:8px; }
    .activity-grid th:nth-child(1), .activity-grid td:nth-child(1), .activity-grid th:nth-child(3), .activity-grid td:nth-child(3) { width:auto; }
    details { border-top:1px solid var(--line); padding-top:12px; min-width:0; }
    summary { cursor:pointer; color:var(--accent); font-weight:600; margin-bottom:10px; }
    .event-list { margin:0; padding-left:20px; }
    .event-list li { margin:0 0 8px; overflow-wrap:anywhere; }
    .muted { color:var(--muted); }
    a { color:var(--accent); }
  </style>
</head>
<body>
  <header>
    <h1>${esc(state.production.title)}</h1>
    <div>Showrunner Production Page</div>
  </header>
  <main>${body}</main>
</body>
</html>`;
}

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char] ?? char));
}

function formatAction(action: string | undefined): string {
  return action ? action.replace(/_/g, ' ') : 'none';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
