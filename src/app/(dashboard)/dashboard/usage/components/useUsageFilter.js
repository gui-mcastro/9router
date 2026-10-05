"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_USAGE_FILTER } from "@/lib/usageFilter";

const SAVE_DEBOUNCE_MS = 400;
const EMPTY_OPTIONS = { providers: [], apiKeys: [], tags: [] };

// Global (server-persisted) usage filter. `version` bumps after each successful
// save so data views know to refetch; the server applies the filter itself.
export default function useUsageFilter() {
  const [filter, setFilterState] = useState(DEFAULT_USAGE_FILTER);
  const [options, setOptions] = useState(EMPTY_OPTIONS);
  const [version, setVersion] = useState(0);
  const [syncError, setSyncError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/usage/filter", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        if (cancelled) return;
        setFilterState(data.filter);
        setOptions(data.options || EMPTY_OPTIONS);
      })
      .catch(() => !cancelled && setSyncError("Could not load the saved filter."))
      .finally(() => !cancelled && setLoaded(true));
    return () => {
      cancelled = true;
      clearTimeout(timer.current);
    };
  }, []);

  const setFilter = useCallback((next) => {
    setFilterState(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch("/api/usage/filter", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(next),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setSyncError("");
        setVersion((v) => v + 1);
      } catch {
        setSyncError("Could not save the filter. Change it again to retry.");
      }
    }, SAVE_DEBOUNCE_MS);
  }, []);

  return { filter, options, setFilter, version, syncError, loaded };
}
