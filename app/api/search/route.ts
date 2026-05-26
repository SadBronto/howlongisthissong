import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { parseQuery, exactDurationRange } from '@/lib/queryParser';
import type { Track } from '@/lib/types';

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!
  );
}

export async function GET(request: NextRequest) {
  const q         = request.nextUrl.searchParams.get('q') ?? '';
  const tolerance = parseInt(request.nextUrl.searchParams.get('tolerance') ?? '0', 10) || 0;

  if (!q.trim()) return NextResponse.json({ tracks: [], total: 0 });

  const parsed = parseQuery(q);
  if (!parsed.keywords && parsed.exactDuration == null && parsed.minDuration == null) {
    return NextResponse.json({ tracks: [], total: 0 });
  }

  let minDuration: number | null = null;
  let maxDuration: number | null = null;

  if (parsed.exactDuration != null) {
    [minDuration, maxDuration] = exactDurationRange(parsed.exactDuration, tolerance / 1000);
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

  const tracks: Track[] = data ?? [];

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
