import { describe, it, expect } from 'vitest';
import manifest from '../../public/manifest.webmanifest?raw';
import indexHtml from '../../index.html?raw';

// Installed to a home screen the SVG favicon is not enough: Android reads the
// manifest, iOS reads apple-touch-icon, and with neither present both invented
// an icon of their own - which is why the PWA kept the old mark.
describe('home-screen install', () => {
  const m = JSON.parse(manifest) as {
    name: string;
    icons: { src: string; sizes: string; purpose?: string }[];
    display: string;
  };

  it('is linked from the document, both kinds', () => {
    expect(indexHtml).toContain('rel="manifest"');
    expect(indexHtml).toContain('rel="apple-touch-icon"');
  });

  it('offers the sizes an installer actually looks for', () => {
    const sizes = m.icons.map((i) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
  });

  // Android crops a home-screen icon to a circle. Without a maskable entry it
  // crops the normal one, taking the octopus's outer arms with it.
  it('ships a maskable icon', () => {
    expect(m.icons.some((i) => i.purpose === 'maskable')).toBe(true);
  });

  it('opens as an app, not a browser tab', () => {
    expect(m.display).toBe('standalone');
    expect(m.name).toBe('modSUTD');
  });
});
