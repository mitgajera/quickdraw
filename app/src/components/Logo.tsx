/** Quickdraw's mark: a price line rising into a grid box. Same drawing as app/icon.svg. */
export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="logomark">
      <rect width="32" height="32" rx="7" fill="var(--accent)" />
      <rect x="19" y="5" width="9" height="9" rx="1.8" fill="var(--bg)" />
      <path d="M5 25 L11 18 L15.5 21 L21 13.5" fill="none" stroke="var(--bg)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
