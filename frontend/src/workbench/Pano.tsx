import { useEffect, useRef, useState } from 'react';
import styles from './Pano.module.scss';

// CSS-3D cube panorama over the official virtual tour's cube faces.
// WebGL is not an option: virtualtour.sutd.edu.sg serves the tiles without
// CORS headers, which taints canvas textures - plain transformed <img>
// elements have no such restriction.
const FACE_URL = (scene: string, face: string) =>
  `https://virtualtour.sutd.edu.sg/panos/${scene}.tiles/pano_${face}.jpg`;

const FACES: Array<{ face: string; transform: string }> = [
  { face: 'f', transform: 'rotateY(0deg)' },
  { face: 'r', transform: 'rotateY(-90deg)' },
  { face: 'b', transform: 'rotateY(180deg)' },
  { face: 'l', transform: 'rotateY(90deg)' },
  { face: 'u', transform: 'rotateX(90deg)' },
  { face: 'd', transform: 'rotateX(-90deg)' },
];

export interface PanoScene {
  scene: string;
  title: string;
}

export function Pano({ scenes }: { scenes: PanoScene[] }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ yaw: 0, pitch: 0 });
  const [fullscreen, setFullscreen] = useState(false);
  const [loaded, setLoaded] = useState(0);
  const [idx, setIdx] = useState(0);
  const current = scenes[Math.min(idx, scenes.length - 1)];
  const step = (d: number) => {
    setIdx((i) => (i + d + scenes.length) % scenes.length);
    setLoaded(0);
  };

  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement === wrapRef.current);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, ...view };
    const move = (ev: PointerEvent) => {
      setView({
        yaw: start.yaw + (ev.clientX - start.x) * 0.22,
        pitch: Math.max(-85, Math.min(85, start.pitch - (ev.clientY - start.y) * 0.22)),
      });
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement === wrapRef.current) void document.exitFullscreen();
    else void wrapRef.current?.requestFullscreen();
  };

  return (
    <div ref={wrapRef} className={`${styles.wrap} ${fullscreen ? styles.fs : ''}`}>
      <div
        className={styles.scene}
        onPointerDown={onPointerDown}
        role="img"
        aria-label={`360 degree view: ${current.title}. drag to look around`}
      >
        <div
          className={styles.cube}
          style={{ transform: `translateZ(var(--pano-r)) rotateX(${view.pitch}deg) rotateY(${view.yaw}deg)` }}
        >
          {FACES.map(({ face, transform }) => (
            <img
              key={`${current.scene}-${face}`}
              className={styles.face}
              style={{ transform: `${transform} translateZ(calc(var(--pano-r) * -1))` }}
              src={FACE_URL(current.scene, face)}
              alt=""
              draggable={false}
              onLoad={() => setLoaded((n) => n + 1)}
            />
          ))}
        </div>
        {loaded < 6 && <span className={styles.loading}>loading 360° · {loaded}/6</span>}
        {scenes.length > 1 && (
          <>
            <button type="button" className={`${styles.nav} ${styles.navPrev}`} aria-label="previous view"
              onPointerDown={(e) => e.stopPropagation()} onClick={() => step(-1)}>‹</button>
            <button type="button" className={`${styles.nav} ${styles.navNext}`} aria-label="next view"
              onPointerDown={(e) => e.stopPropagation()} onClick={() => step(1)}>›</button>
          </>
        )}
        {fullscreen && <span className={styles.fsTitle}>{current.title}</span>}
      </div>
      <div className={styles.bar}>
        <span className={styles.hint}>
          {scenes.length > 1 ? `${fullscreen ? '' : `${current.title} · `}${idx + 1}/${scenes.length} · ` : ''}drag to look around
        </span>
        <button type="button" className={styles.fsBtn} onClick={toggleFullscreen}>
          {fullscreen ? '⤡ exit' : '⤢ fullscreen'}
        </button>
      </div>
    </div>
  );
}
