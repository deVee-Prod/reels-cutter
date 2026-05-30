'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

const PX_PER_SEC = 180;
const TRACK_HEIGHT = 56;
const RULER_HEIGHT = 24;
const MIN_WORD_DURATION = 0.05;
const CLICK_THRESHOLD_PX = 5;

function formatTimeShort(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function formatTimeFull(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec % 1) * 100);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${cs.toString().padStart(2, '0')}`;
}

interface Word {
  word: string;
  start: number;
  end: number;
  forceBreak?: boolean;
}

interface Chunk {
  start: number;
  end: number;
  text?: string;
  words: Word[];
}

interface FlatWord {
  chunkIndex: number;
  wordIndex: number;
  word: string;
  start: number;
  end: number;
  forceBreak: boolean;
}

interface DragState {
  fw: FlatWord;
  edge: 'left' | 'right' | 'body';
  t0?: number;
  originalStart?: number;
  originalEnd?: number;
  startClientX: number;
  startClientY: number;
}

interface TooltipState {
  time: number;
  x: number;
}

interface TimelineProps {
  chunks: Chunk[];
  duration: number;
  getCurrentTime: () => number;
  isPlaying: () => boolean;
  onWordTimingChange: (chunkIndex: number, wordIndex: number, patch: Partial<Word>) => void;
  onWordTextChange?: (chunkIndex: number, wordIndex: number, text: string) => void;
  onWordDelete?: (chunkIndex: number, wordIndex: number) => void;
  onSeek?: (t: number) => void;
  onDragStart?: () => void;
}

export default function Timeline({
  chunks,
  duration,
  getCurrentTime,
  isPlaying,
  onWordTimingChange,
  onWordTextChange,
  onWordDelete,
  onSeek,
  onDragStart,
}: TimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const userScrolledAt = useRef(0);
  const rafRef = useRef(0);
  const scrollTrackRef = useRef<HTMLDivElement>(null);
  const scrollThumbRef = useRef<HTMLDivElement>(null);
  const scrollDragRef = useRef<{ startX: number; startScrollLeft: number } | null>(null);

  const [drag, setDrag] = useState<DragState | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const editingInputRef = useRef<HTMLInputElement | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selectedKeyRef = useRef<string | null>(null);
  const lastTapTimeRef = useRef<number>(0);
  const onWordDeleteRef = useRef(onWordDelete);
  useEffect(() => { onWordDeleteRef.current = onWordDelete; });

  const safeDuration = Math.max(1, Number.isFinite(duration) ? duration : 0);
  const totalWidth = Math.max(800, Math.ceil(safeDuration * PX_PER_SEC));

  const flatWords = useMemo<FlatWord[]>(() => {
    const out: FlatWord[] = [];
    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      const ws = Array.isArray(chunk.words) ? chunk.words : [];
      for (let wi = 0; wi < ws.length; wi++) {
        out.push({
          chunkIndex: ci,
          wordIndex: wi,
          word: ws[wi].word,
          start: ws[wi].start,
          end: ws[wi].end,
          forceBreak: !!ws[wi].forceBreak,
        });
      }
    }
    return out;
  }, [chunks]);

  const markerEvery = safeDuration > 240 ? 30 : safeDuration > 60 ? 10 : 5;
  const markers: number[] = [];
  for (let s = 0; s <= safeDuration; s += markerEvery) markers.push(s);

  useEffect(() => {
    function tick() {
      const t = typeof getCurrentTime === 'function' ? getCurrentTime() : 0;
      const x = (Number.isFinite(t) ? t : 0) * PX_PER_SEC;
      const ph = playheadRef.current;
      if (ph) ph.style.transform = `translateX(${x}px)`;
      const playing = typeof isPlaying === 'function' ? isPlaying() : false;
      const c = containerRef.current;
      if (playing && c) {
        const sinceUser = performance.now() - userScrolledAt.current;
        if (sinceUser > 1000) {
          const view = c.clientWidth;
          const target = x - view / 2;
          const max = c.scrollWidth - view;
          c.scrollLeft = Math.max(0, Math.min(max, target));
        }
      }
      syncScrollThumb();
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [getCurrentTime, isPlaying]);

  function pointerXToTime(e: PointerEvent): number {
    if (!trackRef.current) return 0;
    const rect = trackRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    return Math.max(0, x / PX_PER_SEC);
  }

  function clampForEdge(t: number, fw: FlatWord, edge: 'left' | 'right'): number {
    const chunk = chunks[fw.chunkIndex];
    const words = chunk.words;
    if (edge === 'left') {
      const minT = fw.wordIndex === 0 ? 0 : words[fw.wordIndex - 1].end;
      const maxT = words[fw.wordIndex].end - MIN_WORD_DURATION;
      return Math.max(minT, Math.min(maxT, t));
    }
    const minT = words[fw.wordIndex].start + MIN_WORD_DURATION;
    const maxT = fw.wordIndex === words.length - 1 ? safeDuration : words[fw.wordIndex + 1].start;
    return Math.max(minT, Math.min(maxT, t));
  }

  function commitCurrentEdit() {
    const input = editingInputRef.current;
    if (!input || !editingKey) return;
    const [ci, wi] = editingKey.split('-').map(Number);
    const newText = input.value.trim() || input.defaultValue;
    if (onWordTextChange) onWordTextChange(ci, wi, newText);
    setEditingKey(null);
    editingInputRef.current = null;
  }

  function onEdgePointerDown(e: React.PointerEvent, fw: FlatWord, edge: 'left' | 'right') {
    commitCurrentEdit();
    onDragStart?.();
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
    setDrag({ fw, edge, startClientX: e.clientX, startClientY: e.clientY });
  }

  function onBodyPointerDown(e: React.PointerEvent, fw: FlatWord) {
    if (editingKey === `${fw.chunkIndex}-${fw.wordIndex}`) return;
    commitCurrentEdit();
    onDragStart?.();
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
    const t0 = pointerXToTime(e.nativeEvent);
    setDrag({ fw, edge: 'body', t0, originalStart: fw.start, originalEnd: fw.end, startClientX: e.clientX, startClientY: e.clientY });
  }

  useEffect(() => {
    if (!drag) return;

    function onMove(e: PointerEvent) {
      if (!drag) return;
      const words = chunks[drag.fw.chunkIndex].words;
      let patch: Partial<Word> = {};
      let tooltipTime = 0;

      if (drag.edge === 'left' || drag.edge === 'right') {
        const t = pointerXToTime(e);
        const clamped = clampForEdge(t, drag.fw, drag.edge);
        patch = drag.edge === 'left' ? { start: clamped } : { end: clamped };
        tooltipTime = clamped;
      } else {
        const t = pointerXToTime(e);
        const delta = t - (drag.t0 ?? 0);
        const wordDur = (drag.originalEnd ?? 0) - (drag.originalStart ?? 0);
        const minStart = drag.fw.wordIndex === 0 ? 0 : words[drag.fw.wordIndex - 1].end;
        const maxEnd = drag.fw.wordIndex === words.length - 1 ? safeDuration : words[drag.fw.wordIndex + 1].start;
        let newStart = (drag.originalStart ?? 0) + delta;
        newStart = Math.max(minStart, Math.min(maxEnd - wordDur, newStart));
        patch = { start: newStart, end: newStart + wordDur };
        tooltipTime = newStart;
      }

      onWordTimingChange(drag.fw.chunkIndex, drag.fw.wordIndex, patch);
      const refTime = drag.edge === 'right' ? (patch.end ?? patch.start ?? 0) : (patch.start ?? 0);
      setTooltip({ time: tooltipTime, x: refTime * PX_PER_SEC });
    }

    function onUp(e: PointerEvent) {
      if (drag) {
        const movedX = Math.abs(e.clientX - drag.startClientX);
        const movedY = Math.abs(e.clientY - drag.startClientY);
        const threshold = e.pointerType === 'touch' ? 10 : CLICK_THRESHOLD_PX;
        const didTap = movedX < threshold && movedY < threshold;

        if (didTap) {
          const key = `${drag.fw.chunkIndex}-${drag.fw.wordIndex}`;
          if (e.pointerType === 'touch') {
            const now = Date.now();
            if (now - lastTapTimeRef.current < 400 && selectedKeyRef.current === key) {
              setEditingKey(key);
              setSelectedKey(null);
              selectedKeyRef.current = null;
            } else {
              setSelectedKey(key);
              selectedKeyRef.current = key;
            }
            lastTapTimeRef.current = now;
          } else if (drag.edge === 'body') {
            setSelectedKey(null);
            selectedKeyRef.current = null;
            setEditingKey(key);
          }
        } else {
          setSelectedKey(null);
          selectedKeyRef.current = null;
        }
      }
      setDrag(null);
      setTooltip(null);
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [drag, chunks, safeDuration, onWordTimingChange]);

  function syncScrollThumb() {
    const c = containerRef.current;
    const track = scrollTrackRef.current;
    const thumb = scrollThumbRef.current;
    if (!c || !track || !thumb) return;
    const trackW = track.clientWidth;
    if (trackW === 0 || c.scrollWidth === 0) return;
    const maxScroll = Math.max(0, c.scrollWidth - c.clientWidth);
    const thumbW = Math.max(28, (c.clientWidth / c.scrollWidth) * trackW);
    const thumbLeft = maxScroll > 0 ? (c.scrollLeft / maxScroll) * (trackW - thumbW) : 0;
    thumb.style.width = `${thumbW}px`;
    thumb.style.transform = `translateX(${thumbLeft}px)`;
    track.style.opacity = maxScroll > 4 ? '1' : '0';
  }

  function onScrollbarPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const c = containerRef.current;
    const track = scrollTrackRef.current;
    if (!c || !track) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
    const rect = track.getBoundingClientRect();
    const trackW = rect.width;
    const thumbW = Math.max(28, (c.clientWidth / Math.max(1, c.scrollWidth)) * trackW);
    const maxScroll = Math.max(0, c.scrollWidth - c.clientWidth);
    const clickX = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, (clickX - thumbW / 2) / Math.max(1, trackW - thumbW)));
    c.scrollLeft = ratio * maxScroll;
    userScrolledAt.current = performance.now();
    syncScrollThumb();
    scrollDragRef.current = { startX: e.clientX, startScrollLeft: c.scrollLeft };
  }

  function onScrollbarPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = scrollDragRef.current;
    if (!d || !(e.buttons & 1)) return;
    const c = containerRef.current;
    const track = scrollTrackRef.current;
    if (!c || !track) return;
    const trackW = track.clientWidth;
    const thumbW = Math.max(28, (c.clientWidth / Math.max(1, c.scrollWidth)) * trackW);
    const maxScroll = Math.max(0, c.scrollWidth - c.clientWidth);
    const deltaX = e.clientX - d.startX;
    const scrollDelta = (deltaX / Math.max(1, trackW - thumbW)) * maxScroll;
    c.scrollLeft = Math.max(0, Math.min(maxScroll, d.startScrollLeft + scrollDelta));
    userScrolledAt.current = performance.now();
    syncScrollThumb();
  }

  function onScrollbarPointerUp() { scrollDragRef.current = null; }
  function onContainerScroll() { userScrolledAt.current = performance.now(); syncScrollThumb(); }

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-[11px] font-extrabold uppercase tracking-[0.22em] text-[#D4AF37]">
          Timeline
        </span>
        <span className="text-[10px] text-white/40">
          drag to retime · tap to edit · {flatWords.length} word{flatWords.length === 1 ? '' : 's'}
        </span>
      </div>

      <div
        ref={containerRef}
        onScroll={onContainerScroll}
        className="relative overflow-x-auto overflow-y-hidden rounded-md bg-[#0c0c0c]"
        style={{ touchAction: 'pan-y' }}
      >
        <div
          ref={trackRef}
          className="relative select-none"
          style={{ width: `${totalWidth}px`, height: `${RULER_HEIGHT + TRACK_HEIGHT + 10}px` }}
        >
          {/* Ruler */}
          <div
            onPointerDown={(e) => {
              commitCurrentEdit();
              setSelectedKey(null);
              selectedKeyRef.current = null;
              if (!onSeek || !trackRef.current) return;
              const rect = trackRef.current.getBoundingClientRect();
              onSeek(Math.max(0, e.clientX - rect.left) / PX_PER_SEC);
            }}
            className="absolute inset-x-0 top-0 h-6 cursor-pointer border-b border-white/5"
          >
            {markers.map((m) => (
              <div key={m} className="pointer-events-none absolute top-0 h-full" style={{ left: `${m * PX_PER_SEC}px` }}>
                <div className="h-full w-px bg-white/10" />
                <span className="absolute left-1 top-0 font-mono text-[10px] text-white/40">{formatTimeShort(m)}</span>
              </div>
            ))}
          </div>

          {/* Word blocks */}
          <div className="absolute inset-x-0" style={{ top: `${RULER_HEIGHT + 6}px`, height: `${TRACK_HEIGHT}px` }}>
            {flatWords.map((fw) => {
              const left = fw.start * PX_PER_SEC;
              const width = Math.max(8, (fw.end - fw.start) * PX_PER_SEC);
              const handleW = Math.min(16, Math.max(6, Math.floor(width / 3)));
              const isActive = drag?.fw.chunkIndex === fw.chunkIndex && drag?.fw.wordIndex === fw.wordIndex;
              const isEditing = editingKey === `${fw.chunkIndex}-${fw.wordIndex}`;
              const isSelected = selectedKey === `${fw.chunkIndex}-${fw.wordIndex}`;
              const cls = [
                'group absolute top-0 flex h-full items-center rounded-sm transition-colors',
                isEditing  ? 'bg-[#92700B] ring-2 ring-[#D4AF37]' :
                isSelected ? 'bg-[#92700B] ring-2 ring-red-400/70 z-10' :
                isActive   ? 'bg-[#D4AF37] z-10 ring-2 ring-white/80' :
                             'bg-[#D4AF37] hover:bg-[#C4A21E]',
              ].join(' ');

              return (
                <div
                  key={`${fw.chunkIndex}-${fw.wordIndex}`}
                  onPointerDown={(e) => onBodyPointerDown(e, fw)}
                  className={cls}
                  style={{ left: `${left}px`, width: `${width}px`, cursor: isEditing ? 'text' : 'grab', touchAction: 'none' }}
                  title={isEditing ? 'Edit word' : `${fw.word} · ${formatTimeFull(fw.start)} → ${formatTimeFull(fw.end)}`}
                >
                  {!isEditing && (
                    <div onPointerDown={(e) => onEdgePointerDown(e, fw, 'left')} className="absolute left-0 top-0 h-full cursor-ew-resize bg-black/0 hover:bg-black/40" style={{ touchAction: 'none', width: `${handleW}px` }} />
                  )}

                  {isEditing ? (
                    <input
                      ref={(el) => { editingInputRef.current = el; }}
                      autoFocus
                      defaultValue={fw.word}
                      onBlur={(e) => { if (onWordTextChange) onWordTextChange(fw.chunkIndex, fw.wordIndex, e.target.value.trim() || fw.word); setEditingKey(null); }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { if (onWordTextChange) onWordTextChange(fw.chunkIndex, fw.wordIndex, e.currentTarget.value.trim() || fw.word); setEditingKey(null); e.preventDefault(); }
                        if (e.key === 'Escape') { setEditingKey(null); e.preventDefault(); }
                      }}
                      onClick={(e) => e.stopPropagation()}
                      onPointerDown={(e) => e.stopPropagation()}
                      className="w-full bg-transparent border-none outline-none text-center text-[11px] font-semibold uppercase tracking-wide text-black px-2 cursor-text"
                    />
                  ) : (
                    <span className="pointer-events-none mx-auto truncate px-2 text-[11px] font-semibold uppercase tracking-wide text-black">
                      {fw.word}
                    </span>
                  )}

                  {!isEditing && (
                    <div onPointerDown={(e) => onEdgePointerDown(e, fw, 'right')} className="absolute right-0 top-0 h-full cursor-ew-resize bg-black/0 hover:bg-black/40" style={{ touchAction: 'none', width: `${handleW}px` }} />
                  )}

                  {/* Mobile selected-state: large external handles */}
                  {isSelected && !isEditing && (
                    <>
                      <div onPointerDown={(e) => onEdgePointerDown(e, fw, 'left')} className="absolute top-1/2 -translate-y-1/2 z-20 flex items-center justify-center cursor-ew-resize" style={{ touchAction: 'none', width: '36px', height: '48px', left: '-18px' }}>
                        <div className="w-[3px] h-7 rounded-full bg-white shadow pointer-events-none" />
                      </div>
                      <div onPointerDown={(e) => onEdgePointerDown(e, fw, 'right')} className="absolute top-1/2 -translate-y-1/2 z-20 flex items-center justify-center cursor-ew-resize" style={{ touchAction: 'none', width: '36px', height: '48px', right: '-18px' }}>
                        <div className="w-[3px] h-7 rounded-full bg-white shadow pointer-events-none" />
                      </div>
                    </>
                  )}

                  {onWordDelete && (
                    <button
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); onWordDelete(fw.chunkIndex, fw.wordIndex); }}
                      className={`absolute -top-2 -right-2 z-30 flex w-4 h-4 items-center justify-center rounded-full bg-red-600 text-white text-[9px] font-bold leading-none ${isEditing || isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                    >×</button>
                  )}
                </div>
              );
            })}
          </div>

          {/* Playhead */}
          <div ref={playheadRef} className="pointer-events-none absolute top-0 z-20 h-full" style={{ willChange: 'transform' }}>
            <div className="absolute left-0 top-0 h-full w-px bg-white shadow-[0_0_8px_rgba(255,255,255,0.5)]" />
            <div
              onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); }}
              onPointerMove={(e) => { if (!(e.buttons & 1)) return; if (onSeek) onSeek(Math.max(0, Math.min(safeDuration, pointerXToTime(e.nativeEvent)))); }}
              className="absolute -left-3 top-0 h-6 w-6 -translate-y-2 rotate-45 bg-white cursor-ew-resize touch-none pointer-events-auto"
            />
          </div>

          {tooltip && (
            <div className="pointer-events-none absolute z-30 -translate-x-1/2 whitespace-nowrap rounded bg-black px-2 py-1 font-mono text-[10px] text-white shadow-lg" style={{ left: `${tooltip.x}px`, top: `${RULER_HEIGHT - 22}px` }}>
              {formatTimeFull(tooltip.time)}
            </div>
          )}
        </div>
      </div>

      {/* Scroll strip */}
      <div
        ref={scrollTrackRef}
        onPointerDown={onScrollbarPointerDown}
        onPointerMove={onScrollbarPointerMove}
        onPointerUp={onScrollbarPointerUp}
        onPointerCancel={onScrollbarPointerUp}
        onContextMenu={(e) => e.preventDefault()}
        className="relative mt-2 h-5 rounded-full bg-white/[0.05] overflow-hidden cursor-grab active:cursor-grabbing transition-opacity select-none"
        style={{ touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none' }}
      >
        <div ref={scrollThumbRef} className="absolute top-1 bottom-1 rounded-full bg-[#D4AF37]/50" style={{ width: '28px', willChange: 'transform' }} />
      </div>
    </div>
  );
}
