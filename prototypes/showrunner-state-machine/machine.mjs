// PROTOTYPE - throwaway reducer for testing Showrunner's V0 production state.
// Keep this file portable: no terminal I/O, no OpenRouter calls, no filesystem writes.

export const STAGES = [
  "brief",
  "scene_plan",
  "shot_plan",
  "references",
  "takes",
  "take_reviews",
  "selected_takes",
  "assembly",
  "sound_mix",
  "export",
  "final_review",
  "complete",
];

const stageIndex = (stage) => STAGES.indexOf(stage);

export function createInitialState() {
  return {
    production: {
      id: "prod_proto",
      title: "Prototype Product Launch",
      stage: "brief",
      target: { platform: "social", aspectRatio: "9:16", format: "mp4", runtimeSeconds: 24 },
      budgetGuardrail: { maxUsd: 12, approvalThresholdUsd: 0.5, spentUsd: 0 },
      autonomyPolicy: { enabled: false, maxUsd: 6, maxTakesPerShot: 2, finalReviewThreshold: "pass" },
      routing: { policy: "balanced" },
    },
    scenes: [],
    shots: [],
    references: [],
    takes: [],
    takeReviews: [],
    assembly: null,
    soundMix: null,
    export: null,
    finalReview: null,
    pendingApproval: null,
    eventLog: ["Prototype initialized. Press ? for help."],
    nextIds: { scene: 1, shot: 1, reference: 1, take: 1, review: 1, approval: 1 },
  };
}

export function dispatch(state, action) {
  const next = structuredClone(state);
  const result = apply(next, action);
  if (result) log(next, result);
  return next;
}

export function availableActions(state) {
  const actions = ["?", "q", "j", "y"];
  if (state.production.stage === "brief") actions.push("b");
  if (state.production.stage === "scene_plan") actions.push("c");
  if (state.production.stage === "shot_plan") actions.push("h");
  if (state.production.stage === "references") actions.push("r");
  if (state.production.stage === "takes") {
    if (state.pendingApproval) actions.push("a");
    else if (state.takes.some((take) => take.status === "approved")) actions.push("s");
    else if (allShotsHaveCompletedTake(state)) actions.push("n");
    else actions.push("p");
  }
  if (state.production.stage === "take_reviews") actions.push("v");
  if (state.production.stage === "selected_takes") actions.push("l");
  if (state.production.stage === "assembly") actions.push("e");
  if (state.production.stage === "sound_mix") actions.push("m");
  if (state.production.stage === "export") actions.push("x");
  if (state.production.stage === "final_review") actions.push("f", "1", "2", "3");
  if (state.finalReview?.verdict === "fail") actions.push("z");
  return actions;
}

export function viewModel(state) {
  return {
    production: {
      stage: state.production.stage,
      target: `${state.production.target.runtimeSeconds}s ${state.production.target.aspectRatio} ${state.production.target.format}`,
      routing: state.production.routing.policy,
      autonomy: state.production.autonomyPolicy.enabled ? "enabled" : "approval gates",
      budget: `$${state.production.budgetGuardrail.spentUsd.toFixed(2)} / $${state.production.budgetGuardrail.maxUsd.toFixed(2)}`,
    },
    counts: {
      scenes: state.scenes.length,
      shots: state.shots.length,
      references: state.references.length,
      takes: state.takes.length,
      reviews: state.takeReviews.length,
      selectedTakes: state.shots.filter((shot) => shot.selectedTakeId).length,
    },
    pendingApproval: state.pendingApproval,
    shots: state.shots.map((shot) => ({
      id: shot.id,
      stage: shot.status,
      selectedTakeId: shot.selectedTakeId ?? "-",
      continuityCritical: shot.continuityCritical,
      references: shot.referenceIds.length,
      takes: state.takes.filter((take) => take.shotId === shot.id).map((take) => `${take.id}:${take.status}`),
    })),
    assembly: state.assembly,
    soundMix: state.soundMix,
    export: state.export,
    finalReview: state.finalReview,
    recentEvents: state.eventLog.slice(-6),
  };
}

function apply(state, action) {
  switch (action.type) {
    case "confirm_brief":
      if (!at(state, "brief")) return blocked(state, "Brief is already confirmed.");
      state.production.brief = "A polished vertical product teaser with narration, music, and cinematic AI video.";
      state.production.musicBrief = {
        genre: "modern cinematic electronic",
        emotionalPalette: "confident, crisp, premium",
      };
      state.production.stage = "scene_plan";
      return "Brief confirmed. Producer collected hard constraints and moved to scene planning.";

    case "create_scenes":
      if (!at(state, "scene_plan")) return blocked(state, "Scene planning is not the current stage.");
      state.scenes.push(
        scene(state, "Hook", "Open with a striking product reveal."),
        scene(state, "Proof", "Show the product solving the user's problem."),
        scene(state, "Close", "End on a premium call-to-action moment."),
      );
      state.production.stage = "shot_plan";
      return "Director created three ordered Scenes.";

    case "create_shots":
      if (!at(state, "shot_plan")) return blocked(state, "Shot planning is not the current stage.");
      for (const s of state.scenes) {
        state.shots.push(
          shot(state, s.id, `${s.title} establishing shot`, true),
          shot(state, s.id, `${s.title} detail motion shot`, false),
        );
      }
      state.production.stage = "references";
      return "Director and Cinematographer created six Shots.";

    case "prepare_references":
      if (!at(state, "references")) return blocked(state, "References are not the current stage.");
      for (const shot of state.shots.filter((item) => item.continuityCritical)) {
        const ref = reference(state, shot.id, "generated", `Style frame for ${shot.intent}`);
        state.references.push(ref);
        shot.referenceIds.push(ref.id);
      }
      state.production.stage = "takes";
      return "Generated References for continuity-critical Shots.";

    case "preview_take":
      if (!at(state, "takes")) return blocked(state, "Takes are not the current stage.");
      return previewTake(state);

    case "approve":
      if (!state.pendingApproval) return blocked(state, "There is no pending approval.");
      return approvePending(state);

    case "submit_take":
      if (!at(state, "takes")) return blocked(state, "Take generation is not the current stage.");
      return submitTake(state);

    case "advance_takes":
      if (!at(state, "takes")) return blocked(state, "Take generation is not the current stage.");
      if (!allShotsHaveCompletedTake(state)) return blocked(state, "Not all Shots have completed Takes yet.");
      state.production.stage = "take_reviews";
      return "All Shots have completed Takes. Moved to Take Review.";

    case "review_take":
      if (!at(state, "take_reviews")) return blocked(state, "Take reviews are not the current stage.");
      return reviewNextTake(state);

    case "select_take":
      if (!at(state, "selected_takes")) return blocked(state, "Selected Takes are not the current stage.");
      return selectNextTake(state);

    case "assemble":
      if (!at(state, "assembly")) return blocked(state, "Assembly is not the current stage.");
      state.assembly = {
        id: "asm_1",
        selectedTakeIds: state.shots.map((shot) => shot.selectedTakeId),
        transitions: ["cut", "cut", "fade"],
      };
      state.production.stage = "sound_mix";
      return "Editor built an Assembly from Selected Takes.";

    case "sound_mix":
      if (!at(state, "sound_mix")) return blocked(state, "Sound Mix is not the current stage.");
      state.soundMix = {
        id: "mix_1",
        narration: "generated",
        musicCues: state.scenes.map((scene) => `${scene.id}_music_cue`),
        nativeTakeAudio: "ducked under narration and music",
        loudnessTarget: "-14 LUFS",
      };
      state.production.stage = "export";
      return "Sound Designer generated Narration, Music Cues, and a Sound Mix.";

    case "export":
      if (!at(state, "export")) return blocked(state, "Export is not the current stage.");
      state.export = {
        id: "exp_1",
        path: "exports/production.mp4",
        format: "mp4",
        codec: "h264",
        audioCodec: "aac",
        aspectRatio: state.production.target.aspectRatio,
        captionArtifacts: [],
      };
      state.production.stage = "final_review";
      return "Editor rendered a social-ready MP4 Export.";

    case "final_pass":
      if (!at(state, "final_review")) return blocked(state, "Final Review is not the current stage.");
      state.finalReview = { id: "final_1", verdict: "pass", requiredFixes: [], routedStage: null };
      state.production.stage = "complete";
      return "Final Review passed. Production is complete.";

    case "fail_visual":
      return failFinalReview(state, "takes", "Visual artifact in shot_2 requires a new Take.");

    case "fail_audio":
      return failFinalReview(state, "sound_mix", "Music cue overpowers narration in the closing Scene.");

    case "fail_export":
      return failFinalReview(state, "export", "Export aspect ratio or codec compliance failed.");

    case "repair":
      if (state.finalReview?.verdict !== "fail") return blocked(state, "There is no failed Final Review to repair.");
      state.production.stage = state.finalReview.routedStage;
      state.finalReview = null;
      return `Repair routed to ${state.production.stage}.`;

    case "toggle_autonomy":
      state.production.autonomyPolicy.enabled = !state.production.autonomyPolicy.enabled;
      if (state.production.autonomyPolicy.enabled && state.pendingApproval?.kind === "paid_generation") {
        autoApproveIfCovered(state);
      }
      return `Autonomy Policy ${state.production.autonomyPolicy.enabled ? "enabled" : "disabled"}.`;

    case "jump":
      return blocked(state, `Current legal actions: ${availableActions(state).join(" ")}`);

    default:
      return blocked(state, "Unknown action.");
  }
}

function previewTake(state) {
  if (state.pendingApproval) {
    return blocked(state, `Approve ${state.pendingApproval.takeId} before previewing another paid Take.`);
  }

  const strandedTake = state.takes.find((take) => take.status === "previewed");
  if (strandedTake) {
    state.pendingApproval = approvalForTake(state, strandedTake);
    return `Restored approval for ${strandedTake.id}. Approve it before previewing another Take.`;
  }

  const shot = nextShotNeedingTake(state);
  if (!shot) {
    if (allShotsHaveCompletedTake(state)) {
      state.production.stage = "take_reviews";
      return "All Shots have completed Takes. Moved to Take Review.";
    }
    return blocked(state, "No Shot needs a Take.");
  }

  const take = {
    id: `take_${state.nextIds.take++}`,
    shotId: shot.id,
    model: "runtime-selected-video-model",
    status: "previewed",
    costUsd: 0.82,
    request: {
      prompt: shot.promptDraft,
      references: shot.referenceIds,
      aspectRatio: state.production.target.aspectRatio,
      durationSeconds: shot.durationSeconds,
    },
  };
  state.takes.push(take);
  shot.status = "previewed";

  if (autoApproveIfCovered(state, take)) {
    return `Previewed and auto-approved ${take.id} for ${shot.id} under Autonomy Policy.`;
  }

  state.pendingApproval = approvalForTake(state, take);
  return `Previewed ${take.id}. Approval required before paid generation.`;
}

function approvePending(state) {
  const approval = state.pendingApproval;
  if (approval.kind === "paid_generation") {
    const take = state.takes.find((item) => item.id === approval.takeId);
    take.status = "approved";
  }
  state.pendingApproval = null;
  return `Approved ${approval.kind}.`;
}

function submitTake(state) {
  if (state.pendingApproval) return blocked(state, `Approve ${state.pendingApproval.takeId} before submitting.`);
  const take = state.takes.find((item) => item.status === "approved");
  if (!take) return blocked(state, "No approved Take request is ready. Preview and approve one first.");
  const shot = state.shots.find((item) => item.id === take.shotId);
  take.status = "completed";
  take.jobId = `job_${take.id}`;
  take.mediaPath = `assets/takes/${take.id}.mp4`;
  take.nativeAudio = { present: true, intendedUse: "undecided" };
  state.production.budgetGuardrail.spentUsd += take.costUsd;
  shot.status = "needs_review";

  if (allShotsHaveCompletedTake(state)) {
    state.production.stage = "take_reviews";
  }
  return `Submitted and completed ${take.id}. Native Take Audio was preserved for Sound Mix decisions.`;
}

function reviewNextTake(state) {
  const take = state.takes.find((item) => item.status === "completed" && !state.takeReviews.some((review) => review.takeId === item.id));
  if (!take) {
    if (allCompletedTakesReviewed(state)) {
      state.production.stage = "selected_takes";
      return "All completed Takes reviewed. Moved to Selected Takes.";
    }
    return blocked(state, "No completed Take is ready for review.");
  }

  state.takeReviews.push({
    id: `review_${state.nextIds.review++}`,
    takeId: take.id,
    reviewer: "layered",
    verdict: "pass",
    findings: ["Media facts passed.", "Story fit acceptable.", "Audio needs mix treatment."],
    requiredFixes: [],
  });
  take.status = "reviewed";
  if (allCompletedTakesReviewed(state)) {
    state.production.stage = "selected_takes";
  }
  return `Layered Take Review passed for ${take.id}.`;
}

function selectNextTake(state) {
  const shot = state.shots.find((item) => !item.selectedTakeId);
  if (!shot) {
    state.production.stage = "assembly";
    return "All Shots already have Selected Takes. Moved to Assembly.";
  }
  const reviewedTake = state.takes.find((take) => take.shotId === shot.id && take.status === "reviewed");
  if (!reviewedTake) return blocked(state, `${shot.id} has no reviewed Take to select.`);
  shot.selectedTakeId = reviewedTake.id;
  shot.status = "selected";

  if (state.shots.every((item) => item.selectedTakeId)) {
    state.production.stage = "assembly";
  }
  return `Promoted ${reviewedTake.id} to Selected Take for ${shot.id}.`;
}

function failFinalReview(state, routedStage, requiredFix) {
  if (!at(state, "final_review")) return blocked(state, "Final Review is not the current stage.");
  state.finalReview = { id: "final_1", verdict: "fail", requiredFixes: [requiredFix], routedStage };
  return `Final Review failed. Required fix routes to ${routedStage}.`;
}

function autoApproveIfCovered(state, take = null) {
  if (!state.production.autonomyPolicy.enabled) return false;
  const targetTake = take ?? state.takes.find((item) => item.id === state.pendingApproval?.takeId);
  if (!targetTake) return false;
  const projected = state.production.budgetGuardrail.spentUsd + targetTake.costUsd;
  if (projected > state.production.autonomyPolicy.maxUsd) return false;
  const shotTakeCount = state.takes.filter((item) => item.shotId === targetTake.shotId).length;
  if (shotTakeCount > state.production.autonomyPolicy.maxTakesPerShot) return false;
  targetTake.status = "approved";
  if (state.pendingApproval?.takeId === targetTake.id) state.pendingApproval = null;
  return true;
}

function at(state, stage) {
  return state.production.stage === stage;
}

function blocked(state, message) {
  log(state, `Blocked: ${message}`);
  return null;
}

function log(state, message) {
  state.eventLog.push(message);
  if (state.eventLog.length > 20) state.eventLog.shift();
}

function scene(state, title, purpose) {
  return {
    id: `scene_${state.nextIds.scene++}`,
    order: state.nextIds.scene - 1,
    title,
    purpose,
    continuity: { style: "premium cinematic", audioIntent: "music-led with clean narration" },
    musicCueIds: [],
  };
}

function shot(state, sceneId, intent, continuityCritical) {
  return {
    id: `shot_${state.nextIds.shot++}`,
    sceneId,
    order: state.nextIds.shot - 1,
    intent,
    durationSeconds: 4,
    promptDraft: `${intent}; controlled motion; crisp lighting; vertical composition.`,
    camera: "slow dolly with stable subject framing",
    subjectMotion: "deliberate product movement",
    continuityCritical,
    referenceIds: [],
    selectedTakeId: null,
    status: "planned",
  };
}

function reference(state, shotId, source, description) {
  return {
    id: `ref_${state.nextIds.reference++}`,
    shotId,
    source,
    description,
  };
}

function approvalForTake(state, take) {
  return {
    id: `approval_${state.nextIds.approval++}`,
    kind: "paid_generation",
    takeId: take.id,
    costUsd: take.costUsd,
    reason: `Submit ${take.id} for ${take.shotId}`,
  };
}

function nextShotNeedingTake(state) {
  return state.shots.find((shot) => {
    if (shot.selectedTakeId) return false;
    const hasOpenTake = state.takes.some((take) =>
      take.shotId === shot.id && ["previewed", "approved", "completed", "reviewed"].includes(take.status),
    );
    return !hasOpenTake || shot.status === "needs_fix";
  });
}

function allShotsHaveCompletedTake(state) {
  return state.shots.length > 0 && state.shots.every((shot) =>
    state.takes.some((take) => take.shotId === shot.id && ["completed", "reviewed"].includes(take.status)),
  );
}

function allCompletedTakesReviewed(state) {
  const completed = state.takes.filter((take) => ["completed", "reviewed"].includes(take.status));
  return completed.length > 0 && completed.every((take) => state.takeReviews.some((review) => review.takeId === take.id));
}

export function stageProgress(state) {
  const index = stageIndex(state.production.stage);
  return STAGES.map((stage, i) => {
    if (i < index) return { stage, status: "done" };
    if (i === index) return { stage, status: "current" };
    return { stage, status: "pending" };
  });
}
