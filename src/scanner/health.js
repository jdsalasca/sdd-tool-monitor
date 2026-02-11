import { isoToMs } from "./file-utils.js";
import { STAGE_ORDER } from "./stages.js";

export function computeValueScore(stage, lifecycle, review, releases) {
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

export function getProjectHealth(stage, lifecycle, review) {
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

export function summarizeBlockerReason(reason) {
  const text = String(reason || "");
  if (!text) return "No blocker reason recorded.";
  if (/quota|429|capacity/i.test(text)) return text;
  if (/timeout|timed out|etimedout/i.test(text)) return "Provider timeout while waiting for model response.";
  if (/empty output|non-delivery|ready for your command/i.test(text)) return "Provider returned empty/non-actionable output.";
  if (/lifecycle|build|test|lint|smoke/i.test(text)) return "Quality gate failure in lifecycle checks.";
  return text.length > 140 ? `${text.slice(0, 140)}...` : text;
}

export function suggestAutoActionsFromText(text) {
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

export function buildTopBlockers({ lifecycle, runStatus, providerSignal }) {
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

export function buildActivitySignals({ runStatus, prompt, campaign, stageTimeline, running }) {
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

export function inferRecoveryState({ campaign, runStatus, recoveryAudit, activity }) {
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

export function inferLastEvent({ stageTimeline, campaignJournal, journal, prompt }) {
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

export function detectIdleBeforeMinimum(campaign, running) {
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

export function parseStageFromState(stages) {
  return STAGE_ORDER.find((stage) => stages[stage] !== "passed") || "runtime_start";
}
