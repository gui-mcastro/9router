"use client";

import { useMemo, useState } from "react";
import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import SegmentedControl from "@/shared/components/SegmentedControl";
import { buildApiKeyRanking, UNTAGGED } from "./apiKeyRanking";

const fmtTokens = (n) => {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n || 0);
};
const fmtCost = (n) => `$${(n || 0).toFixed(2)}`;
const fmtCount = (n) => new Intl.NumberFormat().format(n || 0);
const fmtPct = (x) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;
const FORMAT = { tokens: fmtTokens, cost: fmtCost, requests: fmtCount };

const GROUP_OPTIONS = [{ value: "key", label: "By key" }, { value: "tag", label: "By tag" }];
const METRIC_OPTIONS = [{ value: "tokens", label: "Tokens" }, { value: "cost", label: "Cost" }, { value: "requests", label: "Requests" }];

export default function ApiKeyRankingCard({ byApiKey, catalog, onSelectKey, onSelectTag }) {
  const [groupBy, setGroupBy] = useState("key");
  const [metric, setMetric] = useState("tokens");
  const rows = useMemo(() => buildApiKeyRanking(byApiKey, catalog, { groupBy, metric }), [byApiKey, catalog, groupBy, metric]);
  const max = rows[0]?.value || 0;
  const format = FORMAT[metric];

  const clickable = (row) => (groupBy === "key" ? !!onSelectKey : !!onSelectTag && row.id !== UNTAGGED);
  const select = (row) => (groupBy === "key" ? onSelectKey(row.id) : onSelectTag(row.id));

  return (
    <Card className="flex min-w-0 flex-col gap-3 p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold uppercase tracking-wide text-text-muted">API Key Ranking</span>
        <div className="flex flex-wrap gap-2">
          <SegmentedControl options={GROUP_OPTIONS} value={groupBy} onChange={setGroupBy} size="sm" />
          <SegmentedControl options={METRIC_OPTIONS} value={metric} onChange={setMetric} size="sm" />
        </div>
      </div>

      {!rows.length ? (
        <div className="py-8 text-center text-sm text-text-muted">No API key usage for this period.</div>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                disabled={!clickable(row)}
                onClick={() => select(row)}
                title={clickable(row) ? "Show only this in the dashboard" : undefined}
                className="w-full rounded-md px-2 py-1.5 text-left transition-colors enabled:hover:bg-bg-hover disabled:cursor-default"
              >
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate font-medium">{groupBy === "tag" && row.id !== UNTAGGED ? `#${row.label}` : row.label}</span>
                    {groupBy === "key" && row.tags.map((t) => (
                      <span key={t} className="shrink-0 rounded bg-bg-subtle px-1 text-[10px] text-text-muted">#{t}</span>
                    ))}
                    {groupBy === "tag" && (
                      <span className="shrink-0 text-[10px] text-text-muted">{row.keyCount} key{row.keyCount > 1 ? "s" : ""}</span>
                    )}
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {format(row.value)} <span className="text-xs text-text-muted">· {fmtPct(row.share)}</span>
                  </span>
                </div>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-bg-subtle">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${max > 0 ? (row.value / max) * 100 : 0}%` }} />
                </div>
                <div className="mt-0.5 text-[11px] tabular-nums text-text-muted">
                  {fmtTokens(row.promptTokens)} in · {fmtTokens(row.cachedTokens)} cached · {fmtTokens(row.completionTokens)} out · {fmtCost(row.cost)} · {fmtCount(row.requests)} req
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {groupBy === "tag" && rows.length > 0 && (
        <p className="text-[11px] text-text-muted">Keys with several tags count in each tag, so percentages can add up to more than 100%.</p>
      )}
    </Card>
  );
}

ApiKeyRankingCard.propTypes = {
  byApiKey: PropTypes.object,
  catalog: PropTypes.array,
  onSelectKey: PropTypes.func,
  onSelectTag: PropTypes.func,
};
