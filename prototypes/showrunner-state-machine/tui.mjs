#!/usr/bin/env node
// PROTOTYPE - throwaway terminal shell over machine.mjs.

import readline from "node:readline";
import { createInitialState, dispatch, stageProgress, viewModel, availableActions } from "./machine.mjs";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";

let state = createInitialState();

const keyMap = {
  b: { label: "confirm brief", action: { type: "confirm_brief" } },
  c: { label: "create scenes", action: { type: "create_scenes" } },
  h: { label: "create shots", action: { type: "create_shots" } },
  r: { label: "prepare references", action: { type: "prepare_references" } },
  p: { label: "preview take", action: { type: "preview_take" } },
  a: { label: "approve pending", action: { type: "approve" } },
  s: { label: "submit take", action: { type: "submit_take" } },
  n: { label: "advance to reviews", action: { type: "advance_takes" } },
  v: { label: "review take", action: { type: "review_take" } },
  l: { label: "select take", action: { type: "select_take" } },
  e: { label: "assemble", action: { type: "assemble" } },
  m: { label: "sound mix", action: { type: "sound_mix" } },
  x: { label: "export mp4", action: { type: "export" } },
  f: { label: "final pass", action: { type: "final_pass" } },
  "1": { label: "fail visual", action: { type: "fail_visual" } },
  "2": { label: "fail audio", action: { type: "fail_audio" } },
  "3": { label: "fail export", action: { type: "fail_export" } },
  z: { label: "repair route", action: { type: "repair" } },
  y: { label: "toggle autonomy", action: { type: "toggle_autonomy" } },
  j: { label: "show legal actions", action: { type: "jump" } },
};

readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);

process.stdin.on("keypress", (_, key) => {
  if (key.sequence === "q" || (key.ctrl && key.name === "c")) {
    cleanup();
    return;
  }
  if (key.sequence === "?") {
    render(true);
    return;
  }
  const entry = keyMap[key.sequence];
  if (entry) state = dispatch(state, entry.action);
  render(false);
});

render(false);

function render(showHelp) {
  console.clear();
  const vm = viewModel(state);
  console.log(`${BOLD}Showrunner State Machine Prototype${RESET} ${DIM}(throwaway)${RESET}`);
  console.log(`${DIM}Question: do the V0 stage gates, approvals, takes, sound, export, and repair routes feel right?${RESET}\n`);

  console.log(`${BOLD}Production${RESET}`);
  field("stage", colorStage(vm.production.stage));
  field("target", vm.production.target);
  field("routing", vm.production.routing);
  field("mode", vm.production.autonomy);
  field("budget", vm.production.budget);

  console.log(`\n${BOLD}Stage Gates${RESET}`);
  console.log(stageProgress(state).map((item) => {
    if (item.status === "done") return `${GREEN}✓ ${item.stage}${RESET}`;
    if (item.status === "current") return `${YELLOW}▶ ${item.stage}${RESET}`;
    return `${DIM}· ${item.stage}${RESET}`;
  }).join("  "));

  console.log(`\n${BOLD}Counts${RESET}`);
  field("scenes", vm.counts.scenes);
  field("shots", vm.counts.shots);
  field("references", vm.counts.references);
  field("takes", vm.counts.takes);
  field("take reviews", vm.counts.reviews);
  field("selected takes", `${vm.counts.selectedTakes}/${vm.counts.shots}`);

  console.log(`\n${BOLD}Pending Approval${RESET}`);
  if (vm.pendingApproval) {
    field("kind", vm.pendingApproval.kind);
    field("take", vm.pendingApproval.takeId);
    field("cost", `$${vm.pendingApproval.costUsd.toFixed(2)}`);
    field("reason", vm.pendingApproval.reason);
  } else {
    console.log(`${DIM}  none${RESET}`);
  }

  console.log(`\n${BOLD}Shots${RESET}`);
  if (vm.shots.length === 0) {
    console.log(`${DIM}  none yet${RESET}`);
  } else {
    for (const shot of vm.shots) {
      console.log(`  ${shot.id} ${DIM}${shot.stage}${RESET} selected=${shot.selectedTakeId} refs=${shot.references} takes=[${shot.takes.join(", ")}]`);
    }
  }

  console.log(`\n${BOLD}Downstream Artifacts${RESET}`);
  field("assembly", vm.assembly ? `${vm.assembly.id} (${vm.assembly.selectedTakeIds.length} takes)` : "-");
  field("sound mix", vm.soundMix ? `${vm.soundMix.id}, ${vm.soundMix.musicCues.length} music cues, ${vm.soundMix.loudnessTarget}` : "-");
  field("export", vm.export ? `${vm.export.path} ${vm.export.codec}/${vm.export.audioCodec}` : "-");
  field("final review", vm.finalReview ? `${vm.finalReview.verdict} ${vm.finalReview.routedStage ? `-> ${vm.finalReview.routedStage}` : ""}` : "-");

  console.log(`\n${BOLD}Recent Events${RESET}`);
  for (const event of vm.recentEvents) {
    const color = event.startsWith("Blocked") ? RED : DIM;
    console.log(`  ${color}${event}${RESET}`);
  }

  console.log(`\n${BOLD}Keys${RESET}`);
  console.log(keyHelp(showHelp));
}

function field(name, value) {
  console.log(`  ${DIM}${name}:${RESET} ${value}`);
}

function colorStage(stage) {
  if (stage === "complete") return `${GREEN}${stage}${RESET}`;
  if (stage === "final_review") return `${CYAN}${stage}${RESET}`;
  return `${YELLOW}${stage}${RESET}`;
}

function keyHelp(showHelp) {
  const legal = new Set(availableActions(state));
  const always = ["?", "q", "j", "y"];
  const current = Object.entries(keyMap)
    .filter(([key]) => legal.has(key) && !always.includes(key))
    .map(([key, entry]) => `${BOLD}${key}${RESET} ${DIM}${entry.label}${RESET}`);
  const base = [
    `${BOLD}?${RESET} ${DIM}help${RESET}`,
    `${BOLD}j${RESET} ${DIM}legal actions${RESET}`,
    `${BOLD}y${RESET} ${DIM}toggle autonomy${RESET}`,
    `${BOLD}q${RESET} ${DIM}quit${RESET}`,
  ];
  if (showHelp) {
    return [
      ...base,
      "",
      `${DIM}Happy path:${RESET} b c h r p a s ... v ... l ... e m x f`,
      `${DIM}Final review failure probes:${RESET} 1 visual, 2 audio, 3 export, z repair route`,
      `${DIM}Current legal stage actions:${RESET} ${current.join("  ") || "none"}`,
    ].join("\n  ");
  }
  return [...current, ...base].join("  ");
}

function cleanup() {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  console.clear();
  console.log("Prototype closed.");
  process.exit(0);
}
