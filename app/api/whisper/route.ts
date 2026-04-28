import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  // בדיקת cookie
  const cookie = req.cookies.get('session_access');
  if (cookie?.value !== 'granted') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const formData = await req.formData();
  const audioFile = formData.get('video') as File;
  if (!audioFile) return NextResponse.json({ error: 'Missing audio' }, { status: 400 });

  try {
    const whisperForm = new FormData();
    whisperForm.append('file', audioFile, 'audio.mp3');
    whisperForm.append('model', 'whisper-1');
    whisperForm.append('response_format', 'verbose_json');
    whisperForm.append('timestamp_granularities[]', 'word');

    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: whisperForm,
    });

    if (!whisperRes.ok) {
      const err = await whisperRes.text();
      throw new Error(`Whisper error: ${err}`);
    }

    const whisperData = await whisperRes.json();
    const words: { word: string; start: number; end: number }[] = whisperData.words ?? [];

    // ─── DEBUG ───────────────────────────────────────────────
    console.log('=== WHISPER DEBUG ===');
    console.log('Total words:', words.length);
    console.log('Duration:', whisperData.duration);
    words.forEach((w, i) => {
      const gap = i > 0 ? (w.start - words[i - 1].end).toFixed(2) : '0';
      console.log(`[${i}] "${w.word}" ${w.start.toFixed(2)}s → ${w.end.toFixed(2)}s | gap before: ${gap}s`);
    });
    // ─────────────────────────────────────────────────────────

    const segments = buildSpeechSegments(words, 0.4);

    console.log('=== SEGMENTS ===');
    segments.forEach((s, i) => {
      console.log(`[${i}] start: ${s.start.toFixed(2)}s end: ${s.end !== null ? s.end.toFixed(2) + 's' : 'END'}`);
    });

    return NextResponse.json({ segments });

  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

function buildSpeechSegments(
  words: { start: number; end: number }[],
  threshold: number
): { start: number; end: number | null }[] {
  if (words.length === 0) return [{ start: 0, end: null }];

  // תיקון: end של מילה לא יכול להיות יותר מ-1 שניה אחרי ה-start שלה
  const MAX_WORD_DURATION = 1.0;
  const fixed = words.map((w, i) => {
    const nextStart = i < words.length - 1 ? words[i + 1].start : null;
    const maxEnd = nextStart !== null
      ? Math.min(w.start + MAX_WORD_DURATION, nextStart)
      : w.start + MAX_WORD_DURATION;
    return { start: w.start, end: Math.min(w.end, maxEnd) };
  });

  const segments: { start: number; end: number | null }[] = [];
  let segStart = fixed[0].start;
  let segEnd = fixed[0].end;

  for (let i = 1; i < fixed.length; i++) {
    const gap = fixed[i].start - segEnd;
    if (gap >= threshold) {
      segments.push({ start: segStart, end: segEnd });
      segStart = fixed[i].start;
    }
    segEnd = fixed[i].end;
  }
  segments.push({ start: segStart, end: null });

  return segments;
}

export const maxDuration = 60;
