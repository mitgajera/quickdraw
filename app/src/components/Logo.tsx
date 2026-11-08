/** Quickdraw's mark: a price line rising to hit one box of the grid. Same drawing as app/icon.svg. */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="logomark">
      <rect x="1.5" y="1.5" width="29" height="29" rx="8.5" fill="none" stroke="currentColor" strokeWidth="2.4" />
      <rect x="17.5" y="7" width="7.5" height="7.5" rx="2" fill="currentColor" />
      <path d="M7.5 24 L12 18.5 L15 21 L19.5 15.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
