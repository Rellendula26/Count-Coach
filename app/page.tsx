"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions";

/**
 * UPDATED VERSION of your file :contentReference[oaicite:0]{index=0}
 *
 * Key changes:
 * - Uses a local FastAPI backend for BPM + beat_times (no JS BPM estimation)
 * - Schedules overlay (click/voice) using beat_times returned by backend
 * - “Set 1 here” now snaps to the nearest detected beat to define where count "1" starts
 */

type OverlayMode = "off" | "click" | "voice" | "click+voice";
type Subdivision = "none" | "and";

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function formatTime(sec: number) {
  if (!isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function closestIndex(arr: number[], x: number) {
  if (arr.length === 0) return -1;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < arr.length; i++) {
    const d = Math.abs(arr[i] - x);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

function labelForBeat(i: number, countsPerCycle: 4 | 8) {
  return String((i % countsPerCycle) + 1);
}

export default function Page() {
  // ----------------------------
  // DOM refs
  // ----------------------------
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const waveformRef = useRef<HTMLDivElement | null>(null);
  const waveSurferRef = useRef<WaveSurfer | null>(null);

  // ----------------------------
  // WebAudio refs (mix overlays with the song)
  // ----------------------------
  const audioCtxRef = useRef<AudioContext | null>(null);
  const mediaNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const clickGainRef = useRef<GainNode | null>(null);
  const voiceGainRef = useRef<GainNode | null>(null);

  // Loaded overlay samples
  const buffersRef = useRef<{
    click?: AudioBuffer;
    voice: Record<string, AudioBuffer>;
  }>({ voice: {} });

  // Scheduler refs
  const schedulerTimerRef = useRef<number | null>(null);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const nextEventIdxRef = useRef<number>(0);

  // ----------------------------
  // UI state
  // ----------------------------
  const [fileName, setFileName] = useState("No file selected");
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioFile, setAudioFile] = useState<File | null>(null); // ✅ NEW: keep the File for backend uploads
  const [duration, setDuration] = useState(0);

  const [overlayMode, setOverlayMode] = useState<OverlayMode>("click+voice");
  const [countsPerCycle, setCountsPerCycle] = useState<4 | 8>(8);
  const [subdivision, setSubdivision] = useState<Subdivision>("and");

  const [sectionStart, setSectionStart] = useState(0);
  const [sectionEnd, setSectionEnd] = useState(30);

  const [bpm, setBpm] = useState<number | null>(null);
  const [bpmStatus, setBpmStatus] = useState<string>("");

  const [beatTimes, setBeatTimes] = useState<number[]>([]); // ✅ NEW: backend beat times (absolute song seconds)
  const [anchorBeatIndex, setAnchorBeatIndex] = useState<number>(0); // ✅ NEW: which beat is count "1"

  const [isPlaying, setIsPlaying] = useState(false);
  const [nowLabel, setNowLabel] = useState("");

  const [clickVol, setClickVol] = useState(0.9);
  const [voiceVol, setVoiceVol] = useState(1.6); // louder default for numbers

  // “Set 1 here” stores where you clicked in the song, and we snap it to the nearest detected beat
  const [oneAnchorSec, setOneAnchorSec] = useState<number | null>(null);

  // ----------------------------
  // Cleanup object URL
  // ----------------------------
  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;

    const url = URL.createObjectURL(f);
    setAudioUrl(url);
    setAudioFile(f);
    setFileName(f.name);

    setSectionStart(0);
    setSectionEnd(30);
    setBpm(null);
    setBeatTimes([]);
    setAnchorBeatIndex(0);
    setBpmStatus("");
    setNowLabel("");
    setIsPlaying(false);
    setOneAnchorSec(null);
  }

  // ----------------------------
  // WebAudio graph
  // ----------------------------
  function ensureAudioGraph() {
    const el = audioElRef.current;
    if (!el) return null;

    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    const ctx = audioCtxRef.current;

    if (!mediaNodeRef.current) {
      mediaNodeRef.current = ctx.createMediaElementSource(el);

      clickGainRef.current = ctx.createGain();
      voiceGainRef.current = ctx.createGain();

      clickGainRef.current.gain.value = clickVol;
      voiceGainRef.current.gain.value = voiceVol * 1.8; // boosted for louder numbers

      // Song -> speakers
      mediaNodeRef.current.connect(ctx.destination);

      // Overlays -> speakers
      clickGainRef.current.connect(ctx.destination);
      voiceGainRef.current.connect(ctx.destination);
    }

    return ctx;
  }

  useEffect(() => {
    if (clickGainRef.current) clickGainRef.current.gain.value = clickVol;
  }, [clickVol]);

  useEffect(() => {
    if (voiceGainRef.current) voiceGainRef.current.gain.value = voiceVol * 1.8;
  }, [voiceVol]);

  // ----------------------------
  // Load overlay samples (click + voice files from /public)
  // ----------------------------
  async function loadBuffer(ctx: AudioContext, url: string) {
    const res = await fetch(url);
    const arr = await res.arrayBuffer();
    return await ctx.decodeAudioData(arr);
  }

  async function ensureOverlayBuffers() {
    const ctx = ensureAudioGraph();
    if (!ctx) return;

    if (buffersRef.current.click && buffersRef.current.voice["1"]) return;

    setBpmStatus("Loading overlay sounds…");

    try {
      buffersRef.current.click = await loadBuffer(ctx, "/click.wav");

      for (let i = 1; i <= 8; i++) {
        buffersRef.current.voice[String(i)] = await loadBuffer(ctx, `/voice/${i}.mp3`);
      }

      try {
        buffersRef.current.voice["&"] = await loadBuffer(ctx, `/voice/and.mp3`);
      } catch {
        // ok if missing
      }

      setBpmStatus("");
    } catch (e) {
      console.log(e);
      setBpmStatus("Couldn’t load overlay sounds. Check /public paths.");
    }
  }

  // ----------------------------
  // WaveSurfer + region selection
  // ----------------------------
  useEffect(() => {
    const container = waveformRef.current;
    const mediaEl = audioElRef.current;
    if (!container || !mediaEl || !audioUrl) return;

    waveSurferRef.current?.destroy();
    waveSurferRef.current = null;

    const ws = WaveSurfer.create({
      container,
      height: 110,
      normalize: true,
      backend: "MediaElement",
      media: mediaEl,
      plugins: [RegionsPlugin.create()],
    });

    waveSurferRef.current = ws;

    ws.on("ready", () => {
      const dur = ws.getDuration();
      if (dur && isFinite(dur)) setDuration(dur);

      const start = 0;
      const end = Math.min(30, dur || 30);

      setSectionStart(start);
      setSectionEnd(end);

      ws.addRegion({
        id: "main",
        start,
        end,
        drag: true,
        resize: true,
        color: "rgba(0,0,0,0.14)",
      });
    });

    ws.on("region-updated", (region: any) => {
      setSectionStart(region.start);
      setSectionEnd(region.end);
    });

    return () => {
      ws.destroy();
      waveSurferRef.current = null;
    };
  }, [audioUrl]);

  // ----------------------------
  // Backend analyze call (FastAPI)
  // ----------------------------
  async function analyzeWithBackend(file: File, start: number, end: number) {
    const fd = new FormData();
    // IMPORTANT: this must match FastAPI param name: audio: UploadFile = File(...)
    fd.append("audio", file);

    const url = new URL("http://localhost:8000/analyze");
    url.searchParams.set("section_start", String(start));
    url.searchParams.set("section_end", String(end));

    const res = await fetch(url.toString(), {
      method: "POST",
      body: fd,
    });

    return await res.json();
  }

  // Debounced analysis whenever region changes
  const analyzeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!audioFile || !duration) return;

    if (analyzeTimerRef.current) window.clearTimeout(analyzeTimerRef.current);

    analyzeTimerRef.current = window.setTimeout(async () => {
      const start = clamp(sectionStart, 0, duration);
      const end = clamp(sectionEnd, 0, duration);

      // you can relax this once backend is stable, but 4–6s helps
      if (end - start < 4) {
        setBpm(null);
        setBeatTimes([]);
        setBpmStatus("Select ≥ 4s for analysis");
        return;
      }

      setBpmStatus("Analyzing section (FastAPI)…");

      try {
        const data = await analyzeWithBackend(audioFile, start, end);

        if (!data?.ok) {
          setBpm(null);
          setBeatTimes([]);
          setAnchorBeatIndex(0);
          setBpmStatus(data?.error || "Backend analysis failed");
          return;
        }

        const bt = Array.isArray(data.beat_times) ? data.beat_times.map((x: any) => Number(x)) : [];
        setBeatTimes(bt);
        setBpm(typeof data.bpm === "number" ? data.bpm : null);
        setBpmStatus("");

        // If we already have a "Set 1 here" anchor, snap it to nearest beat now.
        // Otherwise default: first beat is "1".
        if (bt.length > 0) {
          if (oneAnchorSec !== null) {
            const idx = closestIndex(bt, oneAnchorSec);
            setAnchorBeatIndex(idx >= 0 ? idx : 0);
          } else {
            setAnchorBeatIndex(0);
          }
        } else {
          setAnchorBeatIndex(0);
        }
      } catch (e) {
        console.log(e);
        setBpm(null);
        setBeatTimes([]);
        setAnchorBeatIndex(0);
        setBpmStatus("Backend not running? Start FastAPI on localhost:8000");
      }
    }, 500);

    return () => {
      if (analyzeTimerRef.current) window.clearTimeout(analyzeTimerRef.current);
    };
  }, [audioFile, sectionStart, sectionEnd, duration, oneAnchorSec]);

  // ----------------------------
  // “Set 1 here” (snap to nearest detected beat)
  // ----------------------------
  function setOneHere() {
    const el = audioElRef.current;
    if (!el || !duration) return;

    const t = clamp(el.currentTime, 0, duration);
    setOneAnchorSec(t);

    if (beatTimes.length > 0) {
      const idx = closestIndex(beatTimes, t);
      setAnchorBeatIndex(idx >= 0 ? idx : 0);
    }
  }

  function resetOneAnchor() {
    setOneAnchorSec(null);
    setAnchorBeatIndex(0);
  }

  // ----------------------------
  // Build overlay schedule events from beatTimes (+ optional "&" between beats)
  // Each event is an absolute song time in seconds.
  // ----------------------------
  const overlayEvents = useMemo(() => {
    if (!duration) return [];
    if (beatTimes.length === 0) return [];

    // Keep beats only in current section
    const start = clamp(sectionStart, 0, duration);
    const end = clamp(sectionEnd, 0, duration);

    const beatsInSection: Array<{ t: number; kind: "beat"; beatIdx: number }> = [];
    for (let i = 0; i < beatTimes.length; i++) {
      const t = beatTimes[i];
      if (t >= start - 1e-6 && t <= end + 1e-6) {
        beatsInSection.push({ t, kind: "beat", beatIdx: i });
      }
    }

    if (beatsInSection.length === 0) return [];

    const evs: Array<{
      t: number;
      label: string; // "1".."8" or "&"
      isClick: boolean;
    }> = [];

    for (let k = 0; k < beatsInSection.length; k++) {
      const beat = beatsInSection[k];
      const relIdx = (beat.beatIdx - anchorBeatIndex + 1_000_000) % 1_000_000; // safe non-negative
      const label = labelForBeat(relIdx, countsPerCycle);
      evs.push({ t: beat.t, label, isClick: true });

      if (subdivision === "and" && k < beatsInSection.length - 1) {
        const nextBeat = beatsInSection[k + 1];
        const mid = (beat.t + nextBeat.t) / 2;
        if (mid >= start - 1e-6 && mid <= end + 1e-6) {
          evs.push({ t: mid, label: "&", isClick: false });
        }
      }
    }

    // Sort by time (important because we inserted mids)
    evs.sort((a, b) => a.t - b.t);

    return evs;
  }, [beatTimes, sectionStart, sectionEnd, duration, subdivision, countsPerCycle, anchorBeatIndex]);

  // ----------------------------
  // Scheduler (plays overlayEvents on top of the song using WebAudio)
  // ----------------------------
  function stopScheduler() {
    if (schedulerTimerRef.current) {
      window.clearInterval(schedulerTimerRef.current);
      schedulerTimerRef.current = null;
    }
    for (const s of activeSourcesRef.current) {
      try {
        s.stop();
      } catch {}
    }
    activeSourcesRef.current = [];
  }

  function scheduleBufferAt(ctx: AudioContext, buffer: AudioBuffer, when: number, gain: GainNode) {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(gain);
    src.start(when);
    activeSourcesRef.current.push(src);
  }

  function startScheduler() {
    const ctx = ensureAudioGraph();
    const el = audioElRef.current;
    if (!ctx || !el) return;
    if (overlayEvents.length === 0) return;

    stopScheduler();

    // Start from next event after current time
    const t = el.currentTime;
    let idx = overlayEvents.findIndex((ev) => ev.t >= t - 0.02);
    if (idx < 0) idx = overlayEvents.length;
    nextEventIdxRef.current = idx;

    const lookAheadSec = 0.25;
    const tickMs = 50;

    schedulerTimerRef.current = window.setInterval(() => {
      const ctxNow = ctx.currentTime;
      const audioNow = el.currentTime;

      while (nextEventIdxRef.current < overlayEvents.length) {
        const ev = overlayEvents[nextEventIdxRef.current];
        const dtSong = ev.t - audioNow;
        const when = ctxNow + dtSong;

        if (dtSong > lookAheadSec) break;

        // For the big display: show counts on beats (and show "&" too if you want)
        setNowLabel(ev.label);

        // Click overlay on beats only
        if ((overlayMode === "click" || overlayMode === "click+voice") && ev.isClick) {
          const clickBuf = buffersRef.current.click;
          const clickGain = clickGainRef.current;
          if (clickBuf && clickGain) scheduleBufferAt(ctx, clickBuf, when, clickGain);
        }

        // Voice overlay on both beats (1..8) and & (if you have /voice/and.mp3)
        if (overlayMode === "voice" || overlayMode === "click+voice") {
          const voiceGain = voiceGainRef.current;
          const vb = buffersRef.current.voice[ev.label];
          if (vb && voiceGain) scheduleBufferAt(ctx, vb, when, voiceGain);
        }

        nextEventIdxRef.current += 1;
      }
    }, tickMs);
  }

  // Loop inside section (for the song)
  useEffect(() => {
    const el = audioElRef.current;
    if (!el) return;

    const onTime = () => {
      if (!duration) return;
      const start = clamp(sectionStart, 0, duration);
      const end = clamp(sectionEnd, 0, duration);
      if (end > start && el.currentTime > end) {
        el.currentTime = start;
      }
    };

    el.addEventListener("timeupdate", onTime);
    return () => el.removeEventListener("timeupdate", onTime);
  }, [sectionStart, sectionEnd, duration]);

  async function togglePlay() {
    const el = audioElRef.current;
    if (!el) return;

    const ctx = ensureAudioGraph();
    if (ctx) await ctx.resume();

    await ensureOverlayBuffers();

    const start = clamp(sectionStart, 0, duration || 0);
    const end = clamp(sectionEnd, 0, duration || 0);

    if (!isPlaying) {
      if (el.currentTime < start || el.currentTime > end) {
        el.currentTime = start;
      }
      await el.play();
      setIsPlaying(true);

      if (overlayMode !== "off") startScheduler();
    } else {
      el.pause();
      setIsPlaying(false);
      stopScheduler();
    }
  }

  // Restart scheduler when settings change (includes beatTimes + anchor index)
  useEffect(() => {
    if (!isPlaying) return;
    startScheduler();
    return () => stopScheduler();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlayMode, overlayEvents, isPlaying]);

  // Restart scheduler if user seeks
  useEffect(() => {
    const el = audioElRef.current;
    if (!el) return;

    const onSeek = () => {
      if (isPlaying) startScheduler();
    };

    el.addEventListener("seeked", onSeek);
    return () => el.removeEventListener("seeked", onSeek);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying]);

  return (
    <main className="min-h-screen p-6 max-w-3xl mx-auto">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Count Coach</h1>
        <div className="text-sm text-neutral-500">{duration ? `Duration: ${formatTime(duration)}` : ""}</div>
      </div>

      <div className="mt-4 rounded-2xl border bg-white p-5 space-y-5">
        {/* Import */}
        <div className="flex items-center gap-3">
          <label className="px-4 py-2 rounded-xl bg-black text-white text-sm cursor-pointer">
            Import audio
            <input type="file" accept="audio/*" className="hidden" onChange={onPickFile} />
          </label>
          <div className="text-sm text-neutral-600 truncate">{fileName}</div>
        </div>

        {/* Audio */}
        {audioUrl ? (
          <audio
            ref={audioElRef}
            src={audioUrl}
            controls
            className="w-full"
            onLoadedMetadata={(e) => {
              const d = (e.currentTarget as HTMLAudioElement).duration;
              if (d && isFinite(d)) setDuration(d);
            }}
            onEnded={() => {
              setIsPlaying(false);
              stopScheduler();
            }}
          />
        ) : (
          <div className="text-sm text-neutral-500">Import an audio file to begin.</div>
        )}

        {/* Section UI = waveform region only */}
        {audioUrl ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">Section</div>
              <div className="text-sm text-neutral-600 tabular-nums">
                {formatTime(sectionStart)} → {formatTime(sectionEnd)}
              </div>
            </div>
            <div ref={waveformRef} className="w-full h-28 rounded-xl border overflow-hidden" />
            <div className="text-xs text-neutral-500">Drag/resize the shaded region. (Backend analysis runs after you stop dragging.)</div>
          </div>
        ) : null}

        {/* BPM display */}
        <div className="rounded-xl border p-4 flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">Detected BPM</div>
            <div className="text-xs text-neutral-500 mt-1">
              {bpmStatus || "From FastAPI beat tracking (more accurate than in-browser guessing)."}
            </div>
          </div>
          <div className="text-2xl font-semibold tabular-nums">{bpm ? bpm.toFixed(2) : "—"}</div>
        </div>

        {/* Controls */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="rounded-xl border p-4">
            <div className="text-sm font-medium">Overlay</div>
            <select value={overlayMode} onChange={(e) => setOverlayMode(e.target.value as OverlayMode)} className="mt-2 w-full rounded-xl border px-3 py-2">
              <option value="off">Off</option>
              <option value="click">Metronome click</option>
              <option value="voice">Voice counts (your mp3s)</option>
              <option value="click+voice">Click + voice</option>
            </select>

            <div className="mt-4">
              <div className="text-sm font-medium">Click volume</div>
              <input type="range" min={0} max={1} step={0.01} value={clickVol} onChange={(e) => setClickVol(Number(e.target.value))} className="w-full mt-2" />
            </div>

            <div className="mt-4">
              <div className="text-sm font-medium">Voice volume</div>
              <input type="range" min={0} max={2.5} step={0.01} value={voiceVol} onChange={(e) => setVoiceVol(Number(e.target.value))} className="w-full mt-2" />
              <div className="text-xs text-neutral-500 mt-1">Boosted internally for louder numbers.</div>
            </div>
          </div>

          <div className="rounded-xl border p-4">
            <div className="text-sm font-medium">Counts</div>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                className={`flex-1 rounded-xl border px-3 py-2 text-sm ${countsPerCycle === 8 ? "bg-black text-white" : ""}`}
                onClick={() => setCountsPerCycle(8)}
              >
                8-count
              </button>
              <button
                type="button"
                className={`flex-1 rounded-xl border px-3 py-2 text-sm ${countsPerCycle === 4 ? "bg-black text-white" : ""}`}
                onClick={() => setCountsPerCycle(4)}
              >
                4-count
              </button>
            </div>

            <div className="mt-4">
              <div className="text-sm font-medium">Subdivision</div>
              <select value={subdivision} onChange={(e) => setSubdivision(e.target.value as Subdivision)} className="mt-2 w-full rounded-xl border px-3 py-2">
                <option value="and">1 &amp; 2 &amp; 3 &amp; 4 &amp;</option>
                <option value="none">1 2 3 4</option>
              </select>
              <div className="text-xs text-neutral-500 mt-1">
                “&” is scheduled halfway between detected beats (requires relatively steady tempo).
              </div>
            </div>
          </div>

          <div className="rounded-xl border p-4">
            <div className="text-sm font-medium">Play</div>
            <button
              type="button"
              onClick={togglePlay}
              disabled={!audioUrl || beatTimes.length === 0}
              className="mt-3 w-full px-4 py-3 rounded-xl bg-black text-white disabled:opacity-40"
            >
              {isPlaying ? "Pause" : "Play"}
            </button>

            <button
              type="button"
              onClick={setOneHere}
              disabled={!audioUrl || beatTimes.length === 0}
              className="mt-3 w-full px-4 py-2 rounded-xl border disabled:opacity-40"
            >
              Set 1 here
            </button>

            {oneAnchorSec !== null ? (
              <div className="mt-2 text-xs text-neutral-500">
                1 anchored near {formatTime(oneAnchorSec)} (snapped to nearest beat)
                <button type="button" className="underline ml-2" onClick={resetOneAnchor}>
                  reset
                </button>
              </div>
            ) : (
              <div className="mt-2 text-xs text-neutral-500">1 defaults to the first detected beat in the section</div>
            )}

            <div className="text-xs text-neutral-500 mt-3">
              {beatTimes.length > 0 ? "Overlay is driven by backend beat timestamps." : "Waiting for backend analysis…"}
            </div>
          </div>
        </div>
      </div>

      {/* Big label */}
      <div className="mt-6 rounded-2xl border p-8 flex items-center justify-center h-44 bg-white">
        <div className="text-7xl font-bold tabular-nums">{nowLabel || "—"}</div>
      </div>
    </main>
  );
}
