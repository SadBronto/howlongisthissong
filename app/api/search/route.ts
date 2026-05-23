import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { parseQuery } from '@/lib/queryParser';
import type { Track } from '@/lib/types';

// ±3 seconds tolerance for "exact" duration searches
const EXACT_TOLERANCE_MS = 3000;

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!
  );
}

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get('q') ?? '';

  if (!q.trim()) {
    return NextResponse.json({ tracks: [], total: 0 });
  }

  const parsed = parseQuery(q);

  // Nothing useful to search
  if (!parsed.keywords && !parsed.exactDuration && parsed.minDuration == null) {
    return NextResponse.json({ tracks: [], total: 0 });
  }

  const minDuration =
    parsed.exactDuration != null
      ? parsed.exactDuration - EXACT_TOLERANCE_MS
      : (parsed.minDuration ?? null);

  const maxDuration =
    parsed.exactDuration != null
      ? parsed.exactDuration + EXACT_TOLERANCE_MS
      : (parsed.maxDuration ?? null);

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

  // For exact duration searches, sort results by proximity to the target
  if (parsed.exactDuration != null) {
    const target = parsed.exactDuration;
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
