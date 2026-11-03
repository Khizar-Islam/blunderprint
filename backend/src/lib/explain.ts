// Reading .explain() output, for scripts/explainSummary.ts and the summary's index test.
//
// An aggregation's explain document nests the query plan in different places depending on the
// server and the engine (the classic engine under stages[0].$cursor, the slot-based engine at
// the top or under queryPlanner.winningPlan.queryPlan). Rather than follow one layout, these
// walk the whole document.

type Json = unknown;

// Every plan node ({ stage: "IXSCAN", indexName, ... }) anywhere in the document.
function planNodes(doc: Json, out: { stage: string; indexName?: string }[] = []) {
  if (Array.isArray(doc)) {
    for (const item of doc) planNodes(item, out);
  } else if (doc && typeof doc === "object") {
    const node = doc as Record<string, unknown>;
    if (typeof node.stage === "string") {
      out.push({ stage: node.stage, ...(typeof node.indexName === "string" ? { indexName: node.indexName } : {}) });
    }
    // Skip rejected plans: only the plan that ran says which index was used.
    for (const [key, value] of Object.entries(node)) if (key !== "rejectedPlans") planNodes(value, out);
  }
  return out;
}

export interface ExplainSummary {
  indexScans: string[]; // index names of the IXSCAN stages in the winning plan
  collectionScan: boolean;
  inMemorySort: boolean; // a SORT stage: the index didn't give the order
  keysExamined?: number;
  docsExamined?: number;
  executionTimeMillis?: number;
}

// The first value of `key` found anywhere in the document (executionStats can sit at the top
// or inside the $cursor stage).
function findNumber(doc: Json, key: string): number | undefined {
  if (Array.isArray(doc)) {
    for (const item of doc) {
      const v = findNumber(item, key);
      if (v !== undefined) return v;
    }
  } else if (doc && typeof doc === "object") {
    const node = doc as Record<string, unknown>;
    if (typeof node[key] === "number") return node[key] as number;
    for (const [k, value] of Object.entries(node)) {
      if (k === "rejectedPlans") continue;
      const v = findNumber(value, key);
      if (v !== undefined) return v;
    }
  }
  return undefined;
}

export function summarizeExplain(explain: Json): ExplainSummary {
  const nodes = planNodes(explain);
  return {
    indexScans: [...new Set(nodes.filter((n) => n.stage === "IXSCAN" && n.indexName).map((n) => n.indexName!))],
    collectionScan: nodes.some((n) => n.stage === "COLLSCAN"),
    inMemorySort: nodes.some((n) => n.stage === "SORT"),
    keysExamined: findNumber(explain, "totalKeysExamined"),
    docsExamined: findNumber(explain, "totalDocsExamined"),
    executionTimeMillis: findNumber(explain, "executionTimeMillis"),
  };
}
