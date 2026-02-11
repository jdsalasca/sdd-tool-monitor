import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import { resolveWorkspaceRoot } from "./config.js";

const STAGE_ORDER = [
  "discovery",
  "functional_requirements",
  "technical_backlog",
  "implementation",
  "quality_validation",
  "role_review",
  "release_candidate",
  "final_release",
  "runtime_start"
];

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function readText(file) {
  if (!fs.existsSync(file)) return "";
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return "";
  }
}

function safeParseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function readJsonlTail(file, max = 10) {
  if (!fs.existsSync(file)) return [];
  let raw = "";
  try {
    const stat = fs.statSync(file);
    const tailBytes = Math.min(stat.size, 256 * 1024);
    const start = Math.max(0, stat.size - tailBytes);
    const fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(tailBytes);
    fs.readSync(fd, buffer, 0, tailBytes, start);
    fs.closeSync(fd);
    raw = buffer.toString("utf-8");
  } catch {
    raw = readText(file);
  }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  return lines.slice(Math.max(0, lines.length - max)).map(safeParseJsonLine).filter(Boolean);
}

function parseLifecycle(projectRoot) {
  const jsonFile = path.join(projectRoot, "generated-app", "deploy", "lifecycle-report.json");
  const json = readJson(jsonFile);
  if (json && typeof json === "object") {
    const steps = Array.isArray(json.steps) ? json.steps : [];
    const failItems = steps.filter((step) => !step?.ok).map((step) => `${step.command}: ${String(step.output || "")}`);
    return {
      present: true,
      ok: steps.filter((step) => step?.ok).length,
      fail: failItems.length,
      skipped: Array.isArray(json.summary) ? json.summary.filter((line) => String(line).startsWith("SKIP:")).length : 0,
      lastFailure: failItems.at(-1) || "",
      failItems
    };
  }
  const file = path.join(projectRoot, "generated-app", "deploy", "lifecycle-report.md");
  const raw = readText(file);
  if (!raw) {
    return { present: false, ok: 0, fail: 0, skipped: 0, lastFailure: "missing", failItems: [] };
  }
  const ok = (raw.match(/- OK:/g) || []).length;
  const fail = (raw.match(/- FAIL:/g) || []).length;
  const skipped = (raw.match(/- SKIP:/g) || []).length;
  const failItems = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- FAIL:"))
    .map((line) => line.replace(/^- FAIL:\s*/, ""));
  return {
    present: true,
    ok,
    fail,
    skipped,
    lastFailure: failItems.at(-1) || "",
    failItems
  };
}

function parseRunStatus(projectRoot) {
  const parsed = readJson(path.join(projectRoot, "sdd-run-status.json"));
  if (!parsed) {
    return {
      present: false,
      blockers: [],
      recovery: null,
      stageCurrent: "",
      step: ""
    };
  }
  return {
    present: true,
    blockers: Array.isArray(parsed.blockers) ? parsed.blockers : [],
    recovery: parsed.recovery || null,
    stageCurrent: String(parsed.stageCurrent || ""),
    step: String(parsed.step || ""),
    lifecyclePassed: typeof parsed?.lifecycle?.passed === "boolean" ? parsed.lifecycle.passed : null,
    reviewApproved: typeof parsed?.review?.approved === "boolean" ? parsed.review.approved : null,
    releaseFinal: String(parsed?.release?.final || ""),
    runtimeStarted: typeof parsed?.runtime?.started === "boolean" ? parsed.runtime.started : null,
    raw: parsed
  };
}

function parseDigitalReview(projectRoot) {
  const file = path.join(projectRoot, "generated-app", "deploy", "digital-review-report.json");
  const parsed = readJson(file);
  if (!parsed) {
    return { present: false, passed: false, score: 0, threshold: 0 };
  }
  return {
    present: true,
    passed: Boolean(parsed.passed),
    score: Number(parsed.score || 0),
    threshold: Number(parsed.threshold || 0)
  };
}

function parseStage(projectRoot) {
  const parsed = readJson(path.join(projectRoot, ".sdd-stage-state.json"));
  const stages = parsed?.stages || {};
  const current = STAGE_ORDER.find((stage) => stages[stage] !== "passed") || "runtime_start";
  return { stages, current, history: Array.isArray(parsed?.history) ? parsed.history.slice(-20) : [] };
}

function parseCampaign(projectRoot) {
  const file = path.join(projectRoot, "suite-campaign-state.json");
  const state = readJson(file);
  if (!state) {
    return { present: false, cycle: 0, elapsedMinutes: 0, autonomous: false, targetPassed: false, qualityPassed: false, runtimePassed: false };
  }
  let updatedAt = "";
  try {
    updatedAt = fs.statSync(file).mtime.toISOString();
  } catch {
    updatedAt = "";
  }
  return {
    present: true,
    cycle: Number(state.cycle || 0),
    elapsedMinutes: Number(state.elapsedMinutes || 0),
    autonomous: Boolean(state.autonomous),
    running: Boolean(state.running),
    suitePid: Number(state.suitePid || 0),
    phase: String(state.phase || ""),
    lastError: String(state.lastError || ""),
    model: String(state.model || ""),
    nextFromStep: String(state.nextFromStep || ""),
    stallCount: Number(state.stallCount || 0),
    targetPassed: Boolean(state.targetPassed),
    qualityPassed: Boolean(state.qualityPassed),
    runtimePassed: Boolean(state.runtimePassed),
    targetStage: String(state.targetStage || ""),
    recoveryActive: Boolean(state.recoveryActive),
    recoveryTier: String(state.recoveryTier || ""),
    lastRecoveryAction: String(state.lastRecoveryAction || ""),
    updatedAt
  };
}

function parseAutonomousFeedback(projectRoot) {
  const parsed = readJson(path.join(projectRoot, "generated-app", "deploy", "autonomous-feedback-report.json"));
  if (!parsed) {
    return {
      present: false,
      summary: "",
      rootCauses: [],
      actions: []
    };
  }
  return {
    present: true,
    summary: String(parsed.summary || ""),
    rootCauses: Array.isArray(parsed.rootCauses) ? parsed.rootCauses.slice(0, 8).map((v) => String(v)) : [],
    actions: Array.isArray(parsed.actions)
      ? parsed.actions.slice(0, 8).map((row) => ({
          priority: String(row?.priority || ""),
          title: String(row?.title || ""),
          rationale: String(row?.rationale || "")
        }))
      : []
  };
}

function detectIdleBeforeMinimum(campaign, running) {
  if (!campaign?.present) return null;
  const minMinutes = 360;
  const active = Boolean(running?.active);
  const endedOrIdle = campaign.running === false && !active;
  if (!endedOrIdle) return null;
  if (campaign.targetPassed) return null;
  if (Number(campaign.elapsedMinutes || 0) >= minMinutes) return null;
  return {
    failed: true,
    minMinutes,
    elapsedMinutes: Number(campaign.elapsedMinutes || 0),
    message: `Campaign went idle before ${minMinutes} minutes (${campaign.elapsedMinutes}m).`
  };
}

function parsePromptMeta(projectRoot) {
  const metadataFile = path.join(projectRoot, "debug", "provider-prompts.metadata.jsonl");
  const fullFile = path.join(projectRoot, "debug", "provider-prompts.jsonl");
  const rows = readJsonlTail(metadataFile, 20);
  const last = rows.at(-1);
  const full = readJsonlTail(fullFile, 3);
  const lastFull = full.at(-1);
  if (!last) {
    return {
      present: false,
      lastAt: "",
      lastStage: "",
      lastOk: false,
      lastDurationMs: 0,
      recentAvgDurationMs: 0,
      recentMaxDurationMs: 0,
      lastPromptPreview: "",
      lastOutputPreview: "",
      recent: []
    };
  }
  const durations = rows
    .map((row) => Number(row.durationMs || 0))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const sum = durations.reduce((acc, value) => acc + value, 0);
  const avg = durations.length > 0 ? Math.round(sum / durations.length) : 0;
  const max = durations.length > 0 ? Math.max(...durations) : 0;
  const lastDurationMs = Number(last.durationMs || 0);
  const recentFailures = rows.filter((row) => !row?.ok);
  const lastFailure = recentFailures.at(-1) || null;
  return {
    present: true,
    lastAt: String(last.at || ""),
    lastStage: String(last.stage || ""),
    lastOk: Boolean(last.ok),
    lastDurationMs: Number.isFinite(lastDurationMs) ? lastDurationMs : 0,
    recentAvgDurationMs: avg,
    recentMaxDurationMs: max,
    lastPromptPreview: String(last.promptPreview || ""),
    lastOutputPreview: String(last.outputPreview || ""),
    lastError: String(last.error || ""),
    lastFailureAt: String(lastFailure?.at || ""),
    recentFailureCount: recentFailures.length,
    lastPromptFull: typeof lastFull?.prompt === "string" ? lastFull.prompt.slice(0, 3000) : "",
    lastOutputFull: typeof lastFull?.output === "string" ? lastFull.output.slice(0, 3000) : "",
    recent: rows.slice(-6)
  };
}

function parseRuntimeVisualProbe(projectRoot) {
  const parsed = readJson(path.join(projectRoot, "generated-app", "deploy", "runtime-visual-probe.json"));
  if (!parsed) {
    return {
      present: false,
      ok: false,
      captured: false,
      blankLikely: false,
      summary: ""
    };
  }
  return {
    present: true,
    ok: Boolean(parsed.ok),
    captured: Boolean(parsed.captured),
    blankLikely: Boolean(parsed.blankLikely),
    staticLikely: Boolean(parsed.staticLikely),
    summary: String(parsed.summary || ""),
    screenshotPath: String(parsed.screenshotPath || ""),
    stats: parsed.stats && typeof parsed.stats === "object" ? parsed.stats : null
  };
}

function parseSoftwareDiagnostic(projectRoot) {
  const parsed = readJson(path.join(projectRoot, "generated-app", "deploy", "software-diagnostic-report.json"));
  if (!parsed) {
    return {
      present: false,
      summary: "",
      qualityScore: 0,
      blockingIssues: [],
      httpStatus: "",
      reachableUrl: "",
      interactionStatus: "",
      interactionRounds: 0,
      clickableCount: 0,
      clicksPerformed: 0,
      uiLabels: [],
      functionalChecks: [],
      actionTimeline: []
    };
  }
  return {
    present: true,
    summary: String(parsed.summary || ""),
    qualityScore: Number(parsed.qualityScore || 0),
    blockingIssues: Array.isArray(parsed.blockingIssues) ? parsed.blockingIssues.slice(0, 8).map((v) => String(v)) : [],
    httpStatus: String(parsed?.http?.status || ""),
    reachableUrl: String(parsed?.http?.reachableUrl || ""),
    interactionStatus: String(parsed?.interaction?.status || ""),
    interactionRounds: Number(parsed?.interaction?.rounds || 0),
    clickableCount: Number(parsed?.interaction?.clickableCount || 0),
    clicksPerformed: Number(parsed?.interaction?.clicksPerformed || 0),
    uiLabels: Array.isArray(parsed?.interaction?.uiLabels) ? parsed.interaction.uiLabels.slice(0, 20).map((v) => String(v)) : [],
    functionalChecks: Array.isArray(parsed?.interaction?.functionalChecks)
      ? parsed.interaction.functionalChecks.slice(0, 12).map((row) => ({
          name: String(row?.name || ""),
          status: String(row?.status || ""),
          detail: String(row?.detail || "")
        }))
      : [],
    actionTimeline: Array.isArray(parsed?.interaction?.actionTimeline)
      ? parsed.interaction.actionTimeline.slice(-12).map((row) => ({
          at: String(row?.at || ""),
          action: String(row?.action || ""),
          target: String(row?.target || ""),
          result: String(row?.result || ""),
          detail: String(row?.detail || "")
        }))
      : []
  };
}

function parseCampaignDebugReport(projectRoot) {
  const parsed = readJson(path.join(projectRoot, "debug", "campaign-debug-report.json"));
  if (!parsed) {
    return {
      present: false,
      providerIssue: "",
      recoveryTier: "",
      rootCauses: [],
      recommendations: []
    };
  }
  return {
    present: true,
    at: String(parsed.at || ""),
    cycle: Number(parsed.cycle || 0),
    elapsedMinutes: Number(parsed.elapsedMinutes || 0),
    providerIssue: String(parsed.providerIssue || ""),
    recoveryTier: String(parsed.recoveryTier || ""),
    recoveryAction: String(parsed.recoveryAction || ""),
    rootCauses: Array.isArray(parsed.rootCauses) ? parsed.rootCauses.slice(0, 8).map((v) => String(v)) : [],
    recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations.slice(0, 8).map((v) => String(v)) : []
  };
}

function parseCampaignJournal(projectRoot) {
  const file = path.join(projectRoot, "suite-campaign-journal.jsonl");
  return readJsonlTail(file, 40);
}

function parseRecoveryAudit(projectRoot) {
  const file = path.join(projectRoot, "autonomous-recovery-audit.jsonl");
  return readJsonlTail(file, 40);
}

function parseRecoveryEvents(projectRoot) {
  const file = path.join(projectRoot, "life", "recovery-events.jsonl");
  return readJsonlTail(file, 60);
}

function parseProviderSignal({ campaign, prompt, runStatus, campaignJournal }) {
  const recent = Array.isArray(prompt?.recent) ? prompt.recent : [];
  const recentFailures = recent
    .filter((row) => row && row.ok === false)
    .map((row) => ({
      ...row,
      error: String(row?.error || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !/\bdep0040\b|punycode|loaded cached credentials|hook registry initialized/i.test(line))
        .join(" ")
    }))
    .filter((row) => row.error.length > 0 || String(row?.outputPreview || "").trim().length > 0);
  const lastFailure = recentFailures.at(-1);
  const outputPreview = String(prompt?.lastOutputPreview || "").toLowerCase();
  const lastErrorText = String(lastFailure?.error || prompt?.lastError || campaign?.lastError || "").toLowerCase();
  const nonDelivery =
    outputPreview.includes("ready for your command") ||
    outputPreview.trim() === "" ||
    lastErrorText.includes("empty output");
  const providerBlocked = /provider_backoff|provider_blocked|provider_quota_recovery/i.test(String(campaign?.phase || ""));
  const quotaLike = /quota|capacity|429|terminalquotaerror/i.test(lastErrorText);
  const journalBlocked = (campaignJournal || []).some((row) => /campaign\.provider\.blocked/i.test(String(row?.event || "")));

  let state = "healthy";
  let summary = "Provider delivering responses.";
  if (providerBlocked || journalBlocked || quotaLike) {
    state = "blocked";
    summary = "Provider delivery blocked (quota/capacity or hard failure).";
  } else if (nonDelivery || recentFailures.length >= 2) {
    state = "degraded";
    summary = "Provider is responding but not delivering usable payloads consistently.";
  }

  const summarizeReason = (input) => {
    const raw = String(input || "");
    const compact = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !/\bdep0040\b|punycode|loaded cached credentials|hook registry initialized/i.test(line))
      .join(" ");
    const reset = compact.match(/quota will reset after\s+([^.,]+)/i)?.[1]?.trim();
    if (/\bterminalquotaerror\b|\bretryablequotaerror\b|\bexhausted your capacity\b|\bcode:\s*429\b|\b429\b/i.test(compact)) {
      return reset ? `Provider quota exhausted (resets in ${reset}).` : "Provider quota exhausted (HTTP 429).";
    }
    if (/\betimedout\b|\btimed out\b/i.test(compact)) {
      return "Provider call timed out before response.";
    }
    if (/\bempty output\b|ready for your command/i.test(compact)) {
      return "Provider returned non-delivery/empty payload.";
    }
    if (!compact) {
      return "Provider delivery blocked.";
    }
    return compact.length > 180 ? `${compact.slice(0, 180)}...` : compact;
  };
  const blockingReason = state === "blocked" ? summarizeReason(campaign?.lastError || lastFailure?.error || "provider delivery blocked") : "";
  const recentFailuresCompact = recentFailures.slice(-4).map((row) => ({
    at: String(row.at || ""),
    stage: String(row.stage || ""),
    error: String(row.error || "")
  }));

  return {
    state,
    summary,
    nonDelivery,
    recentFailureCount: recentFailures.length,
    blockingReason,
    recentFailures: recentFailuresCompact,
    lastFailureAt: String(lastFailure?.at || "")
  };
}

function summarizeBlockerReason(reason) {
  const text = String(reason || "");
  if (!text) return "No blocker reason recorded.";
  if (/quota|429|capacity/i.test(text)) return text;
  if (/timeout|timed out|etimedout/i.test(text)) return "Provider timeout while waiting for model response.";
  if (/empty output|non-delivery|ready for your command/i.test(text)) return "Provider returned empty/non-actionable output.";
  if (/lifecycle|build|test|lint|smoke/i.test(text)) return "Quality gate failure in lifecycle checks.";
  return text.length > 140 ? `${text.slice(0, 140)}...` : text;
}

function findLastPassedStage(stageTimeline) {
  if (!Array.isArray(stageTimeline)) return "";
  const reversed = [...stageTimeline].reverse();
  const hit = reversed.find((row) => String(row?.status || "").toLowerCase() === "passed");
  return String(hit?.stage || "");
}

function listSddProcesses() {
  try {
    if (process.platform === "win32") {
      try {
        const psCmd =
          "powershell -NoProfile -Command \"Get-CimInstance Win32_Process -Filter \\\"Name='node.exe'\\\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress\"";
        const rawPs = execSync(psCmd, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 4500 }).trim();
        if (rawPs) {
          const parsed = JSON.parse(rawPs);
          const rows = (Array.isArray(parsed) ? parsed : [parsed])
            .map((row) => ({
              processId: Number(row?.ProcessId || 0),
              command: String(row?.CommandLine || "").trim()
            }))
            .filter((row) => Number.isFinite(row.processId) && row.processId > 0 && /dist[\\/]cli\.js/i.test(row.command));
          if (rows.length > 0) {
            return rows;
          }
        }
      } catch {
        // fallback to wmic
      }
      const cmd = "wmic process where \"name='node.exe'\" get ProcessId,CommandLine /format:csv";
      const raw = execSync(cmd, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 4000 }).trim();
      if (!raw) return [];
      const rows = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(1)
        .map((line) => {
          const pieces = line.split(",");
          if (pieces.length < 3) return null;
          const processId = Number(pieces.at(-1) || 0);
          const command = pieces.slice(1, -1).join(",").trim();
          return { processId, command };
        })
        .filter((row) => row && Number.isFinite(row.processId) && row.processId > 0 && /dist[\\/]cli\.js/i.test(row.command));
      return rows
        .map((row) => ({ processId: row.processId, command: row.command }))
        .filter((row) => row.command);
    }
    const raw = execSync("ps -ax -o pid= -o command=", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const firstSpace = line.indexOf(" ");
        if (firstSpace <= 0) return null;
        const processId = Number.parseInt(line.slice(0, firstSpace).trim(), 10);
        const command = line.slice(firstSpace + 1).trim();
        return { processId, command };
      })
      .filter((row) => row && Number.isFinite(row.processId) && /dist\/cli\.js/i.test(row.command));
  } catch {
    return [];
  }
}

function parseSuiteLock(workspaceRoot) {
  const lockFile = path.join(workspaceRoot, ".sdd-suite-lock.json");
  const parsed = readJson(lockFile);
  const pid = Number(parsed?.pid || 0);
  if (!Number.isFinite(pid) || pid <= 0) {
    return { present: false, pid: 0, startedAt: "" };
  }
  return {
    present: true,
    pid,
    startedAt: String(parsed?.startedAt || "")
  };
}

function resolveStateBaseDir(appName = "sdd-cli") {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, appName);
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", appName);
  }
  const xdg = process.env.XDG_STATE_HOME || process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim().length > 0) {
    return path.join(xdg.trim(), appName);
  }
  return path.join(os.homedir(), ".local", "state", appName);
}

function parseModelAvailabilityCache() {
  const cacheFile = path.join(resolveStateBaseDir("sdd-cli"), "state", "model-availability-cache.json");
  const parsed = readJson(cacheFile);
  const geminiPriority = [
    "gemini-3-pro-preview",
    "gemini-2.5-pro",
    "gemini-3-flash-preview",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash"
  ];
  const buildCatalog = (entries) =>
    geminiPriority.map((model) => {
      const blocked = entries.find((entry) => entry.provider === "gemini" && entry.model === model);
      return {
        provider: "gemini",
        model,
        status: blocked ? "blocked" : "ready",
        remainingMinutes: blocked ? blocked.remainingMinutes : 0,
        reason: blocked ? blocked.reason : ""
      };
    });
  if (!parsed || typeof parsed !== "object") {
    return {
      present: false,
      file: cacheFile,
      entries: [],
      catalog: buildCatalog([]),
      summary: { totalUnavailable: 0, activeProviders: 0, nearestResetMinutes: null, readyKnownModels: geminiPriority.length }
    };
  }
  const providers = parsed?.providers && typeof parsed.providers === "object" ? parsed.providers : {};
  const now = Date.now();
  const entries = [];
  for (const [provider, models] of Object.entries(providers)) {
    if (!models || typeof models !== "object") continue;
    for (const [model, row] of Object.entries(models)) {
      const unavailableUntilMs = Number(row?.unavailableUntilMs || 0);
      if (!Number.isFinite(unavailableUntilMs) || unavailableUntilMs <= now) continue;
      const remainingMs = Math.max(0, unavailableUntilMs - now);
      const remainingMinutes = Math.ceil(remainingMs / 60000);
      entries.push({
        provider: String(provider || ""),
        model: String(model || ""),
        reason: String(row?.reason || ""),
        hint: String(row?.hint || ""),
        updatedAt: String(row?.updatedAt || ""),
        unavailableUntilMs,
        unavailableUntil: new Date(unavailableUntilMs).toISOString(),
        remainingMs,
        remainingMinutes
      });
    }
  }
  entries.sort((a, b) => a.remainingMs - b.remainingMs);
  const activeProviders = new Set(entries.map((entry) => entry.provider).filter(Boolean)).size;
  const nearestResetMinutes = entries.length > 0 ? entries[0].remainingMinutes : null;
  const catalog = buildCatalog(entries);
  return {
    present: true,
    file: cacheFile,
    entries,
    catalog,
    summary: {
      totalUnavailable: entries.length,
      activeProviders,
      nearestResetMinutes,
      readyKnownModels: catalog.filter((item) => item.status === "ready").length
    }
  };
}

function commandMentionsProject(command, projectName) {
  const normalized = String(command || "").replace(/\s+/g, " ").trim().toLowerCase();
  const target = String(projectName || "").trim().toLowerCase();
  if (!normalized || !target) return false;
  if (normalized.includes(`--project "${target}"`) || normalized.includes(`--project '${target}'`)) {
    return true;
  }
  if (normalized.includes(`--project ${target}`)) {
    return true;
  }
  return normalized.includes(target);
}

function detectRunningProcess(projectName, processRows) {
  const hit = processRows.find((row) => {
    const normalized = String(row.command || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!/(\s|^)suite(\s|$)/.test(normalized)) return false;
    return commandMentionsProject(normalized, projectName);
  });
  if (!hit) {
    return { active: false, processId: 0, command: "" };
  }
  return { active: true, processId: hit.processId, command: hit.command.slice(0, 400) };
}

function isProcessAlive(pid) {
  const value = Number(pid || 0);
  if (!Number.isFinite(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch {
    return false;
  }
}

function parseReleases(projectRoot) {
  const history = readJson(path.join(projectRoot, "generated-app", "deploy", "release-history.json"));
  const releases = Array.isArray(history?.releases) ? history.releases : [];
  return {
    total: releases.length,
    candidates: releases.filter((row) => row.stage === "candidate").length,
    finals: releases.filter((row) => row.stage === "final").length,
    last: releases.at(-1) || null
  };
}

function computeValueScore(stage, lifecycle, review, releases) {
  let score = 100;
  score -= lifecycle.fail * 12;
  score -= lifecycle.skipped * 3;
  if (!review.present) score -= 8;
  if (review.present && !review.passed) score -= 20;
  if (stage.stages?.final_release !== "passed") score -= 10;
  if (stage.stages?.runtime_start !== "passed") score -= 8;
  if (releases.finals === 0) score -= 8;
  return Math.max(0, Math.min(100, score));
}

function getProjectHealth(stage, lifecycle, review) {
  const finalPassed = stage.stages?.final_release === "passed";
  const runtimePassed = stage.stages?.runtime_start === "passed";
  if (finalPassed && runtimePassed && lifecycle.fail === 0 && (review.present ? review.passed : true)) {
    return "healthy";
  }
  if (lifecycle.fail > 0 || stage.stages?.quality_validation === "failed" || stage.stages?.role_review === "failed") {
    return "critical";
  }
  return "in_progress";
}

function inferLastEvent({ stageTimeline, campaignJournal, journal, prompt }) {
  const candidates = [];
  const stageLast = Array.isArray(stageTimeline) ? stageTimeline.at(-1) : null;
  if (stageLast?.at) {
    candidates.push({
      at: String(stageLast.at),
      source: "stage",
      summary: `${String(stageLast.stage || "stage")} -> ${String(stageLast.status || "unknown")}`
    });
  }
  const campaignLast = Array.isArray(campaignJournal) ? campaignJournal.at(-1) : null;
  if (campaignLast?.at) {
    candidates.push({
      at: String(campaignLast.at),
      source: "campaign",
      summary: `${String(campaignLast.event || "campaign")}${campaignLast.details ? `: ${String(campaignLast.details).slice(0, 180)}` : ""}`
    });
  }
  const runLast = Array.isArray(journal) ? journal.at(-1) : null;
  if (runLast?.at) {
    candidates.push({
      at: String(runLast.at),
      source: "orchestration",
      summary: `${String(runLast.event || "run")}${runLast.details ? `: ${String(runLast.details).slice(0, 180)}` : ""}`
    });
  }
  if (prompt?.lastAt) {
    candidates.push({
      at: String(prompt.lastAt),
      source: "prompt",
      summary: `prompt ${String(prompt.lastStage || "unknown")} ${prompt.lastOk ? "ok" : "fail"}`
    });
  }
  if (candidates.length === 0) {
    return { at: "", source: "", summary: "" };
  }
  candidates.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
  return candidates.at(-1) || { at: "", source: "", summary: "" };
}

function suggestRecoveryCommand(projectName, stage, lifecycle) {
  const base = `node dist/cli.js --provider gemini --non-interactive --project "${projectName}" --iterations 10 --max-runtime-minutes 120`;
  const failure = (lifecycle.lastFailure || "").toLowerCase();
  if (stage.current === "quality_validation" || lifecycle.fail > 0) {
    let hint = "continue improving quality; fix all lifecycle FAIL items, rerun tests/build/smoke, then progress release";
    if (failure.includes("smoke")) hint = "add a real smoke script and make it pass with local runtime checks";
    if (failure.includes("readme")) hint = "fix README root with Features/Run/Testing/Release sections and align docs to project";
    if (failure.includes("jest") || failure.includes("unexpected token")) hint = "fix module format and jest config; make tests pass consistently";
    return `${base} --from-step finish hello "${hint}"`;
  }
  if (stage.current === "role_review") {
    return `${base} --from-step finish hello "implement reviewer findings and convert them into prioritized user stories"`;
  }
  if (stage.current === "release_candidate" || stage.current === "final_release") {
    return `${base} --from-step finish hello "finalize release artifacts, push tags, and publish final release"`;
  }
  return `${base} hello "continue delivery to final release and runtime start with production quality"`;
}

function parseOrchestrationJournal(projectRoot) {
  const file = path.join(projectRoot, "orchestration-journal.jsonl");
  const rows = readJsonlTail(file, 20);
  return rows.slice(-8);
}

function parseIterationMetrics(projectRoot) {
  const file = path.join(projectRoot, "generated-app", "deploy", "iteration-metrics.json");
  const parsed = readJson(file);
  const metrics = Array.isArray(parsed?.metrics) ? parsed.metrics : [];
  if (metrics.length === 0) {
    return {
      total: 0,
      passed: 0,
      failed: 0,
      lastRound: 0,
      lastPhase: "",
      lastResult: "",
      recent: []
    };
  }
  const passed = metrics.filter((item) => item?.result === "passed").length;
  const failed = metrics.filter((item) => item?.result === "failed").length;
  const last = metrics[metrics.length - 1] || {};
  return {
    total: metrics.length,
    passed,
    failed,
    lastRound: Number(last.round || 0),
    lastPhase: String(last.phase || ""),
    lastResult: String(last.result || ""),
    recent: metrics.slice(-8)
  };
}

function parseLifeArtifacts(projectRoot) {
  const lifeRoot = path.join(projectRoot, "life");
  const tracks = ["users", "stakeholders", "design", "marketing", "quality"];
  const data = {};
  for (const track of tracks) {
    const file = path.join(lifeRoot, `${track}-rounds.jsonl`);
    const rows = readJsonlTail(file, 25);
    data[track] = {
      count: rows.length,
      last: rows.at(-1) || null,
      recent: rows.slice(-8)
    };
  }
  const summaryFile = path.join(lifeRoot, "summary.md");
  return {
    present: fs.existsSync(lifeRoot),
    summaryPath: fs.existsSync(summaryFile) ? "life/summary.md" : "",
    summaryPreview: readText(summaryFile).slice(0, 1200),
    tracks: data
  };
}

function findLatestRequirementDir(projectRoot) {
  const bases = ["backlog", "wip", "in-progress", "done", "archived"].map((status) =>
    path.join(projectRoot, "requirements", status)
  );
  let latest = { dir: "", mtimeMs: 0 };
  for (const base of bases) {
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(base, entry.name);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(full).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      if (mtimeMs >= latest.mtimeMs) {
        latest = { dir: full, mtimeMs };
      }
    }
  }
  return latest.dir || "";
}

function findByCandidates(root, candidates) {
  for (const rel of candidates) {
    const full = path.join(root, rel);
    if (fs.existsSync(full)) {
      return rel.replace(/\\/g, "/");
    }
  }
  return "";
}

function parseStageProducts(projectRoot, releases) {
  const appRoot = path.join(projectRoot, "generated-app");
  const latestReq = findLatestRequirementDir(projectRoot);
  const reqRel = latestReq ? path.relative(projectRoot, latestReq).replace(/\\/g, "/") : "";
  const inReq = (file) => (reqRel ? `${reqRel}/${file}` : `requirements/**/${file}`);
  const hasReqFile = (file) => (latestReq ? fs.existsSync(path.join(latestReq, file)) : false);

  const catalog = {
    discovery: [
      { label: "Project metadata", path: "metadata.json", present: fs.existsSync(path.join(projectRoot, "metadata.json")) },
      { label: "Run status", path: "sdd-run-status.json", present: fs.existsSync(path.join(projectRoot, "sdd-run-status.json")) },
      { label: "Orchestration journal", path: "orchestration-journal.jsonl", present: fs.existsSync(path.join(projectRoot, "orchestration-journal.jsonl")) }
    ],
    functional_requirements: [
      { label: "Requirement document", path: inReq("requirement.md"), present: hasReqFile("requirement.md") },
      { label: "Functional spec", path: inReq("functional-spec.md"), present: hasReqFile("functional-spec.md") }
    ],
    technical_backlog: [
      { label: "Technical spec", path: inReq("technical-spec.md"), present: hasReqFile("technical-spec.md") },
      { label: "Architecture", path: inReq("architecture.md"), present: hasReqFile("architecture.md") },
      { label: "Test plan", path: inReq("test-plan.md"), present: hasReqFile("test-plan.md") }
    ],
    implementation: [
      { label: "Generated app root", path: "generated-app/", present: fs.existsSync(appRoot) },
      {
        label: "Runtime manifest",
        path: findByCandidates(appRoot, ["package.json", "requirements.txt", "backend/pom.xml", "frontend/package.json"]) || "generated-app/{package.json|requirements.txt|backend/pom.xml|frontend/package.json}",
        present:
          fs.existsSync(path.join(appRoot, "package.json")) ||
          fs.existsSync(path.join(appRoot, "requirements.txt")) ||
          fs.existsSync(path.join(appRoot, "backend", "pom.xml")) ||
          fs.existsSync(path.join(appRoot, "frontend", "package.json"))
      },
      { label: "README", path: "generated-app/README.md", present: fs.existsSync(path.join(appRoot, "README.md")) }
    ],
    quality_validation: [
      { label: "Lifecycle report", path: "generated-app/deploy/lifecycle-report.json", present: fs.existsSync(path.join(appRoot, "deploy", "lifecycle-report.json")) },
      { label: "Iteration metrics", path: "generated-app/deploy/iteration-metrics.json", present: fs.existsSync(path.join(appRoot, "deploy", "iteration-metrics.json")) },
      { label: "Quality backlog", path: "generated-app/deploy/quality-backlog.json", present: fs.existsSync(path.join(appRoot, "deploy", "quality-backlog.json")) }
    ],
    role_review: [
      { label: "Digital review report", path: "generated-app/deploy/digital-review-report.json", present: fs.existsSync(path.join(appRoot, "deploy", "digital-review-report.json")) },
      { label: "User stories backlog", path: "generated-app/deploy/digital-review-user-stories.md", present: fs.existsSync(path.join(appRoot, "deploy", "digital-review-user-stories.md")) },
      { label: "Review rounds", path: "generated-app/deploy/digital-review-rounds.json", present: fs.existsSync(path.join(appRoot, "deploy", "digital-review-rounds.json")) },
      { label: "Life review summary", path: "life/summary.md", present: fs.existsSync(path.join(projectRoot, "life", "summary.md")) }
    ],
    release_candidate: [
      { label: "Release history", path: "generated-app/deploy/release-history.json", present: fs.existsSync(path.join(appRoot, "deploy", "release-history.json")) },
      { label: "Candidate releases", path: "generated-app/deploy/releases/", present: releases.candidates > 0 }
    ],
    final_release: [
      { label: "Final release history", path: "generated-app/deploy/release-history.json", present: releases.finals > 0 },
      { label: "Deployment report", path: "generated-app/deploy/deployment.md", present: fs.existsSync(path.join(appRoot, "deploy", "deployment.md")) },
      { label: "Life summary", path: "life/summary.md", present: fs.existsSync(path.join(projectRoot, "life", "summary.md")) }
    ],
    runtime_start: [
      { label: "Runtime process metadata", path: "generated-app/deploy/runtime-processes.json", present: fs.existsSync(path.join(appRoot, "deploy", "runtime-processes.json")) },
      { label: "Runtime visual probe", path: "generated-app/deploy/runtime-visual-probe.json", present: fs.existsSync(path.join(appRoot, "deploy", "runtime-visual-probe.json")) },
      { label: "Software diagnostics", path: "generated-app/deploy/software-diagnostic-report.json", present: fs.existsSync(path.join(appRoot, "deploy", "software-diagnostic-report.json")) },
      { label: "Campaign state", path: "suite-campaign-state.json", present: fs.existsSync(path.join(projectRoot, "suite-campaign-state.json")) }
    ]
  };
  return catalog;
}

function buildStageResults(stage, stageProducts) {
  return STAGE_ORDER.map((name) => {
    const status = String(stage?.stages?.[name] || "pending");
    const products = Array.isArray(stageProducts?.[name]) ? stageProducts[name] : [];
    const present = products.filter((item) => item?.present).length;
    const total = products.length;
    return {
      stage: name,
      status,
      artifactsPresent: present,
      artifactsTotal: total
    };
  });
}

function suggestAutoActionsFromText(text) {
  const lower = String(text || "").toLowerCase();
  const actions = [];
  if (lower.includes("terminalquotaerror") || lower.includes("exhausted your capacity") || lower.includes("429")) {
    actions.push("rotate provider model and apply provider backoff");
  }
  if (lower.includes("ready for your command") || lower.includes("empty output")) {
    actions.push("mark provider non-delivery and force regeneration retry");
  }
  if (lower.includes("jest encountered an unexpected token") || lower.includes("unexpected token 'export'")) {
    actions.push("normalize module format and align jest config automatically");
  }
  if (lower.includes("eslint plugin") || lower.includes("eslint couldn't find")) {
    actions.push("install missing eslint plugins/deps and regenerate lint config");
  }
  if (lower.includes("build for macos is supported only on macos")) {
    actions.push("rewrite build scripts for host OS compatibility");
  }
  if (lower.includes("missing smoke/e2e npm script") || lower.includes("smoke")) {
    actions.push("create cross-platform smoke script and wire package.json");
  }
  if (lower.includes("missing dummylocal integration doc")) {
    actions.push("generate dummy-local.md integration artifact");
  }
  if (lower.includes("readme")) {
    actions.push("normalize README sections and release artifact guidance");
  }
  return [...new Set(actions)].slice(0, 3);
}

function buildTopBlockers({ lifecycle, runStatus, providerSignal, blockReasons }) {
  const candidates = [];
  const runBlockers = Array.isArray(runStatus?.blockers) ? runStatus.blockers : [];
  for (const reason of runBlockers.slice(0, 8)) {
    const actions = suggestAutoActionsFromText(reason);
    candidates.push({
      source: "run-status",
      reason: String(reason || ""),
      actions
    });
  }
  const lifeFailures = Array.isArray(lifecycle?.failItems) ? lifecycle.failItems : [];
  for (const reason of lifeFailures.slice(0, 8)) {
    const actions = suggestAutoActionsFromText(reason);
    candidates.push({
      source: "lifecycle",
      reason: String(reason || ""),
      actions
    });
  }
  if (providerSignal?.state === "blocked" || providerSignal?.state === "degraded") {
    const reason = providerSignal.blockingReason || providerSignal.summary || "provider delivery degraded";
    const actions = suggestAutoActionsFromText(reason);
    candidates.push({
      source: "provider",
      reason: String(reason),
      actions
    });
  }
  if (candidates.length === 0) {
    return [];
  }
  const scored = candidates.map((item) => {
    let severity = 1;
    const lower = item.reason.toLowerCase();
    if (/quota|capacity|429|terminalquotaerror|provider/i.test(lower)) severity = 5;
    else if (/build|test|lint|smoke|failed|error/i.test(lower)) severity = 4;
    else if (/missing|pending|blocked/i.test(lower)) severity = 3;
    return { ...item, severity };
  });
  scored.sort((a, b) => b.severity - a.severity);
  const unique = [];
  const seen = new Set();
  for (const item of scored) {
    const key = item.reason.slice(0, 120).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
    if (unique.length >= 3) break;
  }
  return unique;
}

function isoToMs(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildStageProgress(stage) {
  const completed = STAGE_ORDER.filter((name) => stage.stages?.[name] === "passed").length;
  const currentIndex = Math.max(0, STAGE_ORDER.indexOf(stage.current));
  const percent = STAGE_ORDER.length === 0 ? 0 : Math.round((completed / STAGE_ORDER.length) * 100);
  return {
    order: STAGE_ORDER,
    completed,
    total: STAGE_ORDER.length,
    currentIndex,
    percent
  };
}

function buildActivitySignals({ runStatus, prompt, campaign, stageTimeline, running }) {
  const lastRunStatusMs = isoToMs(runStatus.raw?.at);
  const lastPromptMs = isoToMs(prompt.lastAt);
  const lastCampaignMs = isoToMs(campaign.updatedAt);
  const lastStageMs = isoToMs(stageTimeline.at(-1)?.at);
  const freshestMs = Math.max(lastRunStatusMs, lastPromptMs, lastCampaignMs, lastStageMs, 0);
  const freshnessMinutes = freshestMs > 0 ? Math.floor((Date.now() - freshestMs) / 60000) : Number.POSITIVE_INFINITY;
  const activeRun = Boolean(running?.active || campaign.running);
  const staleThresholdMinutes = activeRun ? 8 : 20;
  const stalled = activeRun && freshnessMinutes >= staleThresholdMinutes;
  return {
    lastRunStatusAt: runStatus.raw?.at || "",
    lastPromptAt: prompt.lastAt || "",
    lastCampaignAt: campaign.updatedAt || "",
    freshestAt: freshestMs > 0 ? new Date(freshestMs).toISOString() : "",
    freshnessMinutes: Number.isFinite(freshnessMinutes) ? freshnessMinutes : 9999,
    stalled,
    staleThresholdMinutes
  };
}

function inferRecoveryState({ campaign, runStatus, recoveryAudit, activity }) {
  const latestAudit = Array.isArray(recoveryAudit) ? recoveryAudit.at(-1) : null;
  const latestAuditMs = isoToMs(latestAudit?.at);
  const recentAudit = latestAuditMs > 0 && Date.now() - latestAuditMs <= 20 * 60 * 1000;
  const campaignPhase = String(campaign?.phase || "");
  const phaseRecovery = /recovery|provider_backoff|provider_quota_recovery|runtime_enforced_continue/i.test(campaignPhase);
  const campaignRecovery = Boolean(campaign?.recoveryActive) || Boolean(campaign?.lastRecoveryAction);
  const runStatusRecovery = Boolean(runStatus?.recovery?.command);
  const fresh = Number(activity?.freshnessMinutes || 9999) <= 30;
  const active = fresh && (phaseRecovery || campaignRecovery || recentAudit || runStatusRecovery);
  const tier = String(campaign?.recoveryTier || latestAudit?.tier || "none");
  const lastAction = String(campaign?.lastRecoveryAction || latestAudit?.action || "");
  const lastAt = String(campaign?.updatedAt || latestAudit?.at || "");
  return {
    active,
    tier,
    lastAction,
    lastAt,
    source: campaign?.lastRecoveryAction ? "campaign" : latestAudit?.action ? "audit" : runStatusRecovery ? "run-status" : ""
  };
}

function buildProjectRow(projectRoot, name, processRows) {
  const lifecycle = parseLifecycle(projectRoot);
  const review = parseDigitalReview(projectRoot);
  const stage = parseStage(projectRoot);
  const campaign = parseCampaign(projectRoot);
  const prompt = parsePromptMeta(projectRoot);
  const runtimeVisualProbe = parseRuntimeVisualProbe(projectRoot);
  const softwareDiagnostic = parseSoftwareDiagnostic(projectRoot);
  const autonomousFeedback = parseAutonomousFeedback(projectRoot);
  const campaignDebug = parseCampaignDebugReport(projectRoot);
  const runStatus = parseRunStatus(projectRoot);
  const releases = parseReleases(projectRoot);
  const iterationMetrics = parseIterationMetrics(projectRoot);
  const life = parseLifeArtifacts(projectRoot);
  const campaignJournal = parseCampaignJournal(projectRoot);
  const recoveryAudit = parseRecoveryAudit(projectRoot);
  const recoveryEvents = parseRecoveryEvents(projectRoot);
  const running = detectRunningProcess(name, processRows);
  if (!running.active && campaign.present && campaign.running !== false && !campaign.targetPassed && campaign.updatedAt && isProcessAlive(campaign.suitePid)) {
    const updatedMs = Date.parse(campaign.updatedAt);
    if (Number.isFinite(updatedMs) && Date.now() - updatedMs <= 300000) {
      running.active = true;
      running.command = campaign.phase ? `suite ${campaign.phase}` : "inferred from fresh campaign state";
      running.processId = Number(campaign.suitePid || 0);
    }
  }
  const campaignPidAlive = Number(campaign.suitePid || 0) > 0 ? isProcessAlive(Number(campaign.suitePid || 0)) : false;
  if (campaign.present && campaign.running && !campaignPidAlive && !running.active) {
    campaign.running = false;
    if (!campaign.lastError) {
      campaign.lastError = "campaign state was running=true but suitePid is not alive";
    }
  }
  if (!running.active && runStatus.present && (!campaign.present || campaign.running !== false)) {
    const runUpdatedMs = Date.parse(runStatus.raw?.at || "");
    if (Number.isFinite(runUpdatedMs) && Date.now() - runUpdatedMs <= 180000) {
      running.active = true;
      running.command = "inferred from fresh run-status activity";
    }
  }
  const idleBeforeMinimum = detectIdleBeforeMinimum(campaign, running);
  const valueScore = computeValueScore(stage, lifecycle, review, releases);
  const recovery = suggestRecoveryCommand(name, stage, lifecycle);
  const stageProducts = parseStageProducts(projectRoot, releases);
  const stageResults = buildStageResults(stage, stageProducts);
  const providerSignal = parseProviderSignal({ campaign, prompt, runStatus, campaignJournal });
  const stageTimeline = Array.isArray(stage.history)
    ? stage.history.slice(-10).map((row) => ({
        at: String(row?.at || ""),
        stage: String(row?.stage || ""),
        status: String(row?.status || row?.state || "")
      }))
    : [];
  const activity = buildActivitySignals({ runStatus, prompt, campaign, stageTimeline, running });
  const recoveryState = inferRecoveryState({ campaign, runStatus, recoveryAudit, activity });
  const blocked =
    Boolean(idleBeforeMinimum?.failed) ||
    Boolean(activity.stalled) ||
    lifecycle.fail > 0 ||
    (runStatus.blockers || []).length > 0;
  const isActiveWindow = Number(activity.freshnessMinutes || 9999) <= 120 || running.active || campaign.running;
  const recovering = blocked && isActiveWindow && recoveryState.active;
  const health = blocked ? (isActiveWindow ? (recovering ? "recovering" : "critical") : "dormant") : getProjectHealth(stage, lifecycle, review);
  const blockReasons = [];
  if (idleBeforeMinimum?.failed) blockReasons.push("idle-before-minimum-runtime");
  if (activity.stalled) blockReasons.push(`stalled-no-heartbeat-${activity.freshnessMinutes}m`);
  if ((runStatus.blockers || []).length > 0) blockReasons.push("run-status-blockers");
  if (lifecycle.fail > 0) blockReasons.push("lifecycle-failures");
  if (providerSignal.state === "blocked") blockReasons.push("provider-delivery-blocked");
  if (providerSignal.state === "degraded") blockReasons.push("provider-delivery-degraded");
  const topBlockers = buildTopBlockers({ lifecycle, runStatus, providerSignal, blockReasons });
  const primaryBlocker = topBlockers.length > 0
    ? {
        source: String(topBlockers[0].source || ""),
        reason: summarizeBlockerReason(topBlockers[0].reason || ""),
        actions: Array.isArray(topBlockers[0].actions) ? topBlockers[0].actions : []
      }
    : {
        source: "",
        reason: "No critical blocker detected.",
        actions: []
      };
  const recommendedNextAction =
    autonomousFeedback.actions?.[0]?.title ||
    topBlockers?.[0]?.actions?.[0] ||
    (topBlockers?.[0]?.reason ? `Resolve blocker: ${String(topBlockers[0].reason).slice(0, 120)}` : "Continue lifecycle to next gate");
  const journal = parseOrchestrationJournal(projectRoot);
  const lastEvent = inferLastEvent({ stageTimeline, campaignJournal, journal, prompt });

  return {
    name,
    projectRoot,
    stage,
    lifecycle,
    review,
    campaign,
    stageTimeline,
    stageProgress: buildStageProgress(stage),
    prompt,
    runStatus,
    releases,
    iterationMetrics,
    life,
    stageProducts,
    stageResults,
    runtimeVisualProbe,
    softwareDiagnostic,
    autonomousFeedback,
    campaignDebug,
    providerSignal,
    topBlockers,
    primaryBlocker,
    lastPassedStage: findLastPassedStage(stageTimeline),
    recommendedNextAction,
    recoveryState,
    recoveryAudit: recoveryAudit.slice(-10),
    recoveryEvents: recoveryEvents.slice(-12),
    running,
    activity,
    blocked,
    blockReasons,
    idleBeforeMinimum,
    health,
    valueScore,
    recovery: runStatus.recovery?.command || recovery,
    journal,
    campaignJournal: campaignJournal.slice(-10),
    lastEvent,
    updatedAt: fs.statSync(projectRoot).mtime.toISOString()
  };
}

export async function scanProjects(explicitWorkspace) {
  const workspaceRoot = resolveWorkspaceRoot(explicitWorkspace);
  const projects = [];
  const processRows = listSddProcesses();
  const suiteLock = parseSuiteLock(workspaceRoot);
  const modelCooldowns = parseModelAvailabilityCache();

  if (fs.existsSync(workspaceRoot)) {
    const entries = fs.readdirSync(workspaceRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    for (const entry of entries) {
      const projectRoot = path.join(workspaceRoot, entry.name);
      const looksLikeProject =
        fs.existsSync(path.join(projectRoot, "metadata.json")) ||
        fs.existsSync(path.join(projectRoot, ".sdd-stage-state.json")) ||
        fs.existsSync(path.join(projectRoot, "requirements")) ||
        fs.existsSync(path.join(projectRoot, "sdd-run-status.json")) ||
        fs.existsSync(path.join(projectRoot, "debug", "provider-prompts.metadata.jsonl")) ||
        fs.existsSync(path.join(projectRoot, "suite-campaign-state.json"));
      if (!looksLikeProject) continue;
      projects.push(buildProjectRow(projectRoot, entry.name, processRows));
    }
  }

  if (suiteLock.present && isProcessAlive(suiteLock.pid)) {
    const candidate = projects
      .filter((project) => {
        const campaignActive = project.campaign?.present && project.campaign?.running !== false;
        const freshRunStatus = project.runStatus?.present && Number(project.activity?.freshnessMinutes || 9999) <= 5;
        return campaignActive || freshRunStatus;
      })
      .sort((a, b) => {
        const aFreshRun = a.runStatus?.present && Number(a.activity?.freshnessMinutes || 9999) <= 5 ? 1 : 0;
        const bFreshRun = b.runStatus?.present && Number(b.activity?.freshnessMinutes || 9999) <= 5 ? 1 : 0;
        if (aFreshRun !== bFreshRun) {
          return bFreshRun - aFreshRun;
        }
        const aMs = Date.parse(a.activity?.freshestAt || a.campaign?.updatedAt || a.updatedAt || "") || 0;
        const bMs = Date.parse(b.activity?.freshestAt || b.campaign?.updatedAt || b.updatedAt || "") || 0;
        return bMs - aMs;
      })[0];
    if (candidate) {
      for (const project of projects) {
        if (project.name !== candidate.name && Number(project.running?.processId || 0) === suiteLock.pid) {
          project.running.active = false;
          project.running.processId = 0;
          project.running.command = "";
        }
      }
      candidate.running.active = true;
      candidate.running.processId = suiteLock.pid;
      candidate.running.command = "inferred from workspace suite lock";
    }
  }

  projects.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));

  const summary = {
    total: projects.length,
    healthy: projects.filter((p) => p.health === "healthy").length,
    recovering: projects.filter((p) => p.health === "recovering").length,
    critical: projects.filter((p) => p.health === "critical").length,
    unhealthy: projects.filter((p) => p.health !== "healthy").length,
    runningCampaigns: projects.filter((p) => p.campaign.present && (p.campaign.running || p.running.active)).length,
    runningProcesses: projects.filter((p) => p.running.active).length,
    idleBeforeMinimum: projects.filter((p) => p.idleBeforeMinimum?.failed).length,
    stalledProjects: projects.filter((p) => p.activity?.stalled).length,
    blockedProjects: projects.filter((p) => p.blocked).length,
    dormant: projects.filter((p) => p.health === "dormant").length,
    avgValueScore: projects.length === 0 ? 0 : Math.round(projects.reduce((acc, p) => acc + p.valueScore, 0) / projects.length)
  };

  return {
    at: new Date().toISOString(),
    workspaceRoot,
    summary,
    modelCooldowns,
    projects
  };
}

export async function getProjectDetail(projectName, explicitWorkspace) {
  const snapshot = await scanProjects(explicitWorkspace);
  const project = snapshot.projects.find((item) => item.name === projectName);
  return {
    at: snapshot.at,
    workspaceRoot: snapshot.workspaceRoot,
    project: project || null
  };
}
