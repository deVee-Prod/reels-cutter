'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Timeline from './Timeline';

// Transplanted verbatim from reels-dubber's editor. Only the accent colour, the
// title and the source of the video differ — everything the drag touches is the
// same code, so the two tools cannot drift apart again.

export const FONTS = [
  { id: 'NotoSansTight',       label: 'Noto Tight',   file: '/NotoSansTight.ttf'          },
  { id: 'HeeboExtraBold',      label: 'Heebo XBold',   file: '/Heebo-ExtraBold.ttf'        },
  { id: 'Heebo',               label: 'Heebo Black',   file: '/Heebo.ttf'                  },
  { id: 'RubikBlack',          label: 'Rubik Black',   file: '/Rubik-Black.ttf'            },
  { id: 'SecularOne',          label: 'Secular One',   file: '/SecularOne-Regular.ttf'     },
  { id: 'VarelaRound',         label: 'Varela Round',  file: '/VarelaRound-Regular.ttf'    },
  { id: 'FrankRuhlLibreBold',  label: 'Frank Ruhl',    file: '/FrankRuhlLibre-Bold.ttf'   },
  { id: 'NotoSansHebrewBlack', label: 'Noto Hebrew',   file: '/NotoSansHebrew-Black.ttf'  },
] as const;

// Canvas preview renders at this fraction of the source resolution —
// cheaper on mobile, looks identical since the canvas is CSS-scaled anyway.
// Height to render the canvas at, in pixels. reels-dubber reaches these numbers by
// scaling its full-resolution upload down by 0.3 and 0.2; expressing the target
// directly means the same canvas comes out of any source, and reels-cutter's 360p
// working copy is scaled *up* to meet it rather than down into an unreadable smear.
const CANVAS_HEIGHT_DESKTOP = 576;
const CANVAS_HEIGHT_MOBILE  = 384;

// Video-to-audio sync: don't seek the video element more often than this
const SYNC_THRESHOLD = 0.15;   // seconds of drift before correcting
const SYNC_COOLDOWN  = 2000;   // ms — minimum gap between two seeks

// Gap threshold (seconds) — if the silence between two consecutive words
// is >= this value, force a group break even if the group isn't full yet.
const GAP_BREAK_THRESHOLD = 0.5;

/** Group words into lines of *up to* `maxPerLine` words.
 *  A new group starts whenever:
 *  1. The current group already has `maxPerLine` words, OR
 *  2. The gap between the previous word's end and the next word's start >= GAP_BREAK_THRESHOLD */
export function buildWordGroups<T extends { start: number; end: number; forceBreak?: boolean }>(words: T[], maxPerLine: number): T[][] {
  if (words.length === 0) return [];
  const groups: T[][] = [[words[0]]];
  for (let i = 1; i < words.length; i++) {
    const current = groups[groups.length - 1];
    const prev = words[i - 1];
    const gap = words[i].start - prev.end;
    // Start a new group if:
    // 1. Current group is full, OR
    // 2. Gap between words >= threshold, OR
    // 3. The current word has forceBreak flag (user manually forced a line break here)
    if (current.length >= maxPerLine || gap >= GAP_BREAK_THRESHOLD || words[i].forceBreak) {
      groups.push([words[i]]);
    } else {
      current.push(words[i]);
    }
  }
  return groups;
}

export type FontId = typeof FONTS[number]['id'];

const formatTime = (time: number) => {
  if (isNaN(time)) return "00:00";
  const m = Math.floor(time / 60).toString().padStart(2, '0');
  const s = Math.floor(time % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
};

export interface SubtitleWord { word: string; start: number; end: number; forceBreak?: boolean }

export interface SubtitleStyle {
  words: SubtitleWord[];
  fontFamily: FontId;
  subtitlePos: number;
  fontScale: number;
  enablePump: boolean;
  wordsPerLine: number;
}

interface Props {
  /** Blob URL of the cut video this editor works on. */
  videoUrl: string;
  /** Word timings from Whisper, already on this video's timeline. */
  initialWords: SubtitleWord[];
  isExporting: boolean;
  exportProgress: number;
  onExport: (style: SubtitleStyle) => void;
  initialFontScale?: number;
  initialEnablePump?: boolean;
  initialWordsPerLine?: number;
}

export default function SubtitleEditor({
  videoUrl,
  initialWords,
  isExporting,
  exportProgress,
  onExport,
  initialFontScale = 0.6,
  initialEnablePump = false,
  initialWordsPerLine = 2,
}: Props) {
  const [transcription, setTranscription] = useState<any[]>(initialWords);
  const [canUndo, setCanUndo] = useState(false);
  const [currentTime, setCurrentTime] = useState(0); 
  const [duration, setDuration] = useState(0); 
  const [subtitlePos, setSubtitlePos] = useState(30);
  const [fontScale, setFontScale] = useState(initialFontScale);
  const [enablePump, setEnablePump] = useState(initialEnablePump);
  const [globalOffset, setGlobalOffset] = useState(0); 
  const [isPlaying, setIsPlaying] = useState(false);
  const [fontFamily, setFontFamily] = useState<FontId>('HeeboExtraBold');
  const [loadedFonts, setLoadedFonts] = useState<Set<string>>(new Set());
  const [fontDropdownOpen, setFontDropdownOpen] = useState(false);
  const [wordsPerLine, setWordsPerLine] = useState(initialWordsPerLine);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLVideoElement>(null);
  const subtitleRef = useRef<HTMLSpanElement>(null);
  const requestRef = useRef<number>(null);
  const lastWordRef = useRef<string>("");
  // Refs so syncAndDraw always reads live values without closing over stale state
  const subtitlePosRef = useRef(30);
  const fontFamilyRef  = useRef<FontId>('HeeboExtraBold');
  const wordsPerLineRef = useRef(initialWordsPerLine);
  // Tracks current time for both the seek bar and the Timeline (iOS: audio.currentTime lags when paused)
  const currentTimeRef = useRef(0);
  // Last time value that was actually drawn to canvas — skip redraw when paused and unchanged
  const lastDrawnTimeRef = useRef(-1);
  // Undo history — stores snapshots of transcription before each destructive op
  const historyRef = useRef<any[][]>([]);
  // Holds the latest syncAndDraw so the RAF loop never runs a stale closure
  const syncAndDrawRef = useRef<() => void>(() => {});
  // Ref to latest togglePlay so spacebar listener never captures a stale closure
  const togglePlayRef = useRef<() => Promise<void>>(async () => {});
  // Performance: throttle React re-renders for the seekbar and video sync seeks
  const lastUIUpdateRef = useRef(0);
  const lastDrawTimeMsRef = useRef(0);
  // Responsive preview scale — detect once, stays stable
  const canvasHeightRef = useRef(
    typeof window !== 'undefined' && window.innerWidth < 768
      ? CANVAS_HEIGHT_MOBILE
      : CANVAS_HEIGHT_DESKTOP
  );

  // Stable callbacks for Timeline — empty deps means same reference every render,
  // so Timeline's RAF effect never restarts and the playhead loop runs without interruption
  const getTimeCallback = useCallback(() => currentTimeRef.current, []);
  const isPlayingCallback = useCallback(() => !!(audioRef.current && !audioRef.current.paused), []);

  // snapshot is the transcription array to save BEFORE a change happens
  function pushHistory(snapshot: any[]) {
    historyRef.current = [...historyRef.current.slice(-29), [...snapshot]];
    setCanUndo(true);
  }

  const handleUndo = useCallback(() => {
    const h = historyRef.current;
    if (h.length === 0) return;
    const prev = h[h.length - 1];
    historyRef.current = h.slice(0, -1);
    setTranscription(prev);
    setCanUndo(h.length > 1);
  }, []);

  const syncAndDraw = () => {
    const media = audioRef.current;
    const canvas = canvasRef.current;

    if (media && canvas) {
      const ctx = canvas.getContext('2d');
      const isActive = !media.paused && !media.ended;

      // Update time ref every frame while playing (keeps subtitles accurate).
      // Throttle the React setState to ~15fps — the seekbar doesn't need 60fps.
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
      
      // Throttle canvas drawing to ~30fps when playing to save mobile battery and prevent stutter
      const shouldDraw = isActive ? (now - lastDrawTimeMsRef.current > 33) : timeChanged;

      if (ctx && media.videoWidth > 0 && shouldDraw) {
        if (isActive) lastDrawTimeMsRef.current = now;
        const scale = canvasHeightRef.current / media.videoHeight;
        const targetW = Math.round(media.videoWidth * scale);
        if (canvas.width !== targetW) {
          canvas.width = targetW;
          canvas.height = Math.round(media.videoHeight * scale);
        }
        ctx.drawImage(media, 0, 0, canvas.width, canvas.height);
        lastDrawnTimeRef.current = currentTimeRef.current;

        // Draw subtitle on top — drawImage already cleared the previous text
        if (canvas.width > 0 && transcription.length > 0) {
          const time = currentTimeRef.current + globalOffset;
          const wpl = wordsPerLineRef.current;
          const wordGroups = buildWordGroups(transcription, wpl);

          // Find which group of words is currently active
          let activeGroup: typeof transcription | null = null;
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
            ctx.font = `${fontSize}px "${fontFamilyRef.current}", sans-serif`;
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

            const groupKey = lineText + activeGroup[0].start;
            if (subtitleRef.current && lastWordRef.current !== groupKey) {
              subtitleRef.current.style.display = 'inline-block';
              subtitleRef.current.style.fontSize = `${(enablePump ? [28, 42, 58][groupStartIndex % 3] : 42) * fontScale}px`;
              lastWordRef.current = groupKey;
            }
          } else {
            if (subtitleRef.current) subtitleRef.current.style.display = 'none';
            lastWordRef.current = '';
          }
        }
      }
    }
  };

  // Keep ref pointed at the latest syncAndDraw every render so the RAF never uses a stale closure
  useEffect(() => { syncAndDrawRef.current = syncAndDraw; });

  // RAF loop — starts once on mount, calls the latest syncAndDraw each frame
  useEffect(() => {
    function loop() {
      syncAndDrawRef.current();
      requestRef.current = requestAnimationFrame(loop);
    }
    requestRef.current = requestAnimationFrame(loop);
    return () => { if (requestRef.current) cancelAnimationFrame(requestRef.current); };
  }, []);

  useEffect(() => { subtitlePosRef.current = subtitlePos; }, [subtitlePos]);
  useEffect(() => { fontFamilyRef.current = fontFamily; }, [fontFamily]);
  useEffect(() => { wordsPerLineRef.current = wordsPerLine; }, [wordsPerLine]);

  // Pre-load all fonts into the browser registry so canvas uses them immediately
  useEffect(() => {
    FONTS.forEach(({ id, file }) => {
      const font = new FontFace(id, `url(${file})`);
      font.load().then(f => {
        document.fonts.add(f);
        setLoadedFonts(prev => new Set([...prev, id]));
      }).catch(() => {});
    });
  }, []);

  const togglePlay = async () => {
    const media = audioRef.current;
    if (!media) return;
    if (media.paused) {
      try {
        await media.play();
        setIsPlaying(true);
      } catch (err) {
        console.error("Playback failed", err);
      }
    } else {
      media.pause();
      setIsPlaying(false);
    }
  };

  // Keep togglePlayRef current so the spacebar listener is never stale
  useEffect(() => { togglePlayRef.current = togglePlay; });

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault();
        handleUndo();
        return;
      }
      if (e.key !== ' ') return;
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      e.preventDefault();
      togglePlayRef.current();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handleUndo]);


  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newTime = parseFloat(e.target.value);
    setCurrentTime(newTime);
    currentTimeRef.current = newTime;
    lastDrawnTimeRef.current = -1; // force canvas redraw on next frame
    if (audioRef.current) audioRef.current.currentTime = newTime;
  };

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

    return (
  <div className="min-h-[100dvh] w-full text-white flex flex-col items-center">
  <header className="w-full relative z-20 flex flex-col items-center shrink-0 mt-8 mb-6">
        <img src="/logo.png" alt="deVee" className="w-[100px] h-[100px] mb-2 object-contain" />
        <h1 className="text-[10px] font-bold tracking-[0.5em] uppercase text-white/60">REELS CUTTER</h1>
      </header>

      <main className="w-full max-w-2xl mx-auto flex flex-col items-center flex-1 justify-center px-4 md:px-6 space-y-4 md:space-y-6 py-6">
        <div className="w-full space-y-4 md:space-y-6">
          <div className="relative w-full h-[40vh] md:h-auto md:aspect-video bg-[#0c0c0c] border border-white/[0.03] rounded-[24px] md:rounded-[32px] overflow-hidden shadow-2xl flex items-center justify-center">
            {videoUrl && (
              <div className="relative w-full h-full cursor-pointer" onClick={togglePlay}>
                <video ref={audioRef} src={videoUrl} preload="auto" style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }} playsInline onLoadedData={() => { lastDrawnTimeRef.current = -1; }} onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)} />
                <canvas ref={canvasRef} className="w-full h-full object-contain" />
                
                {isExporting && (
                  <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/80 backdrop-blur-md">
                    <div className="w-48 h-1 bg-white/10 rounded-full overflow-hidden mb-4">
                      <div className="h-full bg-[#D4AF37] transition-all duration-300" style={{ width: `${exportProgress}%` }}></div>
                    </div>
                    <p className="text-[10px] font-black tracking-[0.5em] text-white uppercase animate-pulse">Burning {exportProgress}%</p>
                  </div>
                )}

                {!isPlaying && !isExporting && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                    <div className="w-16 h-16 md:w-20 md:h-20 bg-white/10 backdrop-blur-md rounded-full flex items-center justify-center border border-white/20 shadow-2xl">
                      <div className="w-0 h-0 border-t-[10px] border-t-transparent border-l-[18px] border-l-white border-b-[10px] border-b-transparent ml-2" />
                    </div>
                  </div>
                )}

                <div 
                  className="absolute left-0 right-0 flex justify-center px-6 text-center select-none z-30 cursor-ns-resize active:cursor-grabbing" 
                  style={{ bottom: `${subtitlePos}%` }} 
                  onMouseDown={(e) => { e.stopPropagation(); startDragging(e); }} 
                  onTouchStart={(e) => { e.stopPropagation(); startDragging(e); }}
                >
                  {/* Text is invisible — canvas draws it. Span stays for drag-target sizing. */}
                  <span ref={subtitleRef} className="font-black uppercase tracking-tighter pointer-events-none" style={{ fontFamily: 'NotoSansTight, sans-serif', color: 'transparent', display: 'none' }} />
                </div>
              </div>
            )}
          </div>

          {videoUrl && (
            <div className="flex items-center gap-3 bg-[#0c0c0c] border border-white/[0.03] rounded-2xl px-4 py-3 shadow-inner">
              <button onClick={togglePlay} className="w-9 h-9 shrink-0 rounded-full bg-[#D4AF37]/10 border border-[#D4AF37]/20 flex items-center justify-center active:scale-95">
                {isPlaying ? (
                  <div className="flex gap-1">
                    <div className="w-1 h-3 bg-[#D4AF37] rounded-full"></div>
                    <div className="w-1 h-3 bg-[#D4AF37] rounded-full"></div>
                  </div>
                ) : (
                  <div className="w-0 h-0 border-t-[6px] border-t-transparent border-l-[10px] border-l-[#D4AF37] border-b-[6px] border-b-transparent ml-1"></div>
                )}
              </button>
              <input type="range" min="0" max={duration || 100} step="0.01" value={currentTime} onChange={handleSeek} className="flex-1 h-2 bg-white/5 rounded-full appearance-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-6 [&::-webkit-slider-thumb]:h-6 [&::-webkit-slider-thumb]:bg-[#D4AF37] [&::-webkit-slider-thumb]:rounded-full cursor-pointer" />
              <div className="shrink-0 flex gap-1 text-[9px] font-mono text-white/40">
                <span className="text-white/80">{formatTime(currentTime)}</span>
                <span>/</span>
                <span>{formatTime(duration)}</span>
              </div>
            </div>
          )}

          {/* Compact Position / Font strip */}
          <div className="flex items-center gap-2 bg-white/[0.02] border border-white/5 rounded-2xl px-4 py-3">
            <span className="text-[7px] uppercase tracking-[0.2em] text-white/30 font-bold shrink-0">Pos</span>
            <button onClick={() => setSubtitlePos(prev => Math.max(10, prev - 5))} className="w-7 h-7 rounded-full bg-white/5 flex items-center justify-center text-[10px] active:scale-90 transition-transform">▼</button>
            <span className="text-[8px] font-mono text-[#D4AF37] w-7 text-center shrink-0">{Math.round(subtitlePos)}%</span>
            <button onClick={() => setSubtitlePos(prev => Math.min(90, prev + 5))} className="w-7 h-7 rounded-full bg-white/5 flex items-center justify-center text-[10px] active:scale-90 transition-transform">▲</button>
            <div className="w-px h-3.5 bg-white/10 shrink-0 mx-1" />
            {/* Font picker dropdown */}
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

          {transcription.length > 0 && duration > 0 ? (
            <div>
              <div className="flex justify-end mb-1.5">
                <button
                  onClick={handleUndo}
                  disabled={!canUndo}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[9px] font-bold uppercase tracking-widest transition-all active:scale-95 ${canUndo ? 'bg-white/5 text-white/60 hover:bg-white/10' : 'text-white/15 cursor-default'}`}
                >
                  ↩ Undo
                </button>
              </div>
              <Timeline
                chunks={[{
                  start: transcription[0].start,
                  end: transcription[transcription.length - 1].end,
                words: transcription.map(item => ({ word: item.word, start: item.start, end: item.end, forceBreak: !!item.forceBreak })),
                }]}
                duration={duration}
                getCurrentTime={getTimeCallback}
                isPlaying={isPlayingCallback}
                onDragStart={() => pushHistory(transcription)}
                onWordTimingChange={(_chunkIndex, wordIndex, patch) => {
                  setTranscription(prev => prev.map((item, i) =>
                    i === wordIndex ? { ...item, ...patch } : item
                  ));
                }}
                onWordTextChange={(_chunkIndex, wordIndex, text) => {
                  pushHistory(transcription);
                  setTranscription(prev => prev.map((item, i) =>
                    i === wordIndex ? { ...item, word: text } : item
                  ));
                }}
                onWordDelete={(_chunkIndex, wordIndex) => {
                  pushHistory(transcription);
                  setTranscription(prev => prev.filter((_, i) => i !== wordIndex));
                }}
                onWordToggleForceBreak={(_chunkIndex, wordIndex) => {
                  pushHistory(transcription);
                  setTranscription(prev => prev.map((item, i) =>
                    i === wordIndex ? { ...item, forceBreak: !item.forceBreak } : item
                  ));
                }}
                onSeek={(t) => {
                  setCurrentTime(t);
                  currentTimeRef.current = t;
                  lastDrawnTimeRef.current = -1; // force canvas redraw on next frame
                  if (audioRef.current) audioRef.current.currentTime = t;
                }}
              />
            </div>
          ) : (
            <div className="h-16 bg-[#0c0c0c] border border-white/[0.03] rounded-2xl flex items-center justify-center">
              <div className="text-[8px] uppercase tracking-[0.3em] text-white/10 font-bold">Waiting for Dub...</div>
            </div>
          )}

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

          <div className="flex flex-col gap-3 md:gap-4 pb-4">

            <button
              onClick={() => onExport({ words: transcription, fontFamily, subtitlePos, fontScale, enablePump, wordsPerLine })}
              disabled={isExporting || transcription.length === 0}
              className={`w-full py-5 rounded-full uppercase tracking-[0.5em] text-[10px] font-black transition-all ${!isExporting && transcription.length > 0 ? 'bg-[#D4AF37] text-black shadow-[0_0_40px_rgba(212,175,55,0.3)] active:scale-95' : 'bg-white/5 text-white/20'}`}
            >
              {isExporting ? `Burning ${exportProgress}%` : 'Export With Subtitles'}
            </button>

            {/* Passing no words is what tells the export to skip the drawtext pass */}
            <button
              onClick={() => onExport({ words: [], fontFamily, subtitlePos, fontScale, enablePump, wordsPerLine })}
              disabled={isExporting}
              className="w-full py-4 rounded-full border border-white/10 uppercase tracking-[0.4em] text-[9px] font-bold text-white/40 hover:bg-white/5 transition-all"
            >
              Export Without Subtitles
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
