'use client';

import { useRef } from 'react';

interface SearchBarProps {
  value:    string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onClear:  () => void;
  loading?: boolean;
}

export default function SearchBar({ value, onChange, onSubmit, onClear, loading }: SearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div>
      <div className="flex items-center border-2 border-gray-200 rounded-2xl bg-white shadow-sm focus-within:border-blue-500 focus-within:shadow-md transition-all duration-150">
        <span className="pl-4 text-gray-400 flex-shrink-0">
          {loading ? (
            <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : (
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          )}
        </span>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onSubmit(); }}
          placeholder='Try "3:30.000", "love 4:20", ">10:00", "3:00 to 4:00"'
          className="flex-1 px-3 py-3.5 text-gray-900 placeholder-gray-400 bg-transparent outline-none text-base"
          autoFocus
          autoComplete="off"
          spellCheck={false}
        />
        {value && (
          <button
            onClick={() => { onClear(); inputRef.current?.focus(); }}
            className="px-2 text-gray-300 hover:text-gray-500 transition-colors flex-shrink-0"
            aria-label="Clear search"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
        <button
          onClick={onSubmit}
          className="mr-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white text-sm font-semibold rounded-xl transition-colors flex-shrink-0"
        >
          Search
        </button>
      </div>
      <p className="text-xs text-gray-400 mt-1.5 pl-1">
        Exact (3:16 or 3:16.423), range (3:00 to 4:00), open-ended (&gt;10:00), title, artist. Combine freely.
      </p>
    </div>
  );
}
