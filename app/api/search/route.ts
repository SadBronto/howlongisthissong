import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { parseQuery, exactDurationRange } from '@/lib/queryParser';
import type { Track } from '@/lib/types';

const LOOSE_SECS = 5; // tolerance when loose=1

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!
  );
}

export async function GET(request: NextRequest) {
  const q     = request.nextUrl.searchParams.get('q') ?? '';
  const loose = request.nextUrl.searchParams.get('loose') === '1';

  if (!q.trim()) {
    return NextResponse.json({ tracks: [], total: 0 });
  }

  const parsed = parseQuery(q);

  if (!parsed.keywords && parsed.exactDuration == null && parsed.minDuration == null) {
    return NextResponse.json({ tracks: [], total: 0 });
  }

  // Duration bounds
  let minDuration: number | null = null;
  let maxDuration: number | null = null;

  if (parsed.exactDuration != null) {
    [minDuration, maxDuration] = exactDurationRange(parsed.exactDuration, loose ? LOOSE_SECS : 0);
  } else if (parsed.minDuration != null) {
    minDuration = parsed.minDuration;
    maxDuration = parsed.maxDuration ?? null;
  }

  const supabase = getServiceClient();

  const { data, error } = await supabase.rpc('search_tracks', {
    p_query:        parsed.keywords ?? null,
    p_min_duration: minDuration,
    p_max_duration: maxDuration,
    p_limit:        100,
    p_offset:       0,
  });

  if (error) {
    console.error('[search] Supabase error:', error.message);
    return NextResponse.json({ error: 'Search failed' }, { status: 500 });
  }

  let tracks: Track[] = data ?? [];

  // For exact duration: sort by proximity within the window
  if (parsed.exactDuration != null) {
    const target = parsed.exactDuration + 500; // midpoint of the display second
    tracks = tracks.sort(
      (a, b) =>
        Math.abs((a.duration_ms ?? 0) - target) -
        Math.abs((b.duration_ms ?? 0) - target)
    );
  }

  return NextResponse.json({
    tracks,
    total: tracks.length,
    parsed: {
      keywords:      parsed.keywords,
      exactDuration: parsed.exactDuration,
      minDuration:   parsed.minDuration,
      maxDuration:   parsed.maxDuration,
    },
  });
}
