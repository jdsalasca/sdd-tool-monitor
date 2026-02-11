export function parseProviderSignal({ campaign, prompt, runStatus, campaignJournal }) {
  const nowMs = Date.now();
  const windowMs = 30 * 60 * 1000;
  const isFreshIso = (value) => {
    const ms = Date.parse(String(value || ""));
    return Number.isFinite(ms) && nowMs - ms <= windowMs;
  };
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
    .filter((row) => row.error.length > 0 || String(row?.outputPreview || "").trim().length > 0)
    .filter((row) => isFreshIso(row.at));
  const lastFailure = recentFailures.at(-1);
  const outputPreview = String(prompt?.lastOutputPreview || "").toLowerCase();
  const lastErrorText = String(lastFailure?.error || prompt?.lastError || campaign?.lastError || "").toLowerCase();
  const runStatusFresh = isFreshIso(runStatus?.raw?.at);
  const campaignFresh = isFreshIso(campaign?.updatedAt);
  const lastErrorEffective = runStatusFresh || campaignFresh ? lastErrorText : "";
  const nonDelivery = outputPreview.includes("ready for your command") || outputPreview.trim() === "" || lastErrorEffective.includes("empty output");
  const unusableDelivery =
    /unable to (proceed|fix|continue).*(tool|tools).*(not available|limitations)|cannot .*tool|tool limitations|limitations in my current toolset/i.test(
      outputPreview
    ) ||
    /unable to (proceed|fix|continue).*(tool|tools).*(not available|limitations)|cannot .*tool|tool limitations|limitations in my current toolset/i.test(
      lastErrorEffective
    );
  const providerBlocked = /provider_backoff|provider_blocked|provider_quota_recovery/i.test(String(campaign?.phase || ""));
  const quotaLike = /quota|capacity|429|terminalquotaerror/i.test(lastErrorEffective);
  const journalBlocked = (campaignJournal || []).some((row) => /campaign\.provider\.blocked/i.test(String(row?.event || "")));

  let state = "healthy";
  let summary = "Provider delivering responses.";
  if (providerBlocked || journalBlocked || quotaLike) {
    state = "blocked";
    summary = "Provider delivery blocked (quota/capacity or hard failure).";
  } else if (nonDelivery || unusableDelivery || recentFailures.length >= 2) {
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
  const blockingReason = state === "blocked" ? summarizeReason(lastErrorEffective || lastFailure?.error || "provider delivery blocked") : "";
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
