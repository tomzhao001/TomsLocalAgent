import { useEffect, useRef } from "react";

export function usePolling(load: () => unknown, intervalMs: number, enabled: boolean): void {
  const latest = useRef(load);
  latest.current = load;

  useEffect(() => {
    if (!enabled) return;
    const run = () => {
      if (document.visibilityState !== "hidden") void latest.current();
    };
    run();
    const timer = setInterval(run, intervalMs);
    document.addEventListener("visibilitychange", run);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", run);
    };
  }, [intervalMs, enabled]);
}
