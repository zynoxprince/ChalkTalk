export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
        <rect x="2" y="5" width="28" height="20" rx="4" fill="#fff" stroke="#1f2937" strokeWidth="2.2" />
        <path d="M7 19c3-6 5-8 7-8s1.5 5 4 5 3-4 6-6" fill="none" stroke="#4f46e5" strokeWidth="2.4" strokeLinecap="round" />
        <path d="M11 29l5-4 5 4" fill="none" stroke="#1f2937" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="font-hand text-[1.7rem] font-bold leading-none tracking-tight text-ink">ChalkTalk</span>
    </span>
  );
}
