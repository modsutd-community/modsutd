import { useMemo, useState } from 'react';
import { useAppSelector } from '@/store';
import { CampusMap } from '@/components/CampusMap/CampusMap';
import { Pano } from '../Pano';
import type { VenueAvailability } from '@/types';
import { useWorkbenchUi } from '../uiContext';
import { normaliseHHMM, useNowInfo } from '../logic';
import { codeMatches, looksLikeCode, queryVariants } from '@/utils/search';
import wb from '../wb.module.scss';
import { panoFor } from '@/utils/pano';
import styles from './RoomsBody.module.scss';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] as const;
const HOURS = Array.from({ length: 13 }, (_, i) => i + 8); // 08:00–20:00

function toMin(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
}

function occupant(av: VenueAvailability | undefined, day: string, time: string) {
  if (!av) return null;
  const t = toMin(time);
  for (const slot of av.schedule) {
    if (slot.day !== day) continue;
    if (toMin(slot.startTime) <= t && t < toMin(slot.endTime)) return slot;
  }
  return null;
}

interface Seg {
  from: number;
  to: number;
  mod?: string;
  type?: string;
  /** The whole class, not this hour's slice of it. */
  span: string;
}

function Heatmap({ av }: { av?: VenueAvailability }) {
  // The mod under the pointer, so every segment of that class lights up and
  // not only the hour being pointed at.
  const [hot, setHot] = useState<string | undefined>(undefined);
  // Minutes, not whole hours. Rounding a class out to the hour said an 08:30
  // start occupies 08:00, and a 11:30 class overwrote the 11:00 cell of the
  // one before it - so a room read as busy when it was free, and two classes
  // in one hour showed as one.
  const grid = useMemo(() => {
    const g: Record<string, Record<number, Seg[]>> = {};
    for (const d of DAYS) g[d] = {};
    for (const slot of av?.schedule ?? []) {
      if (!(DAYS as readonly string[]).includes(slot.day)) continue;
      const s0 = toMin(slot.startTime);
      const e0 = toMin(slot.endTime);
      for (let h = Math.floor(s0 / 60); h < Math.ceil(e0 / 60); h++) {
        const from = Math.max(0, s0 - h * 60);
        const to = Math.min(60, e0 - h * 60);
        if (to <= from) continue;
        (g[slot.day][h] ??= []).push({
          from,
          to,
          mod: slot.modCode,
          type: slot.type,
          // A class is drawn as one bar per hour it touches. Naming the slice
          // told a reader the 10:30-11:00 of a class that runs to 12:30, which
          // is the one thing they are looking at the heatmap to find out.
          span: `${slot.startTime}-${slot.endTime}`,
        });
      }
    }
    return g;
  }, [av]);

  return (
    <div className={`${wb.nobar} ${styles.heatWrap}`}>
      <div className={styles.heatmap} data-act="room-heatmap">
        <div className={styles.heatRow}>
          <div className={`${styles.heatCell} ${styles.heatDay}`} />
          {HOURS.map((h) => (
            <div key={h} className={`${styles.heatCell} ${styles.heatHour}`}>{String(h).padStart(2, '0')}</div>
          ))}
        </div>
        {DAYS.map((day) => (
          <div key={day} className={styles.heatRow}>
            <div className={`${styles.heatCell} ${styles.heatDay}`}>{day.slice(0, 3).toUpperCase()}</div>
            {HOURS.map((h) => {
              const segs = grid[day]?.[h] ?? [];
              const full = segs.length === 1 && segs[0].to - segs[0].from >= 59;
              const label = segs.length
                ? segs
                    .map((x) => `${x.span} ${x.mod ?? 'occupied'}${x.type ? ` · ${x.type}` : ''}`)
                    .join('\n')
                : 'free';
              return (
                <div
                  key={h}
                  className={`${styles.heatCell} ${segs.length ? styles.heatOcc : styles.heatFree}`}
                  aria-label={`${day} ${String(h).padStart(2, '0')}:00 - ${segs.length ? label.split('\n').join('; ') : 'free'}`}
                  // Only the free cells answer for the whole hour. An occupied
                  // one hands the tip to each bar, so two classes sharing an
                  // hour are told apart by pointing at the one you mean.
                  data-tip={segs.length ? undefined : 'free'}
                >
                  {segs.map((x, i) => (
                    <i
                      key={i}
                      className={styles.heatFill}
                      style={{ left: `${(x.from / 60) * 100}%`, width: `${((x.to - x.from) / 60) * 100}%` }}
                      data-tip={`${x.span} ${x.mod ?? 'occupied'}${x.type ? ` · ${x.type}` : ''}`}
                      // A class runs across several hour cells, so the segment
                      // under the pointer is one slice of it. Keying the
                      // highlight on the mod lights the whole class at once,
                      // which is the thing a reader is actually looking for.
                      data-mod={x.mod}
                      data-tip-touch=""
                      // Pointer events, not mouse ones, and keyed on the type
                      // of the actual interaction rather than a media query:
                      // a phone has no hover, and Chromium still fires
                      // mouseenter after a tap for compatibility, so mouse
                      // handlers would immediately undo what the tap did.
                      onPointerEnter={(e) => {
                        if (e.pointerType === 'mouse') setHot(x.mod);
                      }}
                      onPointerLeave={(e) => {
                        if (e.pointerType === 'mouse') setHot(undefined);
                      }}
                      // Touch: the tap does both jobs, and taps again to
                      // dismiss - there is no pointer-leave to do it.
                      onPointerUp={(e) => {
                        if (e.pointerType === 'mouse') return;
                        setHot((cur) => (cur === x.mod ? undefined : x.mod));
                      }}
                      data-hot={hot && x.mod === hot ? '' : undefined}
                    />
                  ))}
                  {/* The code only fits when the hour is essentially full; the
                      tip carries it in every other case. */}
                  {full && segs[0].mod ? <span className={styles.heatMod}>{segs[0].mod}</span> : null}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className={styles.legend} aria-hidden>
        <span><i className={styles.lgFree} /> free</span>
        <span><i className={styles.lgOcc} /> occupied</span>
      </div>
    </div>
  );
}

export function RoomsBody() {
  const venues = useAppSelector((s) => s.venues.data);
  const availability = useAppSelector((s) => s.venues.availability);
  const loading = useAppSelector((s) => s.venues.loading);
  const {
    filter,
    probeDay, setProbeDay, probeTime, setProbeTime,
    selectedRoom, setSelectedRoom,
  } = useWorkbenchUi();

  const [timeDraft, setTimeDraft] = useState(probeTime);
  const [freeOnly, setFreeOnly] = useState(false);
  const [showPano, setShowPano] = useState(false);
  const timeValid = normaliseHHMM(timeDraft) !== null;

  const commitTime = (raw: string) => {
    const norm = normaliseHHMM(raw);
    if (norm) {
      setProbeTime(norm);
      setTimeDraft(norm);
    }
  };

  const pickRoom = (code: string | null) => {
    setSelectedRoom(code);
    setShowPano(false);
  };

  // One query for rooms and mods alike: the mobile tab and the desktop global
  // search write the same value, so switching tabs keeps what you typed.
  const effectiveQuery = filter.trim();

  const sorted = useMemo(() => {
    // Substring match, but over every spelling of the query: a student types
    // "tt" far more often than "think tank", and the raw needle only ever
    // matched a room with a literal "tt" in its text.
    const needles = queryVariants(effectiveQuery);
    // A typed code is answered by code alone. "5.0" is a place, not a string
    // to find inside one, and matching it anywhere put nine building 1 rooms
    // above building 5.
    const byCode = looksLikeCode(effectiveQuery)
      ? new Set(codeMatches(Object.keys(venues), effectiveQuery))
      : null;
    return Object.values(venues)
      .filter(
        (v) =>
          !needles.length ||
          (byCode
            ? byCode.has(v.code)
            : needles.some((n) => {
              const hay = [v.code, v.name, v.type, ...(v.altNames ?? [])].join(' ').toLowerCase();
              return hay.includes(n) || hay.replace(/[^a-z0-9]/g, '').includes(n);
            })),
      )
      .filter((v) => !freeOnly || (!v.facility && !occupant(availability[v.code], probeDay, probeTime)))
      .sort((a, b) => a.code.localeCompare(b.code));
  }, [venues, effectiveQuery, freeOnly, availability, probeDay, probeTime]);

  const detail = selectedRoom ? venues[selectedRoom] : undefined;
  // Starting point for an indoor route: the class the student is actually in
  // right now, which beats any sensor. Only usable if that room is on the map
  // too - the departure parameter matches by exact label as well.
  const events = useAppSelector((s) => s.timetable.events);
  const hereNow = useNowInfo(events).current?.location ?? null;
  const fromMapName = useMemo(() => {
    if (!hereNow || hereNow === selectedRoom) return null;
    return venues[hereNow]?.mapName ?? null;
  }, [hereNow, selectedRoom, venues]);
  const detailAv = selectedRoom ? availability[selectedRoom] : undefined;
  // Its own 360, or a room of the same type standing in - see utils/pano.
  const pano = useMemo(() => panoFor(detail, Object.values(venues)), [detail, venues]);

  return (
    <div className={`${styles.split} ${detail ? styles.hasDetail : ''}`}>
      <div className={styles.finder}>
        <div className={`${wb.chipRow} ${wb.nobar}`}>
          <select
            className={`${wb.input} ${styles.daySelect}`}
            value={probeDay}
            onChange={(e) => setProbeDay(e.target.value)}
            aria-label="probe day"
          >
            {DAYS.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
          <span className={wb.faint} style={{ margin: '0 3px' }}>@</span>
          <input
            className={`${wb.input} ${styles.timeInput} ${timeValid ? '' : wb.inputBad}`}
            value={timeDraft}
            onChange={(e) => setTimeDraft(e.target.value)}
            onBlur={() => commitTime(timeDraft)}
            onKeyDown={(e) => { if (e.key === 'Enter') commitTime(timeDraft); }}
            placeholder="HH:MM"
            inputMode="numeric"
            aria-label="probe time - any HH:MM"
            aria-invalid={!timeValid}
            aria-describedby={timeValid ? undefined : 'wb-time-hint'}
          />
          <button
            type="button"
            className={`${wb.chip} ${freeOnly ? wb.chipOn : ''}`}
            aria-pressed={freeOnly}
            onClick={() => setFreeOnly((v) => !v)}
          >
            FREE
          </button>
        </div>
        {!timeValid && (
          <p id="wb-time-hint" role="status" className={styles.timeHint}>
            enter a valid 24h time, e.g. 09:30 or 15:45 - showing {probeTime}
          </p>
        )}

        <div className={`${wb.scroll} ${styles.roomGrid}`}>
          {sorted.map((v) => {
            const busy = v.facility ? null : occupant(availability[v.code], probeDay, probeTime);
            const on = selectedRoom === v.code;
            return (
              <button
                key={v.code}
                type="button"
                data-code={v.code}
                className={`${styles.roomCell} ${busy ? styles.roomBusy : styles.roomFree} ${on ? styles.roomOn : ''}`}
                onClick={() => pickRoom(on ? null : v.code)}
                data-tip={v.facility ? v.name : busy ? `${busy.modCode ?? ''} until ${busy.endTime}` : `free at ${probeTime}`}
              >
                <span className={v.facility ? styles.roomFacility : styles.roomCode}>
                  {v.facility ? v.name : v.code}
                </span>
                {!v.facility && (
                  <span className={busy ? styles.tagBusy : styles.tagFree}>
                    {busy ? `BUSY → ${busy.endTime}` : 'FREE'}
                  </span>
                )}
              </button>
            );
          })}
          {sorted.length === 0 && (
            <div className={wb.empty}>
              {loading ? 'loading venues…' : effectiveQuery ? `no rooms match "${effectiveQuery}".` : 'no venues loaded.'}
            </div>
          )}
        </div>
      </div>

      {detail && (
        <div className={`${wb.scroll} ${styles.detail}`}>
          <button type="button" className={styles.backBtn} data-act="rooms-back" onClick={() => pickRoom(null)}>
            ← rooms
          </button>
          <div className={styles.detailHead}>
            <div>
              <div className={styles.detailCode}>
                {detail.facility
                  ? detail.code === detail.name ? detail.name : `${detail.name} · ${detail.code}`
                  : `${detail.code} · ${detail.name}`}
              </div>
              {detail.altNames && detail.altNames.length > 0 && (
                <div className={wb.faint} style={{ fontSize: 11 }}>aka: {detail.altNames.join(' · ')}</div>
              )}
              <div className={wb.dim} style={{ fontSize: 12 }}>
                {detail.type}
                {detail.capacity ? ` · cap ${detail.capacity}` : ''}
              </div>
              {detail.facilities && detail.facilities.length > 0 && (
                <div className={wb.dim} style={{ fontSize: 11 }}>{detail.facilities.join(' · ')}</div>
              )}
            </div>
          </div>

          {detail.landmarks && detail.landmarks.length > 0 && (
            <div className={styles.landmarks} data-act="landmarks">
              {detail.landmarks.map((l) => <span key={l} className={wb.chip}>{l}</span>)}
            </div>
          )}

          {pano && (
            <div style={{ margin: '10px 0' }}>
              {showPano ? (
                <Pano scenes={pano.scenes} />
              ) : (
                <button type="button" className={styles.pano360} onClick={() => setShowPano(true)}>
                  view in 360 ↗
                </button>
              )}
            </div>
          )}

          <div className={styles.visuals} style={{ marginTop: 12 }}>
            <CampusMap
              building={detail.building}
              floor={detail.floor}
              venueCode={detail.code}
              name={detail.name}
              mapName={detail.mapName}
              fromMapName={fromMapName}
              lat={detail.lat}
              lng={detail.lng}
              osmLevel={detail.osmLevel}
              osmKeys={detail.osmKeys}
              liftLobby={detail.liftLobby}
              coordApprox={detail.coordApprox}
            />
          </div>

          {!detail.facility && (
            <>
              <div className={wb.eyebrow} style={{ margin: '12px 0 6px' }}>WEEK AT A GLANCE</div>
              <Heatmap av={detailAv} />
            </>
          )}


        </div>
      )}
    </div>
  );
}
