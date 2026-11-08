/** Quickdraw's mark: a price pulse that shoots up and away. Same drawing as app/icon.svg. */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="logomark">
      <path d="M2.5 20.5 H7.5 L11 12.5 L15 25 L27 8" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M19.5 7.5 H27.5 V15.5" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
