"use client";

import { useEffect, useRef, useState } from "react";

export type Timeline<S> = readonly (readonly [ms: number, patch: Partial<S>])[];

const FADE_MS = 800;

/**
 * Plays a timeline of scene patches in a loop. The first event (at 0) should
 * reset the scene. Runs only while the returned ref is on screen, not paused,
 * and the visitor has not asked for reduced motion; otherwise the scene stays
 * on `poster`. Returns `fade` for the cross-fade between loops.
 */
export function useDemoLoop<S extends object>(
  timeline: Timeline<S>,
  length: number,
  poster: S,
  paused: boolean,
) {
  const [scene, setScene] = useState<S>(poster);
  const [fade, setFade] = useState(false);
  const [cycle, setCycle] = useState(0);
  const [visible, setVisible] = useState(false);
  const [reduced, setReduced] = useState(true); // still frame until we know
  const ref = useRef<HTMLDivElement>(null);
  const clock = useRef({ elapsed: 0, startedAt: 0 });

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(Boolean(entry?.isIntersecting)),
      { threshold: 0.3 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (reduced || paused || !visible) return;
    const from = clock.current.elapsed;
    clock.current.startedAt = performance.now();
    let ended = false;

    const timers = timeline
      .filter(([ms]) => ms >= from)
      .map(([ms, patch]) =>
        window.setTimeout(() => {
          if (ms === 0) setFade(false);
          setScene((prev) => ({ ...prev, ...patch }));
        }, ms - from),
      );
    if (from < length - FADE_MS) {
      timers.push(window.setTimeout(() => setFade(true), length - FADE_MS - from));
    }
    timers.push(
      window.setTimeout(() => {
        ended = true;
        clock.current.elapsed = 0;
        setCycle((c) => c + 1);
      }, length - from),
    );

    return () => {
      timers.forEach(window.clearTimeout);
      if (!ended) {
        clock.current.elapsed = from + (performance.now() - clock.current.startedAt);
      }
    };
  }, [timeline, length, reduced, paused, visible, cycle]);

  return { scene, fade, ref };
}
