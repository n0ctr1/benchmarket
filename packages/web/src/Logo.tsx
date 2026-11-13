/** The mark: three bars in a frame, a benchmark read left to right. The last bar is the winner. */
export function LogoMark({ size = 26 }: { size?: number }) {
  return (
    <svg className="logo-mark" width={size} height={size} viewBox="0 0 26 26" aria-hidden="true">
      <rect x="1" y="1" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" />
      <rect x="5" y="15" width="4" height="6" fill="currentColor" />
      <rect x="11" y="10" width="4" height="11" fill="currentColor" />
      <rect x="17" y="5" width="4" height="16" fill="var(--acid)" />
    </svg>
  );
}
