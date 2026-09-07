// Otto - the workbench octopus mark.
export function Otto({ size = 22 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 40 40"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M11 20 Q11 9 20 9 Q29 9 29 20" />
      <path d="M11 20 q-3 7 -5 10" />
      <path d="M15.5 22 q-2 7 -4 11" />
      <path d="M20 23 q0 7 0 12" />
      <path d="M24.5 22 q2 7 4 11" />
      <path d="M29 20 q3 7 5 10" />
      <circle cx="16.5" cy="16.5" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="23.5" cy="16.5" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}
