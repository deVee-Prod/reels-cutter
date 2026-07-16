"use client";

import React, { useState, useRef, useEffect, useCallback } from 'react';
import Image from 'next/image';
import Timeline from './components/Timeline';

const FONTS = [
  { id: 'NotoSansTight',        label: 'Noto Tight',    file: '/NotoSansTight.ttf'               },
  { id: 'NotoSansHebrewBlack',  label: 'Noto Hebrew',   file: '/NotoSansHebrew-Black.ttf'        },
  { id: 'NotoSansHebrewEB',     label: 'Noto HEB XB',   file: '/NotoSansHebrew-ExtraBold.ttf'    },
  { id: 'RubikBlack',           label: 'Rubik Black',   file: '/Rubik-Black.ttf'                 },
  { id: 'Heebo',                label: 'Heebo',         file: '/Heebo.ttf'                       },
  { id: 'SecularOne',           label: 'Secular One',   file: '/SecularOne-Regular.ttf'          },
  { id: 'VarelaRound',          label: 'Varela Round',  file: '/VarelaRound-Regular.ttf'         },
  { id: 'FrankRuhlLibreBold',   label: 'Frank Ruhl',    file: '/FrankRuhlLibre-Bold.ttf'        },
] as const;
type FontId = typeof FONTS[number]['id'];

// Canvas preview scale — higher to counteract 360p base video and render crisp text
const PREVIEW_SCALE_DESKTOP = 3.0; // 360p * 3 = 1080p canvas
const PREVIEW_SCALE_MOBILE  = 3.0; // 360p * 3 = 1080p canvas

// Gap threshold — if silence between two words >= this, force a group break
const GAP_BREAK_THRESHOLD = 0.5;

/** Group words into lines of *up to* `maxPerLine` words.
 *  A new group starts whenever:
 *  1. The current group already has `maxPerLine` words, OR
 *  2. The gap between the previous word's end and the next word's start >= GAP_BREAK_THRESHOLD
 *  3. The word has forceBreak flag */
function buildWordGroups<T extends { start: number; end: number; forceBreak?: boolean }>(words: T[], maxPerLine: number): T[][] {
  if (words.length === 0) return [];
  const groups: T[][] = [[words[0]]];
  for (let i = 1; i < words.length; i++) {
    const current = groups[groups.length - 1];
    const prev = words[i - 1];
    const gap = words[i].start - prev.end;
    if (current.length >= maxPerLine || gap >= GAP_BREAK_THRESHOLD || words[i].forceBreak) {
      groups.push([words[i]]);
    } else {
      current.push(words[i]);
    }
  }
  return groups;
}

function LabelFooter() {
  return (
    <div className="hidden md:flex fixed bottom-6 left-6 z-50 opacity-40 hover:opacity-100 transition-opacity duration-300">
      <a href="https://devee-music.com" target="_blank" rel="noopener noreferrer" className="flex items-center justify-center">
        <div className="w-10 h-10 rounded-full overflow-hidden border border-white/10 shadow-[0_0_15px_rgba(0,0,0,0.5)]">
          <img src="/label_logo.png" alt="deVee" className="w-full h-full object-cover" />
        </div>
      </a>
    </div>
  );
}


function remapToExportTime(
  t: number,
  segs: { start: number; end: number | null }[],
  dur: number
): number {
  let offset = 0;
  for (const seg of segs) {
    const segEnd = seg.end ?? dur;
    if (t <= seg.start) return offset;
    if (t < segEnd) return offset + (t - seg.start);
    offset += segEnd - seg.start;
  }
  return offset;
}

const CUT_ZOOM_SCALES = [1.0, 1.2, 1.0, 1.15, 1.0, 1.25, 1.0, 1.2];
function getSegmentZoom(idx: number, freq: number): number {
  return CUT_ZOOM_SCALES[Math.floor(idx / freq) % CUT_ZOOM_SCALES.length];
}

export default function ReelsCutterPage() {
  // ── Auth ──
  const [authStatus, setAuthStatus] = useState<'checking' | 'ok' | 'no_access'>('checking');
  const [authorized, setAuthorized] = useState(false);
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);

  // ── Core ──
  const [loaded, setLoaded] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("Ready");
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [segments, setSegments] = useState<{ start: number; end: number | null }[] | null>(null);
  const [duration, setDuration] = useState<number>(0);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [paused, setPaused] = useState(true);

  // ── Phase 1: Cut Mode ──
  const [zoom, setZoom] = useState(4);
  const [waveformBg, setWaveformBg] = useState<string | null>(null);
  const [zoomPerCut, setZoomPerCut] = useState(false);
  const [zoomMode, setZoomMode] = useState(false);
  const [zoomFreq, setZoomFreq] = useState<1 | 4>(1);
  const [activeIsA, setActiveIsA] = useState(true);

  // ── Phase 2: Subtitle Editor (ported from Dubber) ──
  const [cutDone, setCutDone] = useState(false);
  const [subtitleWords, setSubtitleWords] = useState<{ word: string; start: number; end: number; forceBreak?: boolean }[]>([]);
  const [fontFamily, setFontFamily] = useState<FontId>('NotoSansTight');
  const [loadedFonts, setLoadedFonts] = useState<Set<string>>(new Set());
  const [subtitlePos, setSubtitlePos] = useState(15);
  const [fontScale, setFontScale] = useState(0.6);
  const [enablePump, setEnablePump] = useState(true);
  const [wordsPerLine, setWordsPerLine] = useState(2);
  const [fontDropdownOpen, setFontDropdownOpen] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canUndoCut, setCanUndoCut] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);

  // ── Refs ──
  const ffmpegRef = useRef<any>(null);
  const videoARef = useRef<HTMLVideoElement>(null);
  const videoBRef = useRef<HTMLVideoElement>(null);
  const activeIsARef = useRef(true);
  const timelineRef = useRef<HTMLDivElement>(null);
  const timelineContainerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef<{ index: number; edge: 'start' | 'end' } | null>(null);
  const rafRef = useRef<number | null>(null);
  const segmentsRef = useRef<{ start: number; end: number | null }[] | null>(null);
  const durationRef = useRef<number>(0);
  const programmaticSeekRef = useRef(false);
  const warmingUpRef = useRef(false);
  const seekBarRef = useRef<HTMLDivElement>(null);
  const seekDraggingRef = useRef(false);
  const cutDoneRef = useRef(false);
  const origVideoUrlRef = useRef<string | null>(null);
  const origSubtitleWordsRef = useRef<{ word: string; start: number; end: number }[]>([]);
  const origVideoWidthRef = useRef(0);
  const origWidthCapturedRef = useRef(false);
  const hasAutoAnalyzed = useRef(false);

  // Phase 2 refs (ported from Dubber)
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const phase2VideoRef = useRef<HTMLVideoElement>(null);
  const subtitlePosRef = useRef(15);
  const fontFamilyRef = useRef<FontId>('NotoSansTight');
  const wordsPerLineRef = useRef(2);
  const currentTimeRef = useRef(0);
  const lastDrawnTimeRef = useRef(-1);
  const historyRef = useRef<any[][]>([]);
  const cutHistoryRef = useRef<any[][]>([]);
  const syncAndDrawRef = useRef<() => void>(() => {});
  const togglePlayRef = useRef<() => Promise<void>>(async () => {});
  const lastUIUpdateRef = useRef(0);
  const lastDrawTimeMsRef = useRef(0);
  const previewScaleRef = useRef(
    typeof window !== 'undefined' && window.innerWidth < 768
      ? PREVIEW_SCALE_MOBILE
      : PREVIEW_SCALE_DESKTOP
  );

  // Stable Timeline callbacks
  const getTimeCallback = useCallback(() => currentTimeRef.current, []);
  const isPlayingCallback = useCallback(() => !!(phase2VideoRef.current && !phase2VideoRef.current.paused), []);

  // ── Undo system ──
  function pushHistory(snapshot: any[]) {
    historyRef.current = [...historyRef.current.slice(-29), [...snapshot]];
    setCanUndo(true);
  }

  const handleUndo = useCallback(() => {
    const h = historyRef.current;
    if (h.length === 0) return;
    const prev = h[h.length - 1];
    historyRef.current = h.slice(0, -1);
    setSubtitleWords(prev);
    setCanUndo(h.length > 1);
  }, []);

  // ── Auth checks ──
  useEffect(() => {
    if (document.cookie.split(';').some(c => c.trim() === 'devee_auth=1')) {
      setAuthStatus('ok');
    } else {
      setAuthStatus('no_access');
    }
  }, []);

  useEffect(() => {
    if (document.cookie.includes('session_access=granted')) {
      setAuthorized(true);
      loadFFmpeg();
    }
  }, []);

  // ── Sync refs ──
  useEffect(() => { segmentsRef.current = segments; }, [segments]);
  useEffect(() => { durationRef.current = duration; }, [duration]);
  useEffect(() => { cutDoneRef.current = cutDone; }, [cutDone]);
  useEffect(() => { fontFamilyRef.current = fontFamily; }, [fontFamily]);
  useEffect(() => { subtitlePosRef.current = subtitlePos; }, [subtitlePos]);
  useEffect(() => { wordsPerLineRef.current = wordsPerLine; }, [wordsPerLine]);

  // ── Load fonts ──
  useEffect(() => {
    FONTS.forEach(({ id, file }) => {
      const font = new FontFace(id, `url(${file})`);
      font.load().then(f => { document.fonts.add(f); setLoadedFonts(prev => new Set([...prev, id])); }).catch(() => {});
    });
  }, []);

  // ── Cleanup RAF ──
  useEffect(() => () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); }, []);
  useEffect(() => { if (window.innerWidth < 768) setZoom(8); }, []);

  // ── Phase 1: Timeline auto-scroll ──
  useEffect(() => {
    if (cutDone) return; // Don't auto-scroll in Phase 2
    const c = timelineContainerRef.current;
    if (!c || zoom <= 1 || !duration) return;
    const cw = c.clientWidth;
    const ph = (currentTime / duration) * cw * zoom;
    if (ph < c.scrollLeft + 40 || ph > c.scrollLeft + cw - 40)
      c.scrollLeft = Math.max(0, ph - cw * 0.25);
  }, [currentTime, zoom, duration, cutDone]);

  // ── Phase 1: Video playback helpers ──
  const getAV = () => activeIsARef.current ? videoARef.current : videoBRef.current;
  const getBV = () => activeIsARef.current ? videoBRef.current : videoARef.current;

  const stopLoop = () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  const startLoop = () => {
    stopLoop();
    const tick = () => {
      if (cutDoneRef.current) { rafRef.current = requestAnimationFrame(tick); return; }
      const v = getAV();
      const segs = segmentsRef.current;
      const dur = durationRef.current;
      if (!v || !segs || v.paused || draggingRef.current || seekDraggingRef.current || warmingUpRef.current) { rafRef.current = null; return; }
      const t = v.currentTime;
      const inSeg = segs.find(s => t >= s.start - 0.1 && t <= (s.end ?? dur));

      const seekTo = (target: number) => {
        programmaticSeekRef.current = true;
        v.currentTime = target;
        const done = () => { startLoop(); };
        const fallback = setTimeout(done, 800);
        v.addEventListener('seeked', () => { clearTimeout(fallback); done(); }, { once: true });
      };

      if (!inSeg) {
        const next = segs.filter(s => s.start > t).sort((a, b) => a.start - b.start)[0];
        if (next) seekTo(next.start); else v.pause();
        rafRef.current = null; return;
      }

      if (inSeg.end !== null && t >= inSeg.end - 0.08) {
        const nextSeg = segs[segs.indexOf(inSeg) + 1];
        if (nextSeg) seekTo(nextSeg.start); else v.pause();
        rafRef.current = null; return;
      }

      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  useEffect(() => {
    const handlePointerUp = () => {
      if (draggingRef.current) {
        draggingRef.current = null;
        const av = getAV();
        if (av && !av.paused) startLoop();
      }
    };
    window.addEventListener('pointerup', handlePointerUp);
    return () => window.removeEventListener('pointerup', handlePointerUp);
  }, []);

  const handleTimeUpdate = () => {
    const av = getAV();
    if (av) setCurrentTime(av.currentTime);
  };

  // ── Phase 2: Canvas syncAndDraw (ported from Dubber) ──
  const syncAndDraw = () => {
    const media = phase2VideoRef.current;
    const canvas = canvasRef.current;

    if (media && canvas) {
      const ctx = canvas.getContext('2d');
      const isActive = !media.paused && !media.ended;

      if (isActive) {
        currentTimeRef.current = media.currentTime;
        const now = performance.now();
        if (now - lastUIUpdateRef.current > 66) {
          setCurrentTime(media.currentTime);
          lastUIUpdateRef.current = now;
        }
      }

      const timeChanged = currentTimeRef.current !== lastDrawnTimeRef.current;
      const now = performance.now();
      const shouldDraw = isActive ? (now - lastDrawTimeMsRef.current > 33) : timeChanged;

      if (ctx && media.videoWidth > 0 && shouldDraw) {
        if (isActive) lastDrawTimeMsRef.current = now;
        const scale = previewScaleRef.current;
        const targetW = Math.round(media.videoWidth * scale);
        if (canvas.width !== targetW) {
          canvas.width = targetW;
          canvas.height = Math.round(media.videoHeight * scale);
        }
        ctx.drawImage(media, 0, 0, canvas.width, canvas.height);
        lastDrawnTimeRef.current = currentTimeRef.current;

        // Draw subtitle on canvas
        if (canvas.width > 0 && subtitleWords.length > 0) {
          const time = currentTimeRef.current;
          const wpl = wordsPerLineRef.current;
          const wordGroups = buildWordGroups(subtitleWords, wpl);

          let activeGroup: typeof subtitleWords | null = null;
          let groupStartIndex = -1;
          let flatIdx = 0;
          for (const group of wordGroups) {
            const groupStart = group[0].start;
            const groupEnd = group[group.length - 1].end;
            if (time >= groupStart && time <= groupEnd) {
              activeGroup = group;
              groupStartIndex = flatIdx;
              break;
            }
            flatIdx += group.length;
          }

          if (activeGroup) {
            const lineText = activeGroup.map((w: any) => w.word).join(' ');
            const baseSize = (enablePump ? [28, 42, 58][groupStartIndex % 3] : 42) * fontScale;
            const fontSize = Math.round(baseSize * (canvas.height / 500));
            const x = canvas.width / 2;
            const y = canvas.height - (canvas.height * subtitlePosRef.current / 100);
            const borderW = Math.max(2, Math.round(2.4 * (canvas.height / 500)));

            ctx.save();
            ctx.font = `900 ${fontSize}px "${fontFamilyRef.current}", sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';

            ctx.shadowColor = 'transparent';
            ctx.lineWidth = borderW;
            ctx.lineJoin = 'round';
            ctx.strokeStyle = 'rgba(0,0,0,0.9)';
            ctx.strokeText(lineText, x, y);

            ctx.shadowColor = 'rgba(0,0,0,0.95)';
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = Math.round(2 * (canvas.height / 500));
            ctx.shadowBlur = 4;
            ctx.fillStyle = '#ECE9E4';
            ctx.fillText(lineText, x, y);
            ctx.restore();
          }
        }
      }
    }
  };

  // Keep syncAndDraw ref current
  useEffect(() => { syncAndDrawRef.current = syncAndDraw; });

  // Phase 2 RAF loop — runs only when cutDone
  useEffect(() => {
    if (!cutDone) return;
    function loop() {
      syncAndDrawRef.current();
      phase2RafRef.current = requestAnimationFrame(loop);
    }
    const phase2RafRef = { current: requestAnimationFrame(loop) };
    return () => { cancelAnimationFrame(phase2RafRef.current); };
  }, [cutDone]);

  // Phase 2 toggle play
  const togglePlay = async () => {
    const media = phase2VideoRef.current;
    if (!media) return;
    if (media.paused) {
      try { await media.play(); setPaused(false); } catch (err) { console.error("Playback failed", err); }
    } else {
      media.pause();
      setPaused(true);
    }
  };

  useEffect(() => { togglePlayRef.current = togglePlay; });

  // Global Keydown Handler (Spacebar + Undo)
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;

      if (e.key === ' ') {
        e.preventDefault(); // Stop scrolling or pressing focused buttons
        if (cutDoneRef.current) {
          togglePlayRef.current();
        } else {
          const av = activeIsARef.current ? videoARef.current : videoBRef.current;
          if (av) av.paused ? av.play() : av.pause();
        }
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault();
        if (cutDoneRef.current) {
          handleUndo();
        } else {
          const h = cutHistoryRef.current;
          if (h.length > 0) {
            const prev = h.pop();
            setSegments(prev ?? null);
            setCanUndoCut(h.length > 0);
          }
        }
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handleUndo]);

  // Phase 2: seek handler
  const handlePhase2Seek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newTime = parseFloat(e.target.value);
    setCurrentTime(newTime);
    currentTimeRef.current = newTime;
    lastDrawnTimeRef.current = -1;
    if (phase2VideoRef.current) phase2VideoRef.current.currentTime = newTime;
  };

  // Phase 2: drag subtitle position
  const startDragging = (e: any) => {
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const startY = clientY;
    const startPos = subtitlePos;
    const onMove = (moveEvent: any) => {
      const currentY = moveEvent.touches ? moveEvent.touches[0].clientY : moveEvent.clientY;
      const delta = ((startY - currentY) / (canvasRef.current?.clientHeight || 500)) * 100;
      setSubtitlePos(Math.min(90, Math.max(10, startPos + delta)));
    };
    const onEnd = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onEnd);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onEnd);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
  };

  // ── FFmpeg ──
  const loadFFmpeg = async () => {
    if (ffmpegRef.current) return;
    const { FFmpeg } = await import('@ffmpeg/ffmpeg');
    const { toBlobURL } = await import('@ffmpeg/util');
    const ffmpeg = new FFmpeg();
    ffmpegRef.current = ffmpeg;
    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
    ffmpeg.on('progress', ({ progress }: { progress: number }) => {
      setProgress(Math.round(progress * 100));
      setExportProgress(Math.round(progress * 100));
    });
    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    });
    setLoaded(true);
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginLoading(true);
    const res = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    if (res.ok) { setAuthorized(true); loadFFmpeg(); } else { setLoginError(true); setPassword(''); setTimeout(() => setLoginError(false), 2000); }
    setLoginLoading(false);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setVideoFile(file);
      setVideoUrl(URL.createObjectURL(file));
      setSegments(null);
      setSubtitleWords([]);
      setCutDone(false);
      setWaveformBg(null);
      origWidthCapturedRef.current = false;
      hasAutoAnalyzed.current = false;
      setProgress(0);
      setStatus("Ready");
      activeIsARef.current = true;
      setActiveIsA(true);
      historyRef.current = [];
      cutHistoryRef.current = [];
      setCanUndo(false);
      setCanUndoCut(false);
    }
  };

  const warmupSegments = async (segs: { start: number; end: number | null }[]) => {
    const video = videoARef.current;
    if (!video || segs.length === 0) return;
    const globalDeadline = Date.now() + 25000;
    if (video.readyState < 2) {
      await new Promise<void>(resolve => {
        const t = setTimeout(resolve, 3000);
        video.addEventListener('loadeddata', () => { clearTimeout(t); resolve(); }, { once: true });
      });
    }
    warmingUpRef.current = true;
    video.muted = true;
    const seekTo = (t: number) => new Promise<void>(resolve => {
      if (Date.now() >= globalDeadline) { resolve(); return; }
      const fallback = setTimeout(resolve, 500);
      video.addEventListener('seeked', () => { clearTimeout(fallback); resolve(); }, { once: true });
      video.currentTime = t;
    });
    for (const seg of segs) {
      if (Date.now() >= globalDeadline) break;
      await seekTo(seg.start);
      await video.play().catch(() => {});
      await new Promise<void>(r => setTimeout(r, 700));
      video.pause();
    }
    video.muted = false;
    warmingUpRef.current = false;
    video.currentTime = segs[0].start;
  };

  useEffect(() => {
    if (videoFile && loaded && !hasAutoAnalyzed.current && !processing) {
      hasAutoAnalyzed.current = true;
      analyzeVideo();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoFile, loaded]);

  // ── Phase 1: Analyze video ──
  const analyzeVideo = async () => {
    if (!videoFile || !loaded) return;
    setProcessing(true);
    const ffmpeg = ffmpegRef.current;
    const { fetchFile } = await import('@ffmpeg/util');
    try {
      setStatus("Extracting audio...");
      setProgress(0);
      await ffmpeg.writeFile('input.mov', await fetchFile(videoFile));
      await ffmpeg.exec(['-i', 'input.mov', '-vn', '-ar', '16000', '-ac', '1', 'whisper.mp3']);
      const audioData = await ffmpeg.readFile('whisper.mp3');
      const audioRawBuffer = (audioData as any).buffer as ArrayBuffer;
      const audioBlob = new Blob([audioRawBuffer], { type: 'audio/mpeg' });
      const form = new FormData();
      form.append('video', audioBlob, 'audio.mp3');
      const whisperPromise = fetch('/api/whisper', { method: 'POST', body: form });

      // Generate waveform in parallel
      (async () => {
        try {
          const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
          const actx = new AudioCtx();
          const decoded = await actx.decodeAudioData(audioRawBuffer.slice());
          actx.close();
          const ch = decoded.getChannelData(0);
          const W = 1200, H = 56;
          const wc = document.createElement('canvas');
          wc.width = W; wc.height = H;
          const wctx = wc.getContext('2d')!;
          const spx = Math.max(1, Math.floor(ch.length / W));
          wctx.fillStyle = '#D4AF37';
          for (let i = 0; i < W; i++) {
            let peak = 0;
            for (let j = 0; j < spx; j++) peak = Math.max(peak, Math.abs(ch[i * spx + j] ?? 0));
            const h = Math.max(1, peak * H * 0.85);
            wctx.fillRect(i, (H - h) / 2, 1, h);
          }
          setWaveformBg(wc.toDataURL());
        } catch { /* waveform is optional */ }
      })();
      setStatus("Creating preview...");
      await ffmpeg.exec(['-i', 'input.mov', '-vf', 'scale=-2:360', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-g', '15', '-keyint_min', '15', '-c:a', 'copy', 'preview.mp4']);
      const previewData = await ffmpeg.readFile('preview.mp4');
      setVideoUrl(URL.createObjectURL(new Blob([(previewData as any).buffer], { type: 'video/mp4' })));
      setStatus("Whisper is analyzing...");
      const res = await whisperPromise;
      const data = await res.json();
      
      if (data.segments) {
        setSegments(data.segments);
        if (data.words) setSubtitleWords(data.words);
        
        setStatus("Preparing edit...");
        setProgress(0);
        await warmupSegments(data.segments);
        setStatus("Review Edit");
      }
    } catch (e) {
      setStatus("Error");
    } finally {
      setProcessing(false);
    }
  };

  // ── Transition: Phase 1 → Phase 2 ──
  const finishCutting = async () => {
    if (!segments || !ffmpegRef.current) return;
    setProcessing(true);
    setStatus("Cutting preview...");
    setProgress(0);
    try {
      let f = '', c = '';
      segments.forEach((s, i) => {
        const e = s.end ?? duration;
        f += `[0:v]trim=start=${s.start}:end=${e},setpts=PTS-STARTPTS[v${i}];[0:a]atrim=start=${s.start}:end=${e},asetpts=PTS-STARTPTS[a${i}];`;
        c += `[v${i}][a${i}]`;
      });
      f += `${c}concat=n=${segments.length}:v=1:a=1[outv][outa]`;

      await ffmpegRef.current.exec([
        '-y', '-i', 'preview.mp4',
        '-filter_complex', f,
        '-map', '[outv]', '-map', '[outa]',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
        'cut_preview.mp4',
      ]);

      const cutData = await ffmpegRef.current.readFile('cut_preview.mp4');
      const cutUrl = URL.createObjectURL(new Blob([(cutData as any).buffer], { type: 'video/mp4' }));

      // Remap subtitle timestamps to cut timeline
      const remapped = subtitleWords.map(w => ({
        ...w,
        start: Number(remapToExportTime(w.start, segments, duration).toFixed(3)),
        end:   Number(Math.max(
          remapToExportTime(w.start, segments, duration) + 0.05,
          remapToExportTime(w.end,   segments, duration)
        ).toFixed(3)),
      }));

      // Save originals for "go back"
      origVideoUrlRef.current = videoUrl;
      origSubtitleWordsRef.current = subtitleWords;

      setVideoUrl(cutUrl);
      setSubtitleWords(remapped);
      setCutDone(true);
      setPaused(true);
      currentTimeRef.current = 0;
      lastDrawnTimeRef.current = -1;
      historyRef.current = [];
      setCanUndo(false);
      cutHistoryRef.current = [];
      setCanUndoCut(false);
      setStatus("Edit Subtitles");
    } catch {
      setStatus("Error");
    } finally {
      setProcessing(false);
    }
  };

  // ── Go back from Phase 2 to Phase 1 ──
  const goBackToCutMode = () => {
    // Pause Phase 2 video
    phase2VideoRef.current?.pause();
    setPaused(true);
    // Restore originals
    if (origVideoUrlRef.current) setVideoUrl(origVideoUrlRef.current);
    setSubtitleWords(origSubtitleWordsRef.current);
    setCutDone(false);
    setStatus("Review Edit");
    historyRef.current = [];
    setCanUndo(false);
  };

  // ── Phase 2: Export (with grouped subtitles) ──
  const renderVideo = async () => {
    if (!videoFile || !segments) return;
    setIsExporting(true);
    setExportProgress(0);
    setStatus("Rendering 1080p Master...");
    try {
      const { fetchFile } = await import('@ffmpeg/util');
      await ffmpegRef.current.writeFile('input.mov', await fetchFile(videoFile));

      const withSubtitles = subtitleWords.length > 0;

      if (withSubtitles) {
        setStatus("Loading font...");
        const selectedFont = FONTS.find(f => f.id === fontFamily) ?? FONTS[0];
        const fontRes = await fetch(selectedFont.file);
        if (!fontRes.ok) throw new Error('Font not found in /public');
        await ffmpegRef.current.writeFile('myfont.ttf', new Uint8Array(await fontRes.arrayBuffer()));
        setStatus("Rendering 1080p Master...");
      }

      const exportScale = (origVideoWidthRef.current || 1080) / 200;
      const videoH = origVideoWidthRef.current ? (origVideoWidthRef.current * 16 / 9) : 1920;
      const scaleRatio = videoH / 500;

      let f = '', c = '';
      segments.forEach((s, i) => {
        const e = s.end ?? duration;
        const segZoom = zoomPerCut ? getSegmentZoom(i, zoomFreq) : 1.0;
        const zoomFilter = segZoom !== 1.0 ? `,crop=iw/${segZoom}:ih/${segZoom}:(iw-iw/${segZoom})/2:(ih-ih/${segZoom})/2` : '';
        f += `[0:v]trim=start=${s.start}:end=${e},setpts=PTS-STARTPTS${zoomFilter}[v${i}];[0:a]atrim=start=${s.start}:end=${e},asetpts=PTS-STARTPTS[a${i}];`;
        c += `[v${i}][a${i}]`;
      });

      let drawtextChain = '';
      if (withSubtitles) {
        // Use grouped words (Dubber-style) for export
        const groups = buildWordGroups(subtitleWords, wordsPerLine);
        const dtFilters = groups.map((group, groupIndex) => {
          const lineText = group.map((w: any) => w.word).join(' ');
          let safeWord = lineText.trim()
            .toUpperCase()
            .replace(/'/g, '')
            .replace(/:/g, '\\:')
            .replace(/,/g, '\\,')
            .replace(/\[/g, '\\[')
            .replace(/\]/g, '\\]');
          if (!safeWord) return null;

          const baseSize = (enablePump ? [28, 42, 58][groupIndex % 3] : 42) * fontScale;
          const fontSize = Math.round(baseSize * scaleRatio);

          const rs = cutDone ? group[0].start : remapToExportTime(group[0].start, segments, duration);
          let re = cutDone ? Math.max(group[0].start + 0.08, group[group.length - 1].end) : Math.max(rs + 0.08, remapToExportTime(group[group.length - 1].end, segments, duration));

          // Prevent overlap with next group
          const nextGroup = groups[groupIndex + 1];
          if (nextGroup) {
            const nextStart = cutDone ? nextGroup[0].start : remapToExportTime(nextGroup[0].start, segments, duration);
            if (re > nextStart) re = Math.max(rs + 0.05, nextStart - 0.01);
          }

          const yPos = `h-(h*${subtitlePos}/100)-text_h`;
          return `drawtext=fontfile='myfont.ttf':text='${safeWord}':enable='between(t,${rs.toFixed(3)},${re.toFixed(3)})':x=(w-text_w)/2:y=${yPos}:fontsize=${fontSize}:fontcolor=0xECE9E4:bordercolor=black@0.9:borderw=2:shadowx=0:shadowy=2:shadowcolor=black@0.95`;
        }).filter(Boolean);
        if (dtFilters.length > 0) drawtextChain = dtFilters.join(',') + ',';
      }

      f += `${c}concat=n=${segments.length}:v=1:a=1[vraw][outa];[vraw]${drawtextChain}scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p[outv]`;

      await ffmpegRef.current.exec(['-i', 'input.mov', '-filter_complex', f, '-map', '[outv]', '-map', '[outa]', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', 'out.mp4']);
      if (withSubtitles) await ffmpegRef.current.deleteFile('myfont.ttf').catch(() => {});

      const url = URL.createObjectURL(new Blob([(await ffmpegRef.current.readFile('out.mp4') as any).buffer], { type: 'video/mp4' }));
      const a = document.createElement('a'); a.href = url; a.download = `deVee_${videoFile.name}.mp4`; a.click();
      setStatus("Done!");
    } catch (e) { setStatus("Error"); } finally { setIsExporting(false); setExportProgress(0); }
  };

  // ── Format time ──
  const formatTime = (time: number) => {
    if (isNaN(time)) return "00:00";
    const m = Math.floor(time / 60).toString().padStart(2, '0');
    const s = Math.floor(time % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  // ═══════════════════════════════════════════════════════
  // ██  R E N D E R
  // ═══════════════════════════════════════════════════════

  if (authStatus === 'checking') {
    return (
      <div style={{ position: 'fixed', inset: 0, backgroundColor: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: '#fff', fontSize: '1.125rem', fontFamily: 'sans-serif' }}>Verifying Access...</p>
      </div>
    );
  }

  if (authStatus === 'no_access') {
    return (
      <div style={{ position: 'fixed', inset: 0, backgroundColor: '#000', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1.5rem', padding: '2rem', textAlign: 'center' }}>
        <p style={{ color: 'rgba(255,255,255,0.3)', fontSize: '2rem' }}>🔒</p>
        <p style={{ color: '#fff', fontSize: '1.1rem', fontFamily: 'sans-serif', fontWeight: 600, lineHeight: 1.5, maxWidth: 340 }}>
          This is a Premium Tool.<br />Sign in with Google at deVee Music to get access.
        </p>
        <p style={{ color: 'rgba(255,255,255,0.45)', fontSize: '0.9rem', fontFamily: 'sans-serif', lineHeight: 1.6, maxWidth: 320 }}>
          This is a premium tool.<br />Login with your Google account on deVee Music to get access.
        </p>
        <a href="https://devee-music.com" style={{ color: 'rgba(255,255,255,0.3)', fontSize: '0.75rem', fontFamily: 'sans-serif', textDecoration: 'none', letterSpacing: '0.05em' }}>
          ← Back to deVee Music
        </a>
      </div>
    );
  }

  if (!authorized) {
    return (
      <div className="min-h-[100dvh] flex flex-col items-center text-center">
        <header className="w-full relative z-20 flex flex-col items-center shrink-0 mt-8 mb-6">
        <img src="/logo.png" alt="deVee" className="w-[100px] h-[100px] mb-2 object-contain" />
        <h1 className="text-[10px] font-bold tracking-[0.5em] uppercase text-white/60">REELS CUTTER</h1>
      </header>
        <main className="flex-1 flex flex-col justify-center w-full max-w-[340px] px-4">
          <div className="mb-8 flex flex-col items-center gap-3 text-center">
            <div className="flex items-center gap-2">
              <div className="h-px w-8 bg-[#D4AF37]/30" />
              <span className="text-[#D4AF37] text-[9px] tracking-[0.35em] uppercase font-semibold">1080p Vertical Video</span>
              <div className="h-px w-8 bg-[#D4AF37]/30" />
            </div>
            <p className="text-white text-[11px] tracking-[0.05em] font-light uppercase">For Vertical 1080p Video</p>
          </div>
          <form onSubmit={handleLogin} className="space-y-4 bg-[#0c0c0c]/40 p-8 rounded-[24px] border border-white/5 backdrop-blur-xl w-full">
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full bg-white/[0.02] border border-white/5 rounded-xl py-3 px-4 text-white text-center tracking-[0.4em] text-[9px] focus:outline-none" placeholder="ACCESS KEY" />
            <button type="submit" className="w-full py-3 bg-[#D4AF37] text-black rounded-xl uppercase tracking-[0.3em] text-[8px] font-black">Enter</button>
          </form>
        </main>
        <LabelFooter />
      </div>
    );
  }

  // ── Phase 1 derived values ──
  const currentSegIdx = segments ? segments.findIndex(s => currentTime >= s.start && currentTime <= (s.end ?? duration)) : -1;
  const previewZoom = zoomPerCut && currentSegIdx >= 0 ? getSegmentZoom(currentSegIdx, zoomFreq) : 1.0;

  // ═══════════════════════════════════════════════════════════════════
  // ██  PHASE 2: SUBTITLE EDITOR (Dubber-style canvas UI)
  // ═══════════════════════════════════════════════════════════════════
  if (cutDone && videoUrl) {
    return (
      <div className="min-h-[100dvh] w-full text-white flex flex-col items-center overflow-y-auto overflow-x-hidden font-sans">
        <header className="w-full relative z-20 flex flex-col items-center shrink-0 mt-8 mb-6">
        <img src="/logo.png" alt="deVee" className="w-[100px] h-[100px] mb-2 object-contain" />
        <h1 className="text-[10px] font-bold tracking-[0.5em] uppercase text-white/60">REELS CUTTER</h1>
      </header>

        <main className="w-full max-w-2xl mx-auto flex flex-col items-center flex-1 px-4 md:px-6 space-y-3 md:space-y-5 py-4 md:py-6">
          <div className="w-full space-y-3 md:space-y-5">
            {/* Canvas preview */}
            <div className="relative w-full h-[48vh] md:h-auto md:aspect-video bg-[#0c0c0c] border border-white/[0.03] rounded-[24px] md:rounded-[32px] overflow-hidden shadow-2xl flex items-center justify-center">
              <div className="relative w-full h-full cursor-pointer" onClick={togglePlay}>
                <video
                  ref={phase2VideoRef}
                  src={videoUrl}
                  preload="auto"
                  style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
                  playsInline
                  onLoadedData={() => { lastDrawnTimeRef.current = -1; }}
                  onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
                />
                <canvas ref={canvasRef} className="w-full h-full object-contain" />

                {isExporting && (
                  <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/80 backdrop-blur-md">
                    <div className="w-48 h-1 bg-white/10 rounded-full overflow-hidden mb-4">
                      <div className="h-full bg-[#D4AF37] transition-all duration-300" style={{ width: `${exportProgress}%` }}></div>
                    </div>
                    <p className="text-[10px] font-black tracking-[0.5em] text-white uppercase animate-pulse">Burning {exportProgress}%</p>
                  </div>
                )}

                {paused && !isExporting && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                    <div className="w-16 h-16 md:w-20 md:h-20 bg-white/10 backdrop-blur-md rounded-full flex items-center justify-center border border-white/20 shadow-2xl">
                      <div className="w-0 h-0 border-t-[10px] border-t-transparent border-l-[18px] border-l-white border-b-[10px] border-b-transparent ml-2" />
                    </div>
                  </div>
                )}

                {/* Drag handle for subtitle position */}
                <div
                  className="absolute left-0 right-0 flex justify-center px-6 text-center select-none z-30 cursor-ns-resize active:cursor-grabbing"
                  style={{ bottom: `${subtitlePos}%` }}
                  onMouseDown={(e) => { e.stopPropagation(); startDragging(e); }}
                  onTouchStart={(e) => { e.stopPropagation(); startDragging(e); }}
                >
                  <span className="font-black uppercase tracking-tighter pointer-events-none" style={{ fontFamily: 'NotoSansTight, sans-serif', color: 'transparent', display: 'none' }} />
                </div>
              </div>
            </div>

            {/* Seek bar */}
            <div className="flex items-center gap-3 bg-[#0c0c0c] border border-white/[0.03] rounded-2xl px-4 py-3 shadow-inner">
              <button onClick={togglePlay} className="w-9 h-9 shrink-0 rounded-full bg-[#D4AF37] flex items-center justify-center shadow-[0_0_12px_rgba(212,175,55,0.3)] active:scale-95 transition-transform">
                {!paused ? (
                  <div className="flex gap-1">
                    <div className="w-1 h-3 bg-black rounded-full"></div>
                    <div className="w-1 h-3 bg-black rounded-full"></div>
                  </div>
                ) : (
                  <div className="w-0 h-0 border-t-[6px] border-t-transparent border-l-[10px] border-l-black border-b-[6px] border-b-transparent ml-1"></div>
                )}
              </button>
              <input type="range" min="0" max={duration || 100} step="0.01" value={currentTime} onChange={handlePhase2Seek} className="flex-1 h-2 bg-white/5 rounded-full appearance-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-6 [&::-webkit-slider-thumb]:h-6 [&::-webkit-slider-thumb]:bg-[#D4AF37] [&::-webkit-slider-thumb]:rounded-full cursor-pointer" />
              <div className="shrink-0 flex gap-1 text-[9px] font-mono text-white/40">
                <span className="text-white/80">{formatTime(currentTime)}</span>
                <span>/</span>
                <span>{formatTime(duration)}</span>
              </div>
            </div>

            {/* Position / Font strip */}
            <div className="flex items-center gap-2 bg-white/[0.02] border border-white/5 rounded-2xl px-4 py-3">
              <span className="text-[7px] uppercase tracking-[0.2em] text-white/30 font-bold shrink-0">Pos</span>
              <button onClick={() => setSubtitlePos(prev => Math.max(10, prev - 5))} className="w-7 h-7 rounded-full bg-white/5 flex items-center justify-center text-[10px] active:scale-90 transition-transform">▼</button>
              <span className="text-[8px] font-mono text-[#D4AF37] w-7 text-center shrink-0">{Math.round(subtitlePos)}%</span>
              <button onClick={() => setSubtitlePos(prev => Math.min(90, prev + 5))} className="w-7 h-7 rounded-full bg-white/5 flex items-center justify-center text-[10px] active:scale-90 transition-transform">▲</button>
              <div className="w-px h-3.5 bg-white/10 shrink-0 mx-1" />
              {/* Font dropdown */}
              <div className="relative flex-1 flex justify-end">
                {fontDropdownOpen && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setFontDropdownOpen(false)} />
                    <div className="absolute bottom-full right-0 mb-2 z-20 w-56 rounded-2xl bg-[#111] border border-white/10 overflow-hidden shadow-2xl">
                      {FONTS.filter(f => loadedFonts.has(f.id)).map(f => (
                        <button
                          key={f.id}
                          onClick={() => { setFontFamily(f.id); setFontDropdownOpen(false); }}
                          className={`w-full flex items-center justify-between px-4 py-3 transition-colors ${fontFamily === f.id ? 'bg-[#D4AF37]/20' : 'hover:bg-white/5'}`}
                        >
                          <span className="text-[9px] uppercase tracking-widest font-bold text-white/50">{f.label}</span>
                          <span
                            className={`text-2xl leading-none ${fontFamily === f.id ? 'text-[#D4AF37]' : 'text-white/80'}`}
                            style={{ fontFamily: f.id }}
                          >
                            שלום
                          </span>
                        </button>
                      ))}
                      {loadedFonts.size === 0 && (
                        <div className="px-4 py-3 text-[9px] text-white/30 uppercase tracking-widest">Loading fonts…</div>
                      )}
                    </div>
                  </>
                )}
                <button
                  onClick={() => setFontDropdownOpen(prev => !prev)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[9px] font-bold uppercase tracking-wide transition-all ${fontDropdownOpen ? 'bg-[#D4AF37] text-black' : 'bg-white/5 text-white/40 hover:text-white/70 hover:bg-white/10'}`}
                >
                  <span>{FONTS.find(f => f.id === fontFamily)?.label ?? fontFamily}</span>
                  <span className="opacity-60">{fontDropdownOpen ? '▴' : '▾'}</span>
                </button>
              </div>
            </div>

            {/* Timeline (word editor) */}
            {subtitleWords.length > 0 && duration > 0 ? (
              <div>
                <div className="flex justify-end mb-1.5">
                  <button
                    onClick={handleUndo}
                    disabled={!canUndo}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[9px] font-bold uppercase tracking-widest transition-all ${canUndo ? 'bg-[#D4AF37] text-black active:scale-95 hover:bg-[#E5BE48]' : 'bg-white/5 text-white/20 pointer-events-none'}`}
                  >
                    <span className="text-[11px]">↩️</span> UNDO
                  </button>
                </div>
                <Timeline
                  chunks={[{
                    start: subtitleWords[0].start,
                    end: subtitleWords[subtitleWords.length - 1].end,
                    words: subtitleWords.map(item => ({ word: item.word, start: item.start, end: item.end, forceBreak: !!item.forceBreak })),
                  }]}
                  duration={duration}
                  getCurrentTime={getTimeCallback}
                  isPlaying={isPlayingCallback}
                  onDragStart={() => pushHistory(subtitleWords)}
                  onWordTimingChange={(_chunkIndex, wordIndex, patch) => {
                    setSubtitleWords(prev => prev.map((item, i) =>
                      i === wordIndex ? { ...item, ...patch } : item
                    ));
                  }}
                  onWordTextChange={(_chunkIndex, wordIndex, text) => {
                    pushHistory(subtitleWords);
                    setSubtitleWords(prev => prev.map((item, i) =>
                      i === wordIndex ? { ...item, word: text } : item
                    ));
                  }}
                  onWordDelete={(_chunkIndex, wordIndex) => {
                    pushHistory(subtitleWords);
                    setSubtitleWords(prev => prev.filter((_, i) => i !== wordIndex));
                  }}
                  onWordToggleForceBreak={(_chunkIndex, wordIndex) => {
                    pushHistory(subtitleWords);
                    setSubtitleWords(prev => prev.map((item, i) =>
                      i === wordIndex ? { ...item, forceBreak: !item.forceBreak } : item
                    ));
                  }}
                  onSeek={(t) => {
                    setCurrentTime(t);
                    currentTimeRef.current = t;
                    lastDrawnTimeRef.current = -1;
                    if (phase2VideoRef.current) phase2VideoRef.current.currentTime = t;
                  }}
                />
              </div>
            ) : (
              <div className="h-16 bg-[#0c0c0c] border border-white/[0.03] rounded-2xl flex items-center justify-center">
                <div className="text-[8px] uppercase tracking-[0.3em] text-white/10 font-bold">No subtitle data</div>
              </div>
            )}

            {/* Size & Pump slider */}
            <div className="flex items-center gap-3 bg-white/[0.02] border border-white/5 rounded-2xl px-4 py-3">
              <span className="text-[7px] uppercase tracking-[0.3em] text-white/30 font-bold shrink-0 select-none">Size</span>
              <input type="range" min="0.5" max="1.5" step="0.01" value={fontScale} onChange={(e) => setFontScale(parseFloat(e.target.value))} className="flex-1 accent-[#D4AF37]" />
              <button
                onClick={() => setEnablePump(p => !p)}
                className={`ml-2 px-3 py-1.5 rounded-lg text-[8px] uppercase tracking-widest font-bold transition-all ${enablePump ? 'bg-[#D4AF37]/20 text-[#D4AF37] border border-[#D4AF37]/30' : 'bg-white/5 text-white/30 border border-white/5'}`}
              >
                Pump {enablePump ? 'ON' : 'OFF'}
              </button>
            </div>

            {/* Words per line selector */}
            <div className="flex items-center gap-3 bg-white/[0.02] border border-white/5 rounded-2xl px-4 py-3">
              <span className="text-[7px] uppercase tracking-[0.3em] text-white/30 font-bold shrink-0 select-none">UP TO __ WORDS</span>
              <div className="flex-1 flex items-center justify-center gap-1.5">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    onClick={() => setWordsPerLine(n)}
                    className={`w-8 h-8 rounded-lg text-[11px] font-bold transition-all ${
                      wordsPerLine === n
                        ? 'bg-[#D4AF37] text-black shadow-[0_0_12px_rgba(212,175,55,0.4)]'
                        : 'bg-white/5 text-white/40 hover:bg-white/10 hover:text-white/70'
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex flex-col gap-3 md:gap-4 pb-4">
              <button
                onClick={goBackToCutMode}
                className="w-full py-3 border border-white/10 rounded-full uppercase tracking-[0.4em] text-[8px] font-bold text-white/40 hover:bg-white/5 transition-all text-center"
              >
                ← Back to Cutting
              </button>
              <button
                onClick={renderVideo}
                disabled={isExporting}
                className={`w-full py-5 rounded-full uppercase tracking-[0.5em] text-[10px] font-black transition-all ${!isExporting ? 'bg-[#D4AF37] text-black shadow-[0_0_40px_rgba(212,175,55,0.3)] active:scale-95' : 'bg-white/5 text-white/20'}`}
              >
                {isExporting ? `Burning ${exportProgress}%` : 'Export Master'}
              </button>
            </div>
          </div>
        </main>

        <LabelFooter />
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // ██  PHASE 1: CUT MODE (original cutting UI, no subtitle buttons)
  // ═══════════════════════════════════════════════════════════════════
  return (
    <div className="min-h-[100dvh] text-white flex flex-col items-center overflow-y-auto overflow-x-hidden font-sans">
      <header className="w-full relative z-20 flex flex-col items-center shrink-0 mt-8 mb-6">
        <img src="/logo.png" alt="deVee" className="w-[100px] h-[100px] mb-2 object-contain" />
        <h1 className="text-[10px] font-bold tracking-[0.5em] uppercase text-white/60">REELS CUTTER</h1>
      </header>

      <main className="w-full max-w-[550px] mx-auto flex flex-col items-center flex-1 justify-center px-2 md:px-6 gap-4 py-6">
        <div className="w-full bg-[#0c0c0c] border border-white/[0.05] rounded-[40px] p-4 md:p-6 relative group shadow-2xl">
          <div className="relative flex flex-col items-center gap-4">
            {videoUrl ? (
              <div className="w-full flex flex-col items-center">

                {/* ── Video preview ── */}
                <div
                  className="relative w-[200px] bg-black rounded-[30px] overflow-hidden border border-white/10 mb-2 shadow-inner flex-shrink-0"
                  style={{ height: '356px' }}
                  onClick={() => { const av = getAV(); av?.paused ? av.play() : av?.pause(); }}
                >
                  {/* Video A */}
                  <video
                    ref={videoARef}
                    src={videoUrl}
                    onLoadedMetadata={(e) => {
                      setDuration(e.currentTarget.duration);
                      if (!origWidthCapturedRef.current && e.currentTarget.videoWidth > 0) {
                        origVideoWidthRef.current = e.currentTarget.videoWidth;
                        origWidthCapturedRef.current = true;
                      }
                    }}
                    onTimeUpdate={handleTimeUpdate}
                    onPlay={() => { if (!activeIsARef.current) return; if (!warmingUpRef.current) setPaused(false); startLoop(); }}
                    onSeeked={(e) => {
                      if (!activeIsARef.current) return;
                      if (programmaticSeekRef.current) { programmaticSeekRef.current = false; return; }
                      if (!e.currentTarget.paused && !draggingRef.current && !seekDraggingRef.current) startLoop();
                    }}
                    onPause={() => { if (!activeIsARef.current) return; stopLoop(); if (!warmingUpRef.current) setPaused(true); }}
                    className="absolute inset-0 w-full h-full object-cover pointer-events-none"
                    style={{ opacity: activeIsA ? 1 : 0, zIndex: activeIsA ? 1 : 0, transform: `scale(${previewZoom})`, transition: 'transform 0.06s ease' }}
                    playsInline
                  />
                  {/* Video B */}
                  <video
                    ref={videoBRef}
                    src={videoUrl ?? undefined}
                    onTimeUpdate={handleTimeUpdate}
                    onPlay={() => { if (activeIsARef.current) return; if (!warmingUpRef.current) setPaused(false); startLoop(); }}
                    onSeeked={(e) => {
                      if (activeIsARef.current) return;
                      if (programmaticSeekRef.current) { programmaticSeekRef.current = false; return; }
                      if (!e.currentTarget.paused && !draggingRef.current && !seekDraggingRef.current) startLoop();
                    }}
                    onPause={() => { if (activeIsARef.current) return; stopLoop(); if (!warmingUpRef.current) setPaused(true); }}
                    className="absolute inset-0 w-full h-full object-cover pointer-events-none"
                    style={{ opacity: activeIsA ? 0 : 1, zIndex: activeIsA ? 0 : 1, transform: `scale(${previewZoom})`, transition: 'transform 0.06s ease' }}
                    playsInline
                  />

                  {processing && (
                    <div className="absolute inset-0 bg-black/70 backdrop-blur-md flex flex-col items-center justify-center p-4 text-center gap-3 z-10">
                      <span className="text-[#D4AF37] text-[10px] uppercase tracking-widest animate-pulse font-bold">{status}</span>
                      {progress > 0 && (
                        <div className="w-[140px] flex flex-col items-center gap-1">
                          <div className="w-full h-[2px] bg-white/10 rounded-full overflow-hidden">
                            <div className="h-full bg-[#D4AF37] rounded-full transition-all duration-200" style={{ width: `${progress}%` }} />
                          </div>
                          <span className="text-white/40 text-[8px] tracking-widest">{progress}%</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {segments && (
                  <div className="flex flex-col items-center gap-1 mt-2 mb-2">
                    <p className="text-white/60 text-[8px] tracking-[0.12em] font-light">Don&apos;t worry about the quality — it&apos;s just a preview</p>
                    <p className="text-white/60 text-[8px] tracking-[0.05em] font-light uppercase">Do not worry about quality, this is only a preview</p>
                  </div>
                )}

                {/* ── Bottom panel — CUT MODE only ── */}
                {segments && !zoomMode && (
                  <div className="w-full mb-6 space-y-2">
                    {/* ── CUTTER MODE ── */}
                    <div className="flex items-center justify-between px-0.5">
                      <div className="flex items-center gap-2">
                        <span className="text-white/25 text-[7px] uppercase tracking-[0.2em]">Edit</span>
                        <button
                          disabled={!canUndoCut}
                          onClick={() => {
                            const h = cutHistoryRef.current;
                            if (h.length > 0) {
                              const prev = h.pop();
                              setSegments(prev ?? null);
                              setCanUndoCut(h.length > 0);
                            }
                          }}
                          className={`px-3 py-1.5 rounded-full text-[9px] font-bold tracking-widest uppercase flex items-center gap-1.5 transition-colors ${canUndoCut ? 'bg-[#D4AF37] text-black active:scale-95 hover:bg-[#E5BE48]' : 'bg-white/5 text-white/20 pointer-events-none'}`}
                        >
                          <span className="text-[11px]">↩️</span> UNDO
                        </button>
                        <button
                          onClick={() => {
                            if (!segments) return;
                            const t = currentTime;
                            const idx = segments.findIndex(s => t > s.start + 0.1 && t < (s.end ?? duration) - 0.1);
                            if (idx !== -1) {
                              cutHistoryRef.current.push([...segments]);
                              setCanUndoCut(true);
                              const seg = segments[idx];
                              const newSegs = [...segments];
                              newSegs.splice(idx, 1, 
                                { start: seg.start, end: t },
                                { start: t, end: seg.end }
                              );
                              setSegments(newSegs);
                            }
                          }}
                          className={`px-3 py-1.5 rounded-full text-[9px] font-bold tracking-widest uppercase flex items-center gap-1.5 transition-colors ${segments?.some(s => currentTime > s.start + 0.1 && currentTime < (s.end ?? duration) - 0.1) ? 'bg-[#D4AF37] text-black active:scale-95 hover:bg-[#E5BE48]' : 'bg-white/5 text-white/20 pointer-events-none'}`}
                        >
                          <span className="text-[11px]">✂️</span> SPLIT
                        </button>
                      </div>
                      <div className="flex items-center gap-2">
                        <button onClick={() => { setZoom(z => Math.max(1, z / 2)); if (zoom <= 2 && timelineContainerRef.current) timelineContainerRef.current.scrollLeft = 0; }} className="w-7 h-7 flex items-center justify-center bg-white/[0.04] hover:bg-white/[0.09] border border-white/[0.07] rounded-lg text-white/50 text-sm transition-colors">−</button>
                        <span className="text-white/30 text-[9px] w-5 text-center">{zoom}×</span>
                        <button onClick={() => setZoom(z => Math.min(16, z * 2))} className="w-7 h-7 flex items-center justify-center bg-white/[0.04] hover:bg-white/[0.09] border border-white/[0.07] rounded-lg text-white/50 text-sm transition-colors">+</button>
                      </div>
                    </div>

                    <div ref={timelineContainerRef} className="w-full overflow-x-auto rounded-xl [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]" style={{ WebkitOverflowScrolling: 'touch' } as React.CSSProperties}>
                      <div className="relative h-8" style={{ width: `${zoom * 100}%`, minWidth: '100%' }}>
                        {segments.map((seg, i) => (
                          <button key={`del-${i}`} className="absolute top-1 -translate-x-1/2 flex items-center justify-center w-6 h-6 text-red-500 hover:text-red-400 text-[14px] font-black leading-none z-20 transition-colors" style={{ left: `${(((seg.start + (seg.end ?? duration)) / 2) / duration) * 100}%` }} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); if (segments) { cutHistoryRef.current.push([...segments]); setCanUndoCut(true); } setSegments(prev => prev ? prev.filter((_, idx) => idx !== i) : prev); }}>×</button>
                        ))}
                      </div>
                      <div ref={timelineRef} className="relative h-20 md:h-14 bg-white/[0.03] border border-white/10 rounded-xl" style={{ width: `${zoom * 100}%`, minWidth: '100%', touchAction: zoom > 1 ? 'pan-x' : 'none' }}>
                        {waveformBg && (
                          <div className="absolute inset-0 rounded-xl pointer-events-none overflow-hidden" style={{ backgroundImage: `url(${waveformBg})`, backgroundSize: '100% 100%', opacity: 0.2 }} />
                        )}
                        {segments.map((seg, i) => (
                          <div key={i} className="absolute top-0 bottom-0 cursor-ew-resize" style={{ left: `${(seg.start / duration) * 100}%`, width: `${(((seg.end ?? duration) - seg.start) / duration) * 100}%`, touchAction: 'none' }}
                            onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); const rect = e.currentTarget.getBoundingClientRect(); draggingRef.current = { index: i, edge: (e.clientX - rect.left) < rect.width / 2 ? 'start' : 'end' }; if (segments) { cutHistoryRef.current.push([...segments]); setCanUndoCut(true); } }}
                            onPointerMove={(e) => { if (!draggingRef.current || !timelineRef.current) return; const rect = timelineRef.current.getBoundingClientRect(); const t = Math.max(0, Math.min(e.clientX - rect.left, rect.width)) / rect.width * duration; const { edge } = draggingRef.current; setSegments(prev => prev ? prev.map((s, idx) => { if (idx !== i) return s; if (edge === 'start') return { ...s, start: Math.min(t, (s.end ?? duration) - 0.1) }; return { ...s, end: Math.max(t, s.start + 0.1) }; }) : prev); }}
                            onPointerUp={(e) => { e.currentTarget.releasePointerCapture(e.pointerId); const dragIdx = draggingRef.current?.index ?? i; draggingRef.current = null; const seg = segmentsRef.current?.[dragIdx]; const av = getAV(); if (av && seg) av.currentTime = seg.start; if (av && !av.paused) startLoop(); }}
                          >
                            <div className="absolute left-0 top-0 h-full w-2 bg-[#D4AF37] rounded-l-sm pointer-events-none" />
                            <div className="absolute left-2 right-2 top-0 bottom-0 bg-[#D4AF37]/30 pointer-events-none" />
                            <div className="absolute right-0 top-0 h-full w-2 bg-[#D4AF37] rounded-r-sm pointer-events-none" />
                          </div>
                        ))}
                        {/* Red Draggable Playhead */}
                        <div className="absolute top-0 bottom-0 w-[1px] bg-red-500 z-50 pointer-events-none" style={{ left: `${(currentTime / duration) * 100}%` }}>
                          <div className="absolute -top-3 left-1/2 -translate-x-1/2 w-4 h-4 bg-red-500 rotate-45 cursor-grab active:cursor-grabbing pointer-events-auto shadow-[0_0_8px_rgba(239,68,68,0.6)]"
                            onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); seekDraggingRef.current = true; e.currentTarget.setPointerCapture(e.pointerId); }}
                            onPointerMove={(e) => { if (!seekDraggingRef.current || !timelineRef.current) return; const av = getAV(); if (!av) return; const rect = timelineRef.current.getBoundingClientRect(); av.currentTime = Math.max(0, Math.min((e.clientX - rect.left) / rect.width, 1)) * duration; }}
                            onPointerUp={(e) => { seekDraggingRef.current = false; e.currentTarget.releasePointerCapture(e.pointerId); const av = getAV(); if (av && !av.paused) startLoop(); }}
                          />
                        </div>
                      </div>
                    </div>

                    <div ref={seekBarRef} className="relative w-full h-10 md:h-6 flex items-center cursor-pointer" style={{ touchAction: 'none' }} onClick={(e) => { const av = getAV(); if (!seekBarRef.current || !av) return; const rect = seekBarRef.current.getBoundingClientRect(); av.currentTime = Math.max(0, Math.min((e.clientX - rect.left) / rect.width, 1)) * duration; }}>
                      <div className="relative w-full h-[3px] bg-white/[0.08] rounded-full pointer-events-none">
                        <div className="absolute left-0 top-0 h-full bg-[#D4AF37]/50 rounded-full" style={{ width: `${(currentTime / duration) * 100}%` }} />
                      </div>
                      <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-5 h-5 md:w-3 md:h-3 rounded-full bg-[#D4AF37] shadow-[0_0_8px_rgba(212,175,55,0.45)] cursor-grab active:cursor-grabbing pointer-events-auto" style={{ left: `${(currentTime / duration) * 100}%` }}
                        onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); seekDraggingRef.current = true; e.currentTarget.setPointerCapture(e.pointerId); }}
                        onPointerMove={(e) => { const av = getAV(); if (!seekDraggingRef.current || !seekBarRef.current || !av) return; const rect = seekBarRef.current.getBoundingClientRect(); av.currentTime = Math.max(0, Math.min((e.clientX - rect.left) / rect.width, 1)) * duration; }}
                        onPointerUp={(e) => { seekDraggingRef.current = false; e.currentTarget.releasePointerCapture(e.pointerId); const av = getAV(); if (av && !av.paused) startLoop(); }}
                      />
                    </div>

                    <div className="flex justify-center items-center gap-3">
                      <button onClick={() => { const v = getAV(); const segs = segmentsRef.current; if (!v) return; v.pause(); v.currentTime = segs?.[0]?.start ?? 0; setPaused(true); }} className="w-9 h-9 flex items-center justify-center bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] rounded-lg transition-colors">
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1" y="2" width="2" height="10" rx="1" fill="currentColor" className="text-white/60" /><path d="M13 2.5L5 7l8 4.5V2.5Z" fill="currentColor" className="text-white/60" /></svg>
                      </button>
                      <button onClick={() => { const av = getAV(); av?.paused ? av.play() : av?.pause(); }} className="px-6 py-2 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] rounded-lg text-[9px] uppercase tracking-widest transition-colors">{paused ? 'Play' : 'Pause'}</button>
                    </div>

                    <div className="flex justify-center items-center gap-3">
                      <button onClick={() => setZoomMode(true)} className={`px-5 py-1.5 text-[8px] uppercase tracking-widest rounded-lg border transition-colors ${zoomPerCut ? 'bg-white/[0.12] border-white/40 text-white/80' : 'bg-white/[0.04] border-white/[0.07] text-white/30 hover:text-white/50'}`}>Zoom</button>
                      {subtitleWords.length > 0 && (
                        <button onClick={finishCutting} disabled={processing} className="px-5 py-1.5 text-[8px] uppercase tracking-widest rounded-lg border bg-[#D4AF37]/20 border-[#D4AF37]/50 text-[#D4AF37] hover:bg-[#D4AF37]/30 transition-colors">Done Cutting →</button>
                      )}
                    </div>
                  </div>
                )}

                {/* ── ZOOM MODE ── */}
                {segments && zoomMode && (
                  <div className="w-full mb-6 space-y-2">
                    {/* Seek bar */}
                    <div className="relative w-full h-10 md:h-6 flex items-center cursor-pointer" style={{ touchAction: 'none' }}
                      onClick={(e) => { const av = getAV(); if (!av) return; const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect(); av.currentTime = Math.max(0, Math.min((e.clientX - rect.left) / rect.width, 1)) * duration; }}
                    >
                      <div className="relative w-full h-[3px] bg-white/[0.08] rounded-full pointer-events-none">
                        <div className="absolute left-0 top-0 h-full bg-[#D4AF37]/50 rounded-full" style={{ width: `${(currentTime / duration) * 100}%` }} />
                      </div>
                      <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-5 h-5 md:w-3 md:h-3 rounded-full bg-[#D4AF37] shadow-[0_0_8px_rgba(212,175,55,0.45)] cursor-grab active:cursor-grabbing pointer-events-auto" style={{ left: `${(currentTime / duration) * 100}%` }}
                        onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); seekDraggingRef.current = true; e.currentTarget.setPointerCapture(e.pointerId); }}
                        onPointerMove={(e) => { const av = getAV(); if (!seekDraggingRef.current || !av) return; const rect = (e.currentTarget.parentElement as HTMLDivElement).getBoundingClientRect(); av.currentTime = Math.max(0, Math.min((e.clientX - rect.left) / rect.width, 1)) * duration; }}
                        onPointerUp={(e) => { seekDraggingRef.current = false; e.currentTarget.releasePointerCapture(e.pointerId); const av = getAV(); if (av && !av.paused) startLoop(); }}
                      />
                    </div>

                    {/* Play controls */}
                    <div className="flex justify-center items-center gap-3">
                      <button onClick={() => { const v = getAV(); const segs = segmentsRef.current; if (!v) return; v.pause(); v.currentTime = segs?.[0]?.start ?? 0; setPaused(true); }} className="w-9 h-9 flex items-center justify-center bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] rounded-lg transition-colors">
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1" y="2" width="2" height="10" rx="1" fill="currentColor" className="text-white/60" /><path d="M13 2.5L5 7l8 4.5V2.5Z" fill="currentColor" className="text-white/60" /></svg>
                      </button>
                      <button onClick={() => { const av = getAV(); av?.paused ? av.play() : av?.pause(); }} className="px-6 py-2 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] rounded-lg text-[9px] uppercase tracking-widest transition-colors">{paused ? 'Play' : 'Pause'}</button>
                    </div>

                    {/* Zoom settings */}
                    <div className="flex flex-col items-center gap-3 py-2">
                      <span className="text-white/25 text-[7px] uppercase tracking-[0.2em]">Zoom Frequency</span>
                      <div className="flex items-center gap-3">
                        <button onClick={() => { setZoomFreq(1); setZoomPerCut(true); }} className={`px-6 py-2 text-[8px] uppercase tracking-widest rounded-lg border transition-colors ${zoomFreq === 1 && zoomPerCut ? 'bg-white/[0.12] border-white/40 text-white/80' : 'bg-white/[0.04] border-white/[0.07] text-white/30 hover:text-white/50'}`}>Fast</button>
                        <button onClick={() => { setZoomFreq(4); setZoomPerCut(true); }} className={`px-6 py-2 text-[8px] uppercase tracking-widest rounded-lg border transition-colors ${zoomFreq === 4 && zoomPerCut ? 'bg-white/[0.12] border-white/40 text-white/80' : 'bg-white/[0.04] border-white/[0.07] text-white/30 hover:text-white/50'}`}>Subtle</button>
                      </div>
                    </div>

                    {/* Bottom row: ← back | off toggle */}
                    <div className="flex items-center justify-between px-0.5">
                      <button onClick={() => setZoomMode(false)} className="w-7 h-7 flex items-center justify-center bg-white/[0.04] hover:bg-white/[0.09] border border-white/[0.07] rounded-lg text-white/50 text-sm transition-colors flex-shrink-0">←</button>
                      <button onClick={() => setZoomPerCut(p => !p)} className={`px-5 py-1.5 text-[8px] uppercase tracking-widest rounded-lg border transition-colors ${zoomPerCut ? 'bg-white/[0.12] border-white/40 text-white/80' : 'bg-white/[0.04] border-white/[0.07] text-white/30 hover:text-white/50'}`}>{zoomPerCut ? 'Zoom On' : 'Zoom Off'}</button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <label className="w-full cursor-pointer">
                <div className="w-full bg-[#080808] rounded-[28px] flex flex-col items-center justify-center py-24 md:py-32">
                  <div className="w-14 h-14 rounded-full border border-white/20 flex items-center justify-center mb-5">
                    <span className="text-white/35 text-2xl leading-none font-thin select-none">+</span>
                  </div>
                  <span className="text-[8px] uppercase tracking-[0.55em] text-white/25">Upload Media</span>
                </div>
                <input type="file" className="hidden" onChange={handleFileUpload} accept="video/*" />
              </label>
            )}

            {!segments && !videoFile && (
              <button disabled className="w-full py-5 rounded-[22px] uppercase tracking-[0.4em] text-[10px] font-black cursor-default" style={{ backgroundColor: '#0e0e0e', color: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.04)' }}>Cut Video</button>
            )}
            {!segments && videoFile && (
              <div className="w-full text-center text-[10px] uppercase tracking-[0.4em] text-white/20 font-bold py-5">
                Waiting for Auto Cut...
              </div>
            )}
            {segments && (
              <button onClick={renderVideo} disabled={processing || isExporting} className="w-full py-5 rounded-[22px] bg-[#D4AF37] text-black uppercase tracking-[0.4em] text-[10px] font-black transition-transform duration-200 hover:scale-[1.025] active:scale-[0.97]">Export Master</button>
            )}
          </div>
        </div>
      </main>
      {/* Floating Logo Watermark (Desktop Only) */}
      <div className="hidden md:flex fixed bottom-6 left-6 z-50 opacity-40 hover:opacity-100 transition-opacity duration-300">
        <a href="https://devee-music.com" target="_blank" rel="noopener noreferrer" className="flex items-center justify-center">
          <div className="w-10 h-10 rounded-full overflow-hidden border border-white/10 shadow-[0_0_15px_rgba(0,0,0,0.5)]">
            <img src="/label_logo.png" alt="deVee" className="w-full h-full object-cover" />
          </div>
        </a>
      </div>
    </div>
  );
}

