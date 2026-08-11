'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import Timeline from './Timeline';

export const FONTS = [
  { id: 'NotoSansTight', label: 'Noto Tight', file: '/NotoSansTight.ttf' },
  { id: 'HeeboExtraBold', label: 'Heebo XBold', file: '/Heebo-ExtraBold.ttf' },
  { id: 'Heebo', label: 'Heebo Black', file: '/Heebo.ttf' },
  { id: 'NotoSansHebrewBlack', label: 'Noto Hebrew', file: '/NotoSansHebrew-Black.ttf' },
  { id: 'NotoSansHebrewEB', label: 'Noto HEB XB', file: '/NotoSansHebrew-ExtraBold.ttf' },
  { id: 'RubikBlack', label: 'Rubik Black', file: '/Rubik-Black.ttf' },
  { id: 'SecularOne', label: 'Secular One', file: '/SecularOne-Regular.ttf' },
  { id: 'VarelaRound', label: 'Varela Round', file: '/VarelaRound-Regular.ttf' },
  { id: 'FrankRuhlLibreBold', label: 'Frank Ruhl', file: '/FrankRuhlLibre-Bold.ttf' },
] as const;

export type FontId = typeof FONTS[number]['id'];

export interface SubtitleWord {
  word: string;
  start: number;
  end: number;
  forceBreak?: boolean;
}

export interface SubtitleStyle {
  words: SubtitleWord[];
  fontFamily: FontId;
  subtitlePos: number;
  fontScale: number;
  enablePump: boolean;
  wordsPerLine: number;
}

// Silence between two words at or above this forces a line break even when the line
// is not full yet, so a caption never runs across a pause in the delivery.
const GAP_BREAK_THRESHOLD = 0.5;

// The working copy is 360p, so the canvas is oversampled to keep subtitle text crisp.
const PREVIEW_SCALE_DESKTOP = 3.0;
const PREVIEW_SCALE_MOBILE = 1.5;

/** Group words into lines of up to `maxPerLine`, breaking early on a pause or on a
 *  break the user placed by hand. Preview and export both call this, so what is on
 *  screen is what gets burned in. */
export function buildWordGroups<T extends { start: number; end: number; forceBreak?: boolean }>(
  words: T[],
  maxPerLine: number,
): T[][] {
  if (words.length === 0) return [];
  const groups: T[][] = [[words[0]]];
  for (let i = 1; i < words.length; i++) {
    const current = groups[groups.length - 1];
    const gap = words[i].start - words[i - 1].end;
    if (current.length >= maxPerLine || gap >= GAP_BREAK_THRESHOLD || words[i].forceBreak) {
      groups.push([words[i]]);
    } else {
      current.push(words[i]);
    }
  }
  return groups;
}

const formatTime = (time: number) => {
  if (isNaN(time)) return '00:00';
  const m = Math.floor(time / 60).toString().padStart(2, '0');
  const s = Math.floor(time % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
};

interface Props {
  /** Blob URL of the cut video this editor works on. */
  videoUrl: string;
  /** Word timings from Whisper, already on this video's timeline. */
  initialWords: SubtitleWord[];
  isExporting: boolean;
  exportProgress: number;
  onExport: (style: SubtitleStyle) => void;
  /** Starting values for the controls the upload screen presets. */
  initialFontScale?: number;
  initialEnablePump?: boolean;
  initialWordsPerLine?: number;
}

/**
 * The subtitle editor, mounted fresh once cutting is finished.
 *
 * This used to live inside the page component alongside the cut-review UI, which
 * meant it inherited that phase's state, refs and running effects and never started
 * from a clean slate. Keeping it in its own component means cut review unmounts
 * completely when this takes over — nothing from it is left running underneath.
 */
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
  const [words, setWords] = useState<SubtitleWord[]>(initialWords);
  const [fontFamily, setFontFamily] = useState<FontId>('HeeboExtraBold');
  const [loadedFonts, setLoadedFonts] = useState<Set<string>>(new Set());
  const [fontDropdownOpen, setFontDropdownOpen] = useState(false);
  const [subtitlePos, setSubtitlePos] = useState(15);
  const [fontScale, setFontScale] = useState(initialFontScale);
  const [enablePump, setEnablePump] = useState(initialEnablePump);
  const [wordsPerLine, setWordsPerLine] = useState(initialWordsPerLine);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [paused, setPaused] = useState(true);
  const [canUndo, setCanUndo] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // syncAndDraw runs every frame and must never read stale state
  const subtitlePosRef = useRef(15);
  const fontFamilyRef = useRef<FontId>('HeeboExtraBold');
  const wordsPerLineRef = useRef(initialWordsPerLine);
  const currentTimeRef = useRef(0);
  const lastDrawnTimeRef = useRef(-1);
  const lastUIUpdateRef = useRef(0);
  const lastDrawTimeMsRef = useRef(0);
  const historyRef = useRef<SubtitleWord[][]>([]);
  const syncAndDrawRef = useRef<() => void>(() => {});
  const togglePlayRef = useRef<() => Promise<void>>(async () => {});
  const previewScaleRef = useRef(
    typeof window !== 'undefined' && window.innerWidth < 768
      ? PREVIEW_SCALE_MOBILE
      : PREVIEW_SCALE_DESKTOP,
  );

  useEffect(() => { subtitlePosRef.current = subtitlePos; }, [subtitlePos]);
  useEffect(() => { fontFamilyRef.current = fontFamily; }, [fontFamily]);
  useEffect(() => { wordsPerLineRef.current = wordsPerLine; }, [wordsPerLine]);

  // Empty deps keeps the reference stable, so Timeline's own RAF is never restarted
  const getTimeCallback = useCallback(() => currentTimeRef.current, []);
  const isPlayingCallback = useCallback(() => !!(videoRef.current && !videoRef.current.paused), []);

  function pushHistory(snapshot: SubtitleWord[]) {
    historyRef.current = [...historyRef.current.slice(-29), [...snapshot]];
    setCanUndo(true);
  }

  const handleUndo = useCallback(() => {
    const h = historyRef.current;
    if (h.length === 0) return;
    const prev = h[h.length - 1];
    historyRef.current = h.slice(0, -1);
    setWords(prev);
    setCanUndo(h.length > 1);
  }, []);

  useEffect(() => {
    FONTS.forEach(({ id, file }) => {
      const font = new FontFace(id, `url(${file})`);
      font.load().then(f => {
        document.fonts.add(f);
        setLoadedFonts(prev => new Set([...prev, id]));
      }).catch(() => {});
    });
  }, []);

  const syncAndDraw = () => {
    const media = videoRef.current;
    const canvas = canvasRef.current;
    if (!media || !canvas) return;

    const ctx = canvas.getContext('2d');
    const isActive = !media.paused && !media.ended;

    if (isActive) {
      currentTimeRef.current = media.currentTime;
      const now = performance.now();
      // The seek bar does not need 60fps; the subtitle timing does
      if (now - lastUIUpdateRef.current > 66) {
        setCurrentTime(media.currentTime);
        lastUIUpdateRef.current = now;
      }
    }

    const timeChanged = currentTimeRef.current !== lastDrawnTimeRef.current;
    const now = performance.now();
    const shouldDraw = isActive ? now - lastDrawTimeMsRef.current > 33 : timeChanged;
    if (!ctx || media.videoWidth === 0 || !shouldDraw) return;

    if (isActive) lastDrawTimeMsRef.current = now;
    const scale = previewScaleRef.current;
    const targetW = Math.round(media.videoWidth * scale);
    if (canvas.width !== targetW) {
      canvas.width = targetW;
      canvas.height = Math.round(media.videoHeight * scale);
    }
    ctx.drawImage(media, 0, 0, canvas.width, canvas.height);
    lastDrawnTimeRef.current = currentTimeRef.current;

    if (words.length === 0) return;

    const time = currentTimeRef.current;
    const groups = buildWordGroups(words, wordsPerLineRef.current);
    let activeGroup: SubtitleWord[] | null = null;
    let groupStartIndex = -1;
    let flatIdx = 0;
    for (const group of groups) {
      if (time >= group[0].start && time <= group[group.length - 1].end) {
        activeGroup = group;
        groupStartIndex = flatIdx;
        break;
      }
      flatIdx += group.length;
    }
    if (!activeGroup) return;

    const lineText = activeGroup.map(w => w.word).join(' ');
    const baseSize = (enablePump ? [28, 42, 58][groupStartIndex % 3] : 42) * fontScale;
    const fontSize = Math.round(baseSize * (canvas.height / 500));
    const x = canvas.width / 2;
    const y = canvas.height - (canvas.height * subtitlePosRef.current) / 100;
    const borderW = Math.max(2, Math.round(2.4 * (canvas.height / 500)));

    ctx.save();
    // No weight prefix: the file is already the weight we want, and asking for one it
    // does not have makes the browser fake it — which ffmpeg never does on export.
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
  };

  useEffect(() => { syncAndDrawRef.current = syncAndDraw; });

  useEffect(() => {
    let raf = requestAnimationFrame(function loop() {
      syncAndDrawRef.current();
      raf = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  const togglePlay = async () => {
    const media = videoRef.current;
    if (!media) return;
    if (media.paused) {
      try {
        await media.play();
        setPaused(false);
      } catch (err) {
        console.error('Playback failed', err);
      }
    } else {
      media.pause();
      setPaused(true);
    }
  };
  useEffect(() => { togglePlayRef.current = togglePlay; });

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      if (e.key === ' ') {
        e.preventDefault();
        togglePlayRef.current();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault();
        handleUndo();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handleUndo]);

  const handleSeek = (t: number) => {
    setCurrentTime(t);
    currentTimeRef.current = t;
    lastDrawnTimeRef.current = -1; // force a redraw even though the clock did not move
    if (videoRef.current) videoRef.current.currentTime = t;
  };

  const startDragging = (e: React.MouseEvent | React.TouchEvent) => {
    const startY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    const startPos = subtitlePos;
    const onMove = (ev: MouseEvent | TouchEvent) => {
      const y = 'touches' in ev ? ev.touches[0].clientY : (ev as MouseEvent).clientY;
      const delta = ((startY - y) / (canvasRef.current?.clientHeight || 500)) * 100;
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
    <div className="min-h-[100dvh] w-full text-white flex flex-col items-center overflow-y-auto overflow-x-hidden">
      <header className="w-full relative z-20 flex flex-col items-center shrink-0 mt-8 mb-6">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.png" alt="deVee" className="w-[100px] h-[100px] mb-2 object-contain" />
        <h1 className="text-[10px] font-bold tracking-[0.5em] uppercase text-white/60">REELS CUTTER</h1>
      </header>

      <main className="w-full max-w-2xl mx-auto flex flex-col items-center flex-1 px-4 md:px-6 space-y-3 md:space-y-5 py-4 md:py-6">
        <div className="w-full space-y-3 md:space-y-5">
          <div className="relative w-full h-[48vh] md:h-auto md:aspect-video bg-[#0c0c0c] border border-white/[0.03] rounded-[24px] md:rounded-[32px] overflow-hidden shadow-2xl flex items-center justify-center">
            <div className="relative w-full h-full cursor-pointer" onClick={togglePlay}>
              <video
                ref={videoRef}
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
                    <div className="h-full bg-[#D4AF37] transition-all duration-300" style={{ width: `${exportProgress}%` }} />
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

              <div
                className="absolute left-0 right-0 flex justify-center px-6 text-center select-none z-30 cursor-ns-resize active:cursor-grabbing"
                style={{ bottom: `${subtitlePos}%` }}
                onMouseDown={(e) => { e.stopPropagation(); startDragging(e); }}
                onTouchStart={(e) => { e.stopPropagation(); startDragging(e); }}
              >
                <span className="block h-6 w-full" />
              </div>
            </div>
          </div>

          <div className="flex flex-col bg-[#0c0c0c] border border-white/[0.03] rounded-[24px] p-4 md:p-6 shadow-inner gap-4 md:gap-6 w-full mb-6">
            <div className="flex items-center gap-3 bg-white/[0.02] border border-white/5 rounded-2xl px-4 py-3">
              <button onClick={togglePlay} className="w-9 h-9 shrink-0 rounded-full bg-[#D4AF37] flex items-center justify-center shadow-[0_0_12px_rgba(212,175,55,0.3)] active:scale-95 transition-transform">
                {!paused ? (
                  <div className="flex gap-1">
                    <div className="w-1 h-3 bg-black rounded-full" />
                    <div className="w-1 h-3 bg-black rounded-full" />
                  </div>
                ) : (
                  <div className="w-0 h-0 border-t-[6px] border-t-transparent border-l-[10px] border-l-black border-b-[6px] border-b-transparent ml-1" />
                )}
              </button>
              <input
                type="range" min="0" max={duration || 100} step="0.01" value={currentTime}
                onChange={(e) => handleSeek(parseFloat(e.target.value))}
                className="flex-1 h-2 bg-white/5 rounded-full appearance-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-6 [&::-webkit-slider-thumb]:h-6 [&::-webkit-slider-thumb]:bg-[#D4AF37] [&::-webkit-slider-thumb]:rounded-full cursor-pointer"
              />
              <div className="shrink-0 flex gap-1 text-[9px] font-mono text-white/40">
                <span className="text-white/80">{formatTime(currentTime)}</span>
                <span>/</span>
                <span>{formatTime(duration)}</span>
              </div>
            </div>

            <div className="flex items-center gap-2 bg-white/[0.02] border border-white/5 rounded-2xl px-4 py-3">
              <span className="text-[7px] uppercase tracking-[0.2em] text-white/30 font-bold shrink-0">Pos</span>
              <button onClick={() => setSubtitlePos(p => Math.max(10, p - 5))} className="w-7 h-7 rounded-full bg-white/5 flex items-center justify-center text-[10px] active:scale-90 transition-transform">▼</button>
              <span className="text-[8px] font-mono text-[#D4AF37] w-7 text-center shrink-0">{Math.round(subtitlePos)}%</span>
              <button onClick={() => setSubtitlePos(p => Math.min(90, p + 5))} className="w-7 h-7 rounded-full bg-white/5 flex items-center justify-center text-[10px] active:scale-90 transition-transform">▲</button>
              <div className="w-px h-3.5 bg-white/10 shrink-0 mx-1" />
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
                          <span className={`text-2xl leading-none ${fontFamily === f.id ? 'text-[#D4AF37]' : 'text-white/80'}`} style={{ fontFamily: f.id }}>
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
                  onClick={() => setFontDropdownOpen(p => !p)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[9px] font-bold uppercase tracking-wide transition-all ${fontDropdownOpen ? 'bg-[#D4AF37] text-black' : 'bg-white/5 text-white/40 hover:text-white/70 hover:bg-white/10'}`}
                >
                  <span>{FONTS.find(f => f.id === fontFamily)?.label ?? fontFamily}</span>
                  <span className="opacity-60">{fontDropdownOpen ? '▴' : '▾'}</span>
                </button>
              </div>
            </div>

            {words.length > 0 && duration > 0 ? (
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
                    start: words[0].start,
                    end: words[words.length - 1].end,
                    words: words.map(w => ({ word: w.word, start: w.start, end: w.end, forceBreak: !!w.forceBreak })),
                  }]}
                  duration={duration}
                  getCurrentTime={getTimeCallback}
                  isPlaying={isPlayingCallback}
                  onDragStart={() => pushHistory(words)}
                  onWordTimingChange={(_c, i, patch) => setWords(prev => prev.map((w, n) => (n === i ? { ...w, ...patch } : w)))}
                  onWordTextChange={(_c, i, text) => {
                    pushHistory(words);
                    setWords(prev => prev.map((w, n) => (n === i ? { ...w, word: text } : w)));
                  }}
                  onWordDelete={(_c, i) => {
                    pushHistory(words);
                    setWords(prev => prev.filter((_, n) => n !== i));
                  }}
                  onWordToggleForceBreak={(_c, i) => {
                    pushHistory(words);
                    setWords(prev => prev.map((w, n) => (n === i ? { ...w, forceBreak: !w.forceBreak } : w)));
                  }}
                  onSeek={handleSeek}
                />
              </div>
            ) : (
              <div className="h-16 bg-[#0c0c0c] border border-white/[0.03] rounded-2xl flex items-center justify-center">
                <div className="text-[8px] uppercase tracking-[0.3em] text-white/10 font-bold">No subtitle data</div>
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

            <div className="flex items-center gap-3 bg-white/[0.02] border border-white/5 rounded-2xl px-4 py-3">
              <span className="text-[7px] uppercase tracking-[0.3em] text-white/30 font-bold shrink-0 select-none">UP TO __ WORDS</span>
              <div className="flex-1 flex items-center justify-center gap-1.5">
                {[1, 2, 3, 4, 5].map(n => (
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
                onClick={() => onExport({ words, fontFamily, subtitlePos, fontScale, enablePump, wordsPerLine })}
                disabled={isExporting}
                className={`w-full py-5 rounded-full uppercase tracking-[0.5em] text-[10px] font-black transition-all ${!isExporting ? 'bg-[#D4AF37] text-black shadow-[0_0_40px_rgba(212,175,55,0.3)] active:scale-95' : 'bg-white/5 text-white/20'}`}
              >
                {isExporting ? `Burning ${exportProgress}%` : 'Export Master'}
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
