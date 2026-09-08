// Otto - the workbench octopus, and the lowercase m that starts modSUTD.
//
// Five arms, splaying outward from a bulb mantle, eyes low and wide on it.
// Every one of those is load-bearing against the same failure: three arms
// hanging straight down from a dome, with eyes high and central, is a ghost.
// Arms that spread and eyes that sit at the widest part of the head are what
// make it an animal instead.
//
// Each arm is a chain that thins as it curls, which is why the tips are
// separate paths rather than one stroke - a constant-width leg reads as drapery.
//
// `weight` scales the whole chain. It exists because the mark sets beside
// 900-weight display type in the wordmark, where a single fixed line reads as a
// hairline. frontend/public/favicon.svg carries the same drawing without the
// tapers: at 16px they close up into blobs and cost more than they give.
export function Otto({ size = 22, weight = 3.3 }: { size?: number; weight?: number }) {
  const w = (k: number) => weight * k;
  return (
    <svg
      viewBox="0 0 40 40"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M6.6 17.2C6.6 9.4 12.4 4.6 20 4.6C27.6 4.6 33.4 9.4 33.4 17.2" strokeWidth={w(1)} />

      <path d="M6.6 17.2C4.4 22.0 1.9 26.4 2.2 29.6C2.5 32.4 5.0 33.2 6.4 31.6" strokeWidth={w(0.9)} />
      <path d="M5.8 32.4C7.1 31.8 7.8 30.7 7.7 29.4" strokeWidth={w(0.58)} />

      <path d="M12.6 20.6C11.6 26.0 10.4 30.4 11.6 33.6C12.4 35.8 15.0 36.0 15.6 34.0" strokeWidth={w(0.9)} />
      <path d="M14.8 35.3C16.2 34.7 16.9 33.5 16.8 32.1" strokeWidth={w(0.58)} />

      <path d="M20.0 19.6C20.4 25.0 19.4 30.0 20.8 33.2C21.6 35.2 23.6 35.0 24.0 33.2" strokeWidth={w(0.85)} />

      <path d="M27.4 20.6C28.4 26.0 29.6 30.4 28.4 33.6C27.6 35.8 25.0 36.0 24.4 34.0" strokeWidth={w(0.9)} />
      <path d="M25.2 35.3C23.8 34.7 23.1 33.5 23.2 32.1" strokeWidth={w(0.58)} />

      <path d="M33.4 17.2C35.6 22.0 38.1 26.4 37.8 29.6C37.5 32.4 35.0 33.2 33.6 31.6" strokeWidth={w(0.9)} />
      <path d="M34.2 32.4C32.9 31.8 32.2 30.7 32.3 29.4" strokeWidth={w(0.58)} />

      <circle cx="13.6" cy="15.4" r="2.5" fill="currentColor" stroke="none" />
      <circle cx="26.4" cy="15.4" r="2.5" fill="currentColor" stroke="none" />
    </svg>
  );
}
