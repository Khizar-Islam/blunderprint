// A thin arrow, drawn (not the "→" character, whose shape changes with the font that
// happens to have it). It steps to the right when its row (a `group`) is pointed at.
export function Arrow({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 12"
      width="24"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      aria-hidden="true"
      className={`shrink-0 transition-transform duration-200 group-hover:translate-x-1 motion-reduce:transition-none ${className}`}
    >
      <path d="M0 6h22.5M17.5 1l5 5-5 5" />
    </svg>
  );
}
