import { useCallback, useEffect, useRef, useState } from 'react';
import { mapLink } from '@/utils/mapLink';
import { useIndoorMap } from './useIndoorMap';
import styles from './CampusMap.module.scss';

interface Props {
  building: string;
  floor?: number;
  venueCode?: string;
  name?: string;
  mapName?: string | null;
  fromMapName?: string | null;
  lat?: number;
  lng?: number;
  osmLevel?: number;
  osmKeys?: string[];
  /** Nearest lift lobby in this building, on this floor. */
  liftLobby?: string;
  /** Set when the pin is the building's average, not this room. */
  coordApprox?: boolean;
}

const REPO = 'modsutd-community/modsutd';

// Google's documented deep-link form. The long /maps/place/ URL a browser
// leaves in the address bar carries a session token and a build stamp, which
// go stale; this one is the supported API and does not.
const googleMaps = (lat: number, lng: number) =>
  `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;



export function CampusMap(props: Props) {
  const { building, floor, venueCode, name, mapName, fromMapName, lat, lng, osmLevel, osmKeys, liftLobby, coordApprox } = props;
  const host = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [asked, setAsked] = useState(false);
  const [full, setFull] = useState(false);

  const placed = lat !== undefined && lng !== undefined;
  const { plate, indoor, hasPlan, needCtrl, failed } = useIndoorMap(
    host,
    { lat: lat ?? 0, lng: lng ?? 0, osmLevel, venueCode, osmKeys, building },
  );

  useEffect(() => {
    const on = () => setFull(document.fullscreenElement === wrap.current);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);

  const toggleFull = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void wrap.current?.requestFullscreen?.().catch(() => {});
  }, []);

  // Only the no-map fallback prints this now. When there IS a map, the same
  // words are landmark chips above it (derived in sync-data.mjs), and a
  // caption repeating them was the room's location twice on one screen.
  const place = [
    `Building ${building}`,
    floor === undefined ? null : `Level ${floor}`,
    liftLobby,
  ].filter(Boolean).join(', ');

  // Nothing maps this block yet, and a search-engine guess at the address is
  // worse than saying so: it sends people to a pin that is not the room.
  if (!placed) {
    const reportUrl = `https://github.com/${REPO}/issues/new?title=${encodeURIComponent(
      `data: no map for ${venueCode ?? building} ${name ?? ''}`.trim(),
    )}&body=${encodeURIComponent('<!-- which block, and where is it actually -->')}&labels=data`;
    return asked ? (
      <p className={styles.none}>
        Nothing maps this one yet.{' '}
        <a href={reportUrl} target="_blank" rel="noopener noreferrer">Report it?</a>
      </p>
    ) : (
      <button type="button" className={styles.link} onClick={() => setAsked(true)}>
        {place} · no map yet
      </button>
    );
  }

  // The indoor plan says which room; Google Maps says how to reach campus.
  // So the button offers the one the map cannot already do.
  const href = mapName ? mapLink(mapName, fromMapName) : googleMaps(lat!, lng!);
  const label = mapName ? 'Open indoor map' : 'Open in Google Maps';

  return (
    <div ref={wrap} className={`${styles.wrap} ${full ? styles.full : ''}`} data-act="campus-map">
      <div ref={host} className={styles.canvas} data-act="map-canvas" />

      <button
        type="button"
        className={styles.fs}
        onClick={toggleFull}
        aria-label={full ? 'Exit full screen' : 'Full screen'}
        data-act="map-fullscreen"
      >
        {full ? '↙' : '⤢'}
      </button>

      {indoor && plate !== null && (
        // Under the zoom control, reading like one more of its buttons: which
        // floor you are looking at, not a switch for choosing another. The
        // label is OSM's own `level:ref`, so it says what the door plate says.
        <span className={styles.levelBadge} data-act="map-level">L{plate}</span>
      )}

      {needCtrl && (
        <div className={styles.wheelHint} role="status" data-act="map-wheel-hint">
          Ctrl + scroll to zoom
        </div>
      )}

      <a className={styles.cta} href={href} target="_blank" rel="noopener noreferrer" data-act="map-cta">
        {label}
      </a>

      <p className={styles.cap}>
        {coordApprox && <span data-act="map-nodata">no data</span>}
        {failed && ' · floor plan unavailable'}
        {/* Only offered when there is something behind it: a room the survey
            never reached has no plan to zoom into. */}
        {!coordApprox && hasPlan && !indoor && (
          <span className={styles.capHint} data-act="map-zoom-hint">zoom in to see indoors</span>
        )}
      </p>
    </div>
  );
}
