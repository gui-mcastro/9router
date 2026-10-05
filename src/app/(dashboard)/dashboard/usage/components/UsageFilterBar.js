"use client";

import { useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import SegmentedControl from "@/shared/components/SegmentedControl";
import { DEFAULT_USAGE_FILTER, KEY_NONE, KEY_UNKNOWN, isUsageFilterActive } from "@/lib/usageFilter";
import {
  apiKeyOptionIds, toggleProvider, toggleApiKey, toggleTag, setRequestKind,
  selectAllSection, clearSection, summarizeProviders, summarizeApiKeys,
} from "./usageFilterState";

const REQUEST_KIND_OPTIONS = [
  { value: "work", label: "Work" },
  { value: "meta", label: "Metadata" },
  { value: "all", label: "All" },
];

function FilterDropdown({ label, summary, onSelectAll, onClear, children }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 rounded-lg border border-border bg-surface px-3 py-1 text-sm font-medium text-text-main hover:bg-bg-hover"
      >
        <span className="text-text-muted">{label}:</span>
        <span className="max-w-[140px] truncate">{summary}</span>
        <span className="material-symbols-outlined text-[16px]">expand_more</span>
      </button>
      {open && (
        <div className="fixed inset-x-4 z-30 mt-1 max-h-96 overflow-y-auto rounded-lg border border-border bg-surface p-2 shadow-lg sm:absolute sm:inset-x-auto sm:right-0 sm:w-72">
          <div className="mb-1 flex justify-between px-2 text-xs">
            <button type="button" onClick={onSelectAll} className="text-primary hover:underline">Select all</button>
            <button type="button" onClick={onClear} className="text-text-muted hover:underline">Clear</button>
          </div>
          {children}
        </div>
      )}
    </div>
  );
}

FilterDropdown.propTypes = {
  label: PropTypes.string.isRequired,
  summary: PropTypes.string.isRequired,
  onSelectAll: PropTypes.func.isRequired,
  onClear: PropTypes.func.isRequired,
  children: PropTypes.node,
};

function CheckRow({ checked, onChange, label, hint = "" }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-bg-hover">
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span className="truncate">{label}</span>
      {hint && <span className="ml-auto shrink-0 text-[10px] text-text-muted">{hint}</span>}
    </label>
  );
}

CheckRow.propTypes = {
  checked: PropTypes.bool.isRequired,
  onChange: PropTypes.func.isRequired,
  label: PropTypes.string.isRequired,
  hint: PropTypes.string,
};

const SectionTitle = ({ children }) => (
  <p className="px-2 pt-2 text-[10px] font-semibold uppercase tracking-wide text-text-muted">{children}</p>
);

SectionTitle.propTypes = { children: PropTypes.node };

export default function UsageFilterBar({ filter, options, setFilter, syncError = "" }) {
  const providerIds = options.providers.map((p) => p.id);
  const keyIds = apiKeyOptionIds(options);
  const keys = filter.apiKeys;
  const keyChecked = (id) => keys.mode === "all" || keys.ids.includes(id);
  const viaTag = (k) => keys.mode === "selected" && !keys.ids.includes(k.id) && k.tags.some((t) => keys.tags.includes(t));

  return (
    <div className="flex flex-wrap items-center gap-2">
      <FilterDropdown
        label="Providers"
        summary={summarizeProviders(filter, options)}
        onSelectAll={() => setFilter(selectAllSection(filter, "providers"))}
        onClear={() => setFilter(clearSection(filter, "providers"))}
      >
        {!options.providers.length && <p className="px-2 py-1 text-xs text-text-muted">No providers yet.</p>}
        {options.providers.map((p) => (
          <CheckRow
            key={p.id}
            label={p.label}
            checked={filter.providers.mode === "all" || filter.providers.ids.includes(p.id)}
            onChange={() => setFilter(toggleProvider(filter, p.id, providerIds))}
          />
        ))}
      </FilterDropdown>

      <FilterDropdown
        label="API Keys"
        summary={summarizeApiKeys(filter, options)}
        onSelectAll={() => setFilter(selectAllSection(filter, "apiKeys"))}
        onClear={() => setFilter(clearSection(filter, "apiKeys"))}
      >
        <SectionTitle>Keys</SectionTitle>
        {options.apiKeys.map((k) => (
          <CheckRow
            key={k.id}
            label={k.isActive ? k.name : `${k.name} (paused)`}
            checked={keyChecked(k.id) || viaTag(k)}
            hint={viaTag(k) ? "via tag" : ""}
            onChange={() => setFilter(toggleApiKey(filter, k.id, keyIds))}
          />
        ))}
        <CheckRow label="No API key" checked={keyChecked(KEY_NONE)} onChange={() => setFilter(toggleApiKey(filter, KEY_NONE, keyIds))} />
        <CheckRow label="Unknown / deleted keys" checked={keyChecked(KEY_UNKNOWN)} onChange={() => setFilter(toggleApiKey(filter, KEY_UNKNOWN, keyIds))} />
        {options.tags.length > 0 && (
          <>
            <SectionTitle>Tags</SectionTitle>
            {options.tags.map((t) => (
              <CheckRow
                key={t}
                label={`#${t}`}
                checked={keys.mode === "selected" && keys.tags.includes(t)}
                onChange={() => setFilter(toggleTag(filter, t))}
              />
            ))}
          </>
        )}
      </FilterDropdown>

      <SegmentedControl
        options={REQUEST_KIND_OPTIONS}
        value={filter.requestKind || "work"}
        onChange={(kind) => setFilter(setRequestKind(filter, kind))}
        size="sm"
      />

      {isUsageFilterActive(filter) && (
        <button type="button" onClick={() => setFilter(DEFAULT_USAGE_FILTER)} className="text-xs text-primary hover:underline">
          Reset filters
        </button>
      )}
      {syncError && <span role="status" className="text-xs text-warning">{syncError}</span>}
    </div>
  );
}

UsageFilterBar.propTypes = {
  filter: PropTypes.object.isRequired,
  options: PropTypes.shape({
    providers: PropTypes.array.isRequired,
    apiKeys: PropTypes.array.isRequired,
    tags: PropTypes.array.isRequired,
  }).isRequired,
  setFilter: PropTypes.func.isRequired,
  syncError: PropTypes.string,
};
