"use client";

import React, { useState, useRef, useEffect } from 'react';
import Image from 'next/image';
import SubtitleEditor, { FONTS, buildWordGroups, type SubtitleStyle } from './components/SubtitleEditor';




// Shortest silence worth cutting out. Below roughly a fifth of a second a gap is the
// pause inside a sentence rather than between two of them, and removing it makes
// speech sound clipped.
const SILENCE_MIN_GAP = 0.25;
// 0 keeps everything but the deepest silence, 1 cuts anything that is not clearly
// louder than the room. Mid-scale suits a phone recorded indoors.
const CUT_SENSITIVITY = 0.5;




// ── Silence detection ───────────────────────────────────────────────────────────
// Whisper is a transcription model. Its word timestamps are alignment estimates, not
// measurements of when sound starts and stops, and they are least reliable at exactly
// the boundaries a cut lands on. The decoded samples are already in memory here for
// the waveform, so measure the audio instead of asking a language model about it.

const FRAME_SEC = 0.01; // 10ms hop — fine enough to land a cut inside a consonant
const PAD_IN = 0.08;    // keep a breath before the first sound of a segment
const PAD_OUT = 0.12;   // and let the tail of the last word ring out

/** Speech/silence segmentation by adaptive energy gating.
 *
 *  The threshold is derived from the recording's own level distribution rather than
 *  fixed in advance: the quiet end of the distribution is this room's noise floor and
 *  the loud end is this person's voice, so a room with air conditioning in it lands on
 *  a different threshold than a treated one without anybody having to touch a dial.
 *
 *  Two thresholds, not one. Sound has to clear the higher one to open a segment and
 *  stay under the lower one to close it, so level wobbling across a single line cannot
 *  shred the audio into fragments. */
function detectSpeechSegments(
 channel: Float32Array,
 sampleRate: number,
 minSilence: number,
 sensitivity: number,
): { start: number; end: number | null }[] {
 const hop = Math.max(1, Math.round(sampleRate * FRAME_SEC));
 const win = hop * 2;
 const frameCount = Math.floor((channel.length - win) / hop);
 if (frameCount <= 2) return [{ start: 0, end: null }];

 const db = new Float32Array(frameCount);
 for (let i = 0; i < frameCount; i++) {
 let sum = 0;
 const off = i * hop;
 for (let j = 0; j < win; j++) {
 const s = channel[off + j];
 sum += s * s;
 }
 db[i] = 10 * Math.log10(sum / win + 1e-12);
 }

 const sorted = Float32Array.from(db).sort();
 const percentile = (p: number) =>
 sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))];
 const noiseFloor = percentile(0.10);
 const speechLevel = percentile(0.95);
 const range = Math.max(6, speechLevel - noiseFloor);

 const openAt = noiseFloor + range * (0.25 + 0.35 * sensitivity);
 const closeAt = noiseFloor + range * (0.15 + 0.25 * sensitivity);

 const minSilenceFrames = Math.max(1, Math.round(minSilence / FRAME_SEC));
 const minSegment = 0.12;

 const found: { start: number; end: number | null }[] = [];
 let inSpeech = false;
 let segStart = 0;
 let quietRun = 0;
 let loudRun = 0;

 for (let i = 0; i < frameCount; i++) {
 const t = i * FRAME_SEC;
 if (!inSpeech) {
 if (db[i] > openAt) {
 loudRun++;
 // Two frames above the line, so a single click or lip smack cannot open a segment
 if (loudRun >= 2) {
 inSpeech = true;
 segStart = Math.max(0, t - loudRun * FRAME_SEC - PAD_IN);
 quietRun = 0;
 }
 } else {
 loudRun = 0;
 }
 } else if (db[i] < closeAt) {
 quietRun++;
 if (quietRun >= minSilenceFrames) {
 const end = t - quietRun * FRAME_SEC + PAD_OUT;
 if (end - segStart >= minSegment) found.push({ start: segStart, end });
 inSpeech = false;
 loudRun = 0;
 quietRun = 0;
 }
 } else {
 quietRun = 0;
 }
 }
 if (inSpeech) found.push({ start: segStart, end: null });
 if (found.length === 0) return [{ start: 0, end: null }];

 // Padding can push two segments into each other; fold those back together
 const merged: { start: number; end: number | null }[] = [];
 for (const seg of found) {
 const prev = merged[merged.length - 1];
 if (prev && prev.end !== null && seg.start <= prev.end) prev.end = seg.end;
 else merged.push({ ...seg });
 }
 merged[merged.length - 1].end = null; // run the last segment to the end of the video
 return merged;
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
 // Silence detection, adjustable from the cut screen
 const [cutSensitivity, setCutSensitivity] = useState(CUT_SENSITIVITY);
 const [minSilence, setMinSilence] = useState(SILENCE_MIN_GAP);
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
 // Segment index the idle <video> is currently parked one step ahead of (-1 = nothing parked)
 const prerolledIdxRef = useRef(-1);
 // Time the idle element has genuinely finished seeking to, taken from its 'seeked'
 // event. Reading currentTime instead is unreliable on iOS — it reports the target
 // before the decoder has caught up, so a swap could hand over a frame that is not
 // ready and the picture hitches anyway.
 const parkedTimeRef = useRef<number | null>(null);
 // Decoded samples are kept so the sliders can re-cut instantly, without decoding
 // the audio again and without going near the network.
 const audioChannelRef = useRef<Float32Array | null>(null);
 const sampleRateRef = useRef(16000);
 const warmingUpRef = useRef(false);
 const seekBarRef = useRef<HTMLDivElement>(null);
 const seekDraggingRef = useRef(false);
 const cutDoneRef = useRef(false);
 const origVideoWidthRef = useRef(0);
 const origWidthCapturedRef = useRef(false);
 const hasAutoAnalyzed = useRef(false);

 const currentTimeRef = useRef(0);
 const cutHistoryRef = useRef<any[][]>([]);



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
 // Deleting or dragging a segment shifts every index, so the parked element is stale
 useEffect(() => { segmentsRef.current = segments; prerolledIdxRef.current = -1; }, [segments]);
 useEffect(() => { durationRef.current = duration; }, [duration]);
 // The cut-review videos unmount when the subtitle editor takes over, so their
 // onPause never fires and nothing else ever stopped this loop — it kept asking for
 // frames just to return early on every one of them. Stop it at the transition.
 useEffect(() => { cutDoneRef.current = cutDone; if (cutDone) stopLoop(); }, [cutDone]);


 // ── Cleanup RAF ──
 useEffect(() => () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); }, []);
 useEffect(() => { if (window.innerWidth < 768) setZoom(8); }, []);

 // ── Phase 1: Timeline auto-scroll ──
 useEffect(() => {
 if (cutDone) return; // Don't auto-scroll in Phase 2
 const c = timelineContainerRef.current;
 if (!c || zoom <= 1 || !duration) return;
 const cw = c.clientWidth;
 const ph = (currentTime / (duration || 1)) * cw * zoom;
 if (ph < c.scrollLeft + 40 || ph > c.scrollLeft + cw - 40)
 c.scrollLeft = Math.max(0, ph - cw * 0.25);
 }, [currentTime, zoom, duration, cutDone]);

 // Playback state readout — add ?debug=1 to the URL. Every condition that can stop
 // the segment loop lives in a ref, so none of it appears in React DevTools or in
 // any number measured so far. Sampling them onto the screen says which one is up.
 const [dbg, setDbg] = useState<string | null>(null);
 useEffect(() => {
 if (!new URLSearchParams(window.location.search).has('debug')) return;
 const id = setInterval(() => {
 const v = activeIsARef.current ? videoARef.current : videoBRef.current;
 const segs = segmentsRef.current;
 setDbg(
 `loop ${rafRef.current !== null ? 'ON' : 'off'} \u00b7 segs ${segs?.length ?? 0}` +
 `${segs?.[0] ? ` \u00b7 first ${segs[0].start.toFixed(2)}s` : ''}\n` +
 `video ${v ? (v.paused ? 'paused' : 'PLAYING') : 'none'} \u00b7 t ${(v?.currentTime ?? 0).toFixed(2)}` +
 ` \u00b7 ready ${v?.readyState ?? '-'}\n` +
 `warmup ${warmingUpRef.current ? 'YES' : 'no'} \u00b7 drag ${draggingRef.current ? 'YES' : 'no'}` +
 ` \u00b7 seek ${seekDraggingRef.current ? 'YES' : 'no'}`
 );
 }, 250);
 return () => clearInterval(id);
 }, []);

 // ── Phase 1: Video playback helpers ──
 const getAV = () => activeIsARef.current ? videoARef.current : videoBRef.current;
 const getBV = () => activeIsARef.current ? videoBRef.current : videoARef.current;

 const stopLoop = () => {
 if (rafRef.current !== null) {
 cancelAnimationFrame(rafRef.current);
 rafRef.current = null;
 }
 };

 /** Seek the visible element and wait for it to settle. Every frame between the
  * request and the 'seeked' event is a frozen picture — this is the stutter, and
  * it is now only the fallback path. */
 const seekActiveTo = (target: number) => {
 const v = getAV();
 if (!v) return;
 programmaticSeekRef.current = true;
 v.currentTime = target;
 const done = () => { startLoop(); };
 const fallback = setTimeout(done, 800);
 v.addEventListener('seeked', () => { clearTimeout(fallback); done(); }, { once: true });
 };

 /** Park the idle element on a segment's first frame while the other one plays.
  * The decode happens off-screen, so the later hand-off costs nothing visible. */
 const prerollTo = (time: number) => {
 const bv = getBV();
 if (!bv) return;
 if (!bv.paused) bv.pause();
 parkedTimeRef.current = null;
 if (bv.readyState >= 2 && Math.abs(bv.currentTime - time) < 0.02) {
 parkedTimeRef.current = time;
 return;
 }
 bv.addEventListener('seeked', () => { parkedTimeRef.current = time; }, { once: true });
 bv.currentTime = time;
 };

 /** Hand playback to the idle element, already sitting on this segment's start:
  * flip which one is visible instead of seeking. Falls back to seekActiveTo
  * whenever the idle element isn't parked yet or autoplay refuses the handover,
  * so the worst case is exactly the old behaviour. */
 const swapToSegment = (segIdx: number, segs: { start: number; end: number | null }[]) => {
 const seg = segs[segIdx];
 const cur = getAV();
 const nxt = getBV();
 const parked = !!nxt && nxt.readyState >= 2 && parkedTimeRef.current !== null
 && Math.abs(parkedTimeRef.current - seg.start) < 0.02;

 if (!cur || !nxt || !parked) { seekActiveTo(seg.start); return; }

 activeIsARef.current = !activeIsARef.current;
 setActiveIsA(activeIsARef.current);
 prerolledIdxRef.current = segIdx;

 nxt.play().then(() => {
 cur.pause();
 const following = segs[segIdx + 1];
 if (following) prerollTo(following.start);
 startLoop();
 }).catch(() => {
 activeIsARef.current = !activeIsARef.current;
 setActiveIsA(activeIsARef.current);
 seekActiveTo(seg.start);
 });
 };

 const startLoop = () => {
 stopLoop();
 const tick = () => {
 if (cutDoneRef.current) { rafRef.current = null; return; }
 const v = getAV();
 const segs = segmentsRef.current;
 const dur = durationRef.current;
 if (!v || !segs || v.paused || draggingRef.current || seekDraggingRef.current || warmingUpRef.current) { rafRef.current = null; return; }
 const t = v.currentTime;
 const inSeg = segs.find(s => t >= s.start - 0.1 && t <= (s.end ?? dur));

 if (!inSeg) {
 const next = segs.filter(s => s.start > t).sort((a, b) => a.start - b.start)[0];
 if (next) seekActiveTo(next.start); else v.pause();
 rafRef.current = null; return;
 }

 const idx = segs.indexOf(inSeg);

 // Keep the idle element one segment ahead of wherever playback currently is
 if (prerolledIdxRef.current !== idx) {
 prerolledIdxRef.current = idx;
 const next = segs[idx + 1];
 if (next) prerollTo(next.start);
 }

 if (inSeg.end !== null && t >= inSeg.end - 0.08) {
 if (segs[idx + 1]) swapToSegment(idx + 1, segs); else v.pause();
 rafRef.current = null; return;
 }

 rafRef.current = requestAnimationFrame(tick);
 };
 rafRef.current = requestAnimationFrame(tick);
 };

 useEffect(() => {
 // The playback loop exits while either drag flag is up, and both were only ever
 // lowered by an element's own pointerup. Touch does not reliably end that way —
 // Safari sends pointercancel whenever it decides a touch was really a scroll — and
 // a flag left up stops the loop for the rest of the session, which looks like
 // playback ignoring the segments entirely. Lower them on any pointer release,
 // wherever it lands.
 const releaseDrags = () => {
 const wasDragging = draggingRef.current !== null || seekDraggingRef.current;
 draggingRef.current = null;
 seekDraggingRef.current = false;
 if (!wasDragging) return;
 const av = getAV();
 if (av && !av.paused) startLoop();
 };
 window.addEventListener('pointerup', releaseDrags);
 window.addEventListener('pointercancel', releaseDrags);
 return () => {
 window.removeEventListener('pointerup', releaseDrags);
 window.removeEventListener('pointercancel', releaseDrags);
 };
 }, []);

 const handleTimeUpdate = () => {
 const av = getAV();
 if (av) setCurrentTime(av.currentTime);
 };




 // Global Keydown Handler (Spacebar + Undo)
 useEffect(() => {
 const handleKey = (e: KeyboardEvent) => {
 const target = e.target as HTMLElement;
 if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;

 // The subtitle editor binds its own keys once it takes over
 if (cutDoneRef.current) return;

 if (e.key === ' ') {
 e.preventDefault(); // Stop scrolling or pressing focused buttons
 const av = activeIsARef.current ? videoARef.current : videoBRef.current;
 if (av) av.paused ? av.play() : av.pause();
 return;
 }

 if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
 e.preventDefault();
 const h = cutHistoryRef.current;
 if (h.length > 0) {
 const prev = h.pop();
 setSegments(prev ?? null);
 setCanUndoCut(h.length > 0);
 }
 }
 };
 window.addEventListener('keydown', handleKey);
 return () => window.removeEventListener('keydown', handleKey);
 }, []);


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
 prerolledIdxRef.current = -1;
 cutHistoryRef.current = [];
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
 // Safari can return a play() promise that never settles when the element has had
 // no user gesture of its own, so every await here is raced against a timeout. A
 // hang would otherwise leave warmingUp set, and the playback loop bails while that
 // flag is up — which reads as the video ignoring the segments entirely.
 const withTimeout = (p: Promise<unknown>, ms: number) =>
 Promise.race([p.catch(() => {}), new Promise<void>(r => setTimeout(r, ms))]);

 const idle = videoBRef.current;
 warmingUpRef.current = true;
 try {
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
 await withTimeout(video.play(), 800);
 await new Promise<void>(r => setTimeout(r, 700));
 video.pause();
 }
 video.muted = false;

 // Unlock the second element for programmatic playback. Browsers only allow
 // play() on an element that has already played once, and the hand-off between
 // segments calls play() with no user gesture of its own. If the browser refuses,
 // swapToSegment falls back to seeking in place, so this is worth trying and not
 // worth waiting on.
 if (idle) {
 idle.muted = true;
 await withTimeout(idle.play(), 600);
 try { idle.pause(); } catch { /* never started */ }
 idle.muted = false;
 }
 } finally {
 // Whatever happened above, playback must not be left gated behind this flag
 warmingUpRef.current = false;
 }

 prerolledIdxRef.current = -1;
 video.currentTime = segs[0].start;
 // Park the idle element on segment 2 so the very first hand-off is instant too
 if (idle && segs[1]) idle.currentTime = segs[1].start;
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

 // One decode feeds both the waveform and the cut detection. No network, so the
 // cuts are ready before the preview has finished encoding.
 setStatus("Listening for silence...");
 let detected: { start: number; end: number | null }[] | null = null;
 try {
 const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
 const actx = new AudioCtx();
 const decoded = await actx.decodeAudioData(audioRawBuffer.slice());
 actx.close();
 const ch = decoded.getChannelData(0);

 audioChannelRef.current = ch;
 sampleRateRef.current = decoded.sampleRate;
 detected = detectSpeechSegments(ch, decoded.sampleRate, minSilence, cutSensitivity);

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
 } catch { /* fall back to one uncut segment below */ }

 setStatus("Creating preview...");
 // -g 5: a seek has to decode forward from the previous keyframe, so the gap between
 // keyframes is the cost of every jump between segments. Five frames instead of
 // fifteen makes that roughly three times cheaper, at the price of a bigger preview
 // file that never leaves the browser anyway.
 await ffmpeg.exec(['-i', 'input.mov', '-vf', 'scale=-2:360', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-g', '5', '-keyint_min', '5', '-c:a', 'copy', 'preview.mp4']);
 const previewData = await ffmpeg.readFile('preview.mp4');
 setVideoUrl(URL.createObjectURL(new Blob([(previewData as any).buffer], { type: 'video/mp4' })));

 const segs = detected ?? [{ start: 0, end: null }];
 setSegments(segs);

 setStatus("Preparing edit...");
 setProgress(0);
 await warmupSegments(segs);
 setStatus("Review Edit");
 } catch {
 setStatus("Error");
 } finally {
 setProcessing(false);
 }
 };

 // Re-cut as the sliders move. Detection is pure arithmetic over samples already in
 // memory, so this lands in the same frame the slider does.
 useEffect(() => {
 const ch = audioChannelRef.current;
 if (!ch || cutDone) return;
 setSegments(detectSpeechSegments(ch, sampleRateRef.current, minSilence, cutSensitivity));
 cutHistoryRef.current = [];
 setCanUndoCut(false);
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [cutSensitivity, minSilence]);

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
 // Without this the encoder defaults to a keyframe every 250 frames, which makes
 // scrubbing the subtitle editor's seek bar decode up to eight seconds of video
 // for a single frame.
 '-g', '5', '-keyint_min', '5',
 'cut_preview.mp4',
 ]);

 const cutData = await ffmpegRef.current.readFile('cut_preview.mp4');
 const cutUrl = URL.createObjectURL(new Blob([(cutData as any).buffer], { type: 'video/mp4' }));

 // Ask Whisper about the video that now exists, rather than calculating what it
 // would probably have said. Arithmetic remapping only ever approximated this: it
 // squashes any word that straddles a cut, and leaves every word ending where the
 // silence used to begin, which is what makes these blocks so much narrower than
 // the ones in reels-dubber. Transcribing the cut audio puts this editor in exactly
 // the state reels-dubber is in — a real file, and timings straight from Whisper.
 let words: typeof subtitleWords | null = null;
 try {
 setStatus("Re-reading the cut...");
 setProgress(0);
 await ffmpegRef.current.exec(['-y', '-i', 'cut_preview.mp4', '-vn', '-ar', '16000', '-ac', '1', 'cut_audio.mp3']);
 const cutAudio = await ffmpegRef.current.readFile('cut_audio.mp3');
 const form = new FormData();
 form.append('video', new Blob([(cutAudio as any).buffer], { type: 'audio/mpeg' }), 'audio.mp3');
 const res = await fetch('/api/whisper', { method: 'POST', body: form });
 if (res.ok) {
 const data = await res.json();
 if (Array.isArray(data.words) && data.words.length > 0) words = data.words;
 }
 await ffmpegRef.current.deleteFile('cut_audio.mp3').catch(() => {});
 } catch {
 // Fall through to the remap below — a failed transcription must not cost the cut
 }

 // Fallback, and the behaviour every previous build shipped: map the existing
 // timings onto the cut timeline. Lenient about what survives — any overlap at all
 // keeps the word, since half a word is still audible. Only words that fall
 // entirely inside a removed stretch are dropped, because their audio is gone.
 if (!words) {
 const survivesCut = (w: { start: number; end: number }) =>
 segments.some(s => w.end > s.start && w.start < (s.end ?? duration));
 words = subtitleWords.filter(survivesCut).map(w => ({
 ...w,
 start: Number(remapToExportTime(w.start, segments, duration).toFixed(3)),
 end: Number(Math.max(
 remapToExportTime(w.start, segments, duration) + 0.05,
 remapToExportTime(w.end, segments, duration)
 ).toFixed(3)),
 }));
 }

 setVideoUrl(cutUrl);
 setSubtitleWords(words);
 setCutDone(true);
 setPaused(true);
 currentTimeRef.current = 0;
 cutHistoryRef.current = [];
 setCanUndoCut(false);
 setStatus("Edit Subtitles");
 } catch {
 setStatus("Error");
 } finally {
 setProcessing(false);
 }
 };


 // ── Phase 2: Export (with grouped subtitles) ──
 const renderVideo = async (style?: SubtitleStyle) => {
 if (!videoFile || !segments) return;
 setIsExporting(true);
 setExportProgress(0);
 setStatus("Rendering 1080p Master...");
 try {
 const { fetchFile } = await import('@ffmpeg/util');
 await ffmpegRef.current.writeFile('input.mov', await fetchFile(videoFile));

 const withSubtitles = !!style && style.words.length > 0;

 if (withSubtitles) {
 setStatus("Loading font...");
 const selectedFont = FONTS.find(f => f.id === style!.fontFamily) ?? FONTS[0];
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
 const groups = buildWordGroups(style!.words, style!.wordsPerLine);
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

 const baseSize = (style!.enablePump ? [28, 42, 58][groupIndex % 3] : 42) * style!.fontScale;
 const fontSize = Math.round(baseSize * scaleRatio);

 const rs = cutDone ? group[0].start : remapToExportTime(group[0].start, segments, duration);
 let re = cutDone ? Math.max(group[0].start + 0.08, group[group.length - 1].end) : Math.max(rs + 0.08, remapToExportTime(group[group.length - 1].end, segments, duration));

 // Prevent overlap with next group
 const nextGroup = groups[groupIndex + 1];
 if (nextGroup) {
 const nextStart = cutDone ? nextGroup[0].start : remapToExportTime(nextGroup[0].start, segments, duration);
 if (re > nextStart) re = Math.max(rs + 0.05, nextStart - 0.01);
 }

 const yPos = `h-(h*${style!.subtitlePos}/100)-text_h`;
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


 // ═══════════════════════════════════════════════════════
 // ██ R E N D E R
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
 <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full bg-white/[0.02] border border-white/5 rounded-xl py-3 px-4 text-white text-center tracking-[0.4em] text-[9px] focus:outline-none placeholder:text-[9px]" placeholder="ACCESS KEY" />
 <button type="submit" className="w-full py-3 bg-[#D4AF37] text-black rounded-xl uppercase tracking-[0.3em] text-[8px] font-black">Enter</button>
 </form>
 </main>

 </div>
 );
 }

 // ── Phase 1 derived values ──
 const currentSegIdx = segments ? segments.findIndex(s => currentTime >= s.start && currentTime <= (s.end ?? duration)) : -1;
 const previewZoom = zoomPerCut && currentSegIdx >= 0 ? getSegmentZoom(currentSegIdx, zoomFreq) : 1.0;

 // ═══════════════════════════════════════════════════════════════════
 // ██ PHASE 2: SUBTITLE EDITOR (Dubber-style canvas UI)
 // ═══════════════════════════════════════════════════════════════════
 if (cutDone && videoUrl) {
 return (
 <SubtitleEditor
 videoUrl={videoUrl}
 initialWords={subtitleWords}
 isExporting={isExporting}
 exportProgress={exportProgress}
 onExport={renderVideo}
 />
 );
 }

 // ═══════════════════════════════════════════════════════════════════
 // ██ PHASE 1: CUT MODE (original cutting UI, no subtitle buttons)
 // ═══════════════════════════════════════════════════════════════════
 return (
 <div className="min-h-[100dvh] text-white flex flex-col items-center overflow-y-auto overflow-x-hidden ">
 {dbg && (
 <pre style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999, margin: 0, background: 'rgba(0,0,0,0.88)', color: '#0f0', font: '600 12px/1.45 ui-monospace, monospace', padding: '6px 8px', textAlign: 'left', direction: 'ltr', whiteSpace: 'pre-wrap' }}>{dbg}</pre>
 )}
 <header className="w-full relative z-20 flex flex-col items-center shrink-0 mt-8 mb-6">
 <img src="/logo.png" alt="deVee" className="w-[100px] h-[100px] mb-2 object-contain" />
 <h1 className="text-[10px] font-bold tracking-[0.5em] uppercase text-white/60">REELS CUTTER</h1>
 </header>

 <main className="w-full max-w-2xl mx-auto flex flex-col items-center flex-1 justify-center px-4 md:px-6 space-y-4 md:space-y-6 py-6">
 <div className="w-full space-y-4 md:space-y-6">
 <div className="w-full space-y-4 md:space-y-6">
 {videoUrl ? (
 <div className="w-full space-y-4 md:space-y-6">

 {/* ── Video preview ── */}
 <div
 className="relative w-full h-[45vh] md:h-auto md:aspect-video bg-[#0c0c0c] border border-white/[0.03] rounded-[24px] md:rounded-[32px] overflow-hidden shadow-2xl flex items-center justify-center cursor-pointer"
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
 className="absolute inset-0 w-full h-full object-contain pointer-events-none"
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
 className="absolute inset-0 w-full h-full object-contain pointer-events-none"
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

 {/* ── Bottom panel — CUT MODE only ──
 Rendered before an upload too, with an empty timeline. The controls a user is
 about to reach for should already be on screen, not appear once the analysis
 finishes — which is how reels-motion and reels-dubber both behave. */}
 </div>
 ) : (
 <div className="relative w-full h-[40vh] md:h-auto md:aspect-video bg-[#0c0c0c] border border-white/[0.03] rounded-[24px] md:rounded-[32px] overflow-hidden shadow-2xl flex items-center justify-center">
 <label className="h-48 md:h-64 w-full flex flex-col items-center justify-center cursor-pointer space-y-4">
 <div className="w-12 h-12 rounded-full border border-white/10 flex items-center justify-center mx-auto text-white/20 text-xl">+</div>
 <p className="text-[8px] uppercase tracking-[0.4em] text-white/20 font-bold">Upload Media</p>
 <input type="file" className="hidden" onChange={handleFileUpload} accept="video/*" />
 </label>
 </div>
 )}

 {!zoomMode && (
 <div className="flex flex-col bg-[#0c0c0c] border border-white/[0.03] rounded-[24px] p-4 md:p-6 shadow-inner gap-4 md:gap-6 w-full mb-6">
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
 {(segments ?? []).map((seg, i) => (
 <button key={`del-${i}`} className="absolute top-1 -translate-x-1/2 flex items-center justify-center w-6 h-6 text-red-500 hover:text-red-400 text-[14px] font-black leading-none z-20 transition-colors" style={{ left: `${(((seg.start + (seg.end ?? duration)) / 2) / duration) * 100}%` }} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); if (segments) { cutHistoryRef.current.push([...segments]); setCanUndoCut(true); } setSegments(prev => prev ? prev.filter((_, idx) => idx !== i) : prev); }}>×</button>
 ))}
 </div>
 <div ref={timelineRef} className="relative h-20 md:h-14 bg-white/[0.03] border border-white/10 rounded-xl" style={{ width: `${zoom * 100}%`, minWidth: '100%', touchAction: zoom > 1 ? 'pan-x' : 'none' }}>
 {waveformBg && (
 <div className="absolute inset-0 rounded-xl pointer-events-none overflow-hidden" style={{ backgroundImage: `url(${waveformBg})`, backgroundSize: '100% 100%', opacity: 0.2 }} />
 )}
 {(segments ?? []).map((seg, i) => (
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
 <div className="absolute top-0 bottom-0 w-[1px] bg-red-500 z-50 pointer-events-none" style={{ left: `${(currentTime / (duration || 1)) * 100}%` }}>
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
 <div className="absolute left-0 top-0 h-full bg-[#D4AF37]/50 rounded-full" style={{ width: `${(currentTime / (duration || 1)) * 100}%` }} />
 </div>
 <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-5 h-5 md:w-3 md:h-3 rounded-full bg-[#D4AF37] shadow-[0_0_8px_rgba(212,175,55,0.45)] cursor-grab active:cursor-grabbing pointer-events-auto" style={{ left: `${(currentTime / (duration || 1)) * 100}%` }}
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
 {segments && segments.length > 0 && (
 <button onClick={finishCutting} disabled={processing} className="px-5 py-1.5 text-[8px] uppercase tracking-widest rounded-lg border bg-[#D4AF37]/20 border-[#D4AF37]/50 text-[#D4AF37] hover:bg-[#D4AF37]/30 transition-colors">Done Cutting →</button>
 )}
 </div>
 </div>
 )}

 {/* ── ZOOM MODE ── */}
 {segments && zoomMode && (
 <div className="flex flex-col bg-[#0c0c0c] border border-white/[0.03] rounded-[24px] p-4 md:p-6 shadow-inner gap-4 md:gap-6 w-full mb-6">
 {/* Seek bar */}
 <div className="relative w-full h-10 md:h-6 flex items-center cursor-pointer" style={{ touchAction: 'none' }}
 onClick={(e) => { const av = getAV(); if (!av) return; const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect(); av.currentTime = Math.max(0, Math.min((e.clientX - rect.left) / rect.width, 1)) * duration; }}
 >
 <div className="relative w-full h-[3px] bg-white/[0.08] rounded-full pointer-events-none">
 <div className="absolute left-0 top-0 h-full bg-[#D4AF37]/50 rounded-full" style={{ width: `${(currentTime / (duration || 1)) * 100}%` }} />
 </div>
 <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-5 h-5 md:w-3 md:h-3 rounded-full bg-[#D4AF37] shadow-[0_0_8px_rgba(212,175,55,0.45)] cursor-grab active:cursor-grabbing pointer-events-auto" style={{ left: `${(currentTime / (duration || 1)) * 100}%` }}
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

 {/* Appears once a file is chosen and stays through the analysis, so the setting is
 adjustable while the tool works. Held back on the empty screen, where there is
 nothing yet for it to apply to. */}
 {videoFile && !segments && (
 <>
 {/* Auto Zoom Settings */}
 <div className="flex items-center gap-3 bg-white/[0.02] border border-white/5 rounded-2xl px-4 py-3">
 <span className="text-[7px] uppercase tracking-[0.3em] text-white/30 font-bold shrink-0 select-none w-16">Auto Zoom</span>
 <div className="flex-1 flex items-center gap-2">
 <button onClick={() => setZoomPerCut(p => !p)} className={`px-4 py-1.5 text-[8px] uppercase tracking-widest rounded-lg border transition-colors ${zoomPerCut ? 'bg-[#D4AF37]/20 border-[#D4AF37]/50 text-[#D4AF37]' : 'bg-white/[0.04] border-white/[0.07] text-white/30 hover:text-white/50'}`}>
 {zoomPerCut ? 'ON' : 'OFF'}
 </button>
 {zoomPerCut && (
 <>
 <button onClick={() => setZoomFreq(1)} className={`px-4 py-1.5 text-[8px] uppercase tracking-widest rounded-lg border transition-colors ${zoomFreq === 1 ? 'bg-[#D4AF37]/20 border-[#D4AF37]/50 text-[#D4AF37]' : 'bg-white/[0.04] border-white/[0.07] text-white/30 hover:text-white/50'}`}>Fast</button>
 <button onClick={() => setZoomFreq(4)} className={`px-4 py-1.5 text-[8px] uppercase tracking-widest rounded-lg border transition-colors ${zoomFreq === 4 ? 'bg-[#D4AF37]/20 border-[#D4AF37]/50 text-[#D4AF37]' : 'bg-white/[0.04] border-white/[0.07] text-white/30 hover:text-white/50'}`}>Subtle</button>
 </>
 )}
 </div>
 </div>
 </>
 )}
 </div>
 </div>
 </main>

 </div>
 );
}

