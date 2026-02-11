export const STAGE_ORDER = [
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

export function buildStageResults(stage, stageProducts) {
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

export function buildStageProgress(stage) {
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

export function findLastPassedStage(stageTimeline) {
  if (!Array.isArray(stageTimeline)) return "";
  const reversed = [...stageTimeline].reverse();
  const hit = reversed.find((row) => String(row?.status || "").toLowerCase() === "passed");
  return String(hit?.stage || "");
}
