"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/** Plan §10.4: fall back to polling once the stream has dropped twice. */
const MAX_STREAM_FAILURES = 2;
const POLL_INTERVAL_MS = 15_000;

/**
 * The server heartbeats every 25s. Anything past 60s of total silence means
 * the stream is dead even though the socket looks open — generous enough not
 * to trip on a slow network, short enough that a clerk is not staring at a
 * stale queue for minutes.
 */
const SILENCE_LIMIT_MS = 60_000;
const WATCHDOG_TICK_MS = 10_000;

type Connection = "connecting" | "live" | "polling";

/**
 * Keeps the order queue current.
 *
 * Subscribes to the store's event stream and calls `router.refresh()` when
 * something changes, which re-runs the server component and re-reads the queue
 * from the database. The events carry no order contents on purpose — the
 * database stays the single authority on what staff see, so a dropped or
 * duplicated event costs at most a redundant refresh.
 *
 * The connection indicator is not decoration. A clerk trusting this screen to
 * update needs to know the moment it stops, and the failure this guards
 * against is subtle: when the API dies mid-stream the browser can go on
 * reporting a healthy connection while nothing arrives. Hence the watchdog —
 * silence is treated as failure rather than as a quiet shop.
 */
export function LiveOrders({ storeId }: { storeId: string }) {
  const router = useRouter();
  const [connection, setConnection] = useState<Connection>("connecting");
  const failures = useRef(0);

  useEffect(() => {
    let source: EventSource | null = null;
    let pollTimer: number | undefined;
    let reconnectTimer: number | undefined;
    let lastMessageAt = Date.now();
    let stopped = false;

    function startPolling() {
      if (stopped || pollTimer !== undefined) return;
      setConnection("polling");
      pollTimer = window.setInterval(() => router.refresh(), POLL_INTERVAL_MS);
    }

    /** Any traffic at all, including heartbeats, proves the stream is alive. */
    function markAlive() {
      lastMessageAt = Date.now();
    }

    function handleFailure() {
      source?.close();
      source = null;
      if (stopped) return;

      failures.current += 1;
      if (failures.current >= MAX_STREAM_FAILURES) {
        startPolling();
        return;
      }

      setConnection("connecting");
      // EventSource retries by itself only for transport errors; a 401 or 503
      // from the proxy closes it for good, so reconnecting is up to us.
      reconnectTimer = window.setTimeout(connect, 2_000);
    }

    function connect() {
      if (stopped) return;

      source = new EventSource(`/api/stores/${storeId}/events`);
      lastMessageAt = Date.now();

      source.addEventListener("ready", () => {
        // Reset on a *successful* connection, not per attempt — otherwise a
        // stream that connects and immediately dies would retry forever.
        failures.current = 0;
        markAlive();
        setConnection("live");
      });

      source.addEventListener("heartbeat", markAlive);

      for (const type of ["order.created", "order.status_changed", "order.payment_recorded"]) {
        source.addEventListener(type, () => {
          markAlive();
          router.refresh();
        });
      }

      source.onerror = handleFailure;
    }

    connect();

    function checkLiveness() {
      if (stopped || pollTimer !== undefined) return;
      if (Date.now() - lastMessageAt > SILENCE_LIMIT_MS) handleFailure();
    }

    const watchdog = window.setInterval(checkLiveness, WATCHDOG_TICK_MS);

    /**
     * Browsers throttle timers in background tabs — heavily, and more the
     * longer the tab stays hidden. A clerk who switches to another app and
     * comes back would otherwise return to a stale queue with a watchdog that
     * has barely ticked. Coming back to the foreground is the moment to check
     * and to re-read, so it is handled directly rather than left to a timer.
     */
    function onVisible() {
      if (document.visibilityState !== "visible" || stopped) return;
      checkLiveness();
      router.refresh();
    }
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      stopped = true;
      source?.close();
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(pollTimer);
      window.clearInterval(watchdog);
      window.clearTimeout(reconnectTimer);
    };
  }, [storeId, router]);

  return (
    <p className="flex items-center gap-2 text-xs text-ink-muted" aria-live="polite">
      <span
        aria-hidden
        className={`inline-block h-2 w-2 rounded-full ${
          connection === "live"
            ? "bg-success"
            : connection === "polling"
              ? "bg-amber-500"
              : "bg-neutral-400"
        }`}
      />
      {connection === "live"
        ? "Updating live"
        : connection === "polling"
          ? "Live updates unavailable — checking every 15 seconds"
          : "Connecting…"}
    </p>
  );
}
