export type Pillar = 'SMT' | 'EPD' | 'ESD' | 'CSD' | 'DAI' | 'ASD' | 'HASS';
export type Term   = '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10';
export type LessonType = 'Lecture' | 'Cohort' | 'Tutorial' | 'Lab' | 'Studio' | 'Seminar' | 'Recitation';

export interface Workload {
  lecture: number;
  tutorial: number;
  project: number;
  preparation: number;
  total: number;
  // 'official' = read off the course page's "Workload: a-b-c" line.
  // Only official workloads ship - never estimates.
  source?: string;
}

export interface Schedule {
  type: LessonType;
  day: 'Monday' | 'Tuesday' | 'Wednesday' | 'Thursday' | 'Friday' | 'Saturday' | 'Sunday';
  startTime: string;
  endTime: string;
  location: string;
  instructors: string[];
  cohort?: string;
  weeks?: number[];
}

export interface GradingComponent {
  name: string;
  percentage: number;
  description?: string;
}

export interface GradingScheme {
  components: GradingComponent[];
  passingGrade?: string;
  // 'official' when parsed from the course page's Learning assessment
  // table. Only official grading ships - never estimates.
  source?: string;
}

// Recursive prereq tree. A leaf is a mod code; supports "10.001:B" for
// minimum-grade and "10.%" for wildcards.
export type PrereqTree =
  | string
  | { and: PrereqTree[] }
  | { or: PrereqTree[] }
  | { nOf: [number, PrereqTree[]] };

export interface Mod {
  code: string;
  // App-side unique key, set at load: the code, except name-distinct
  // 99.999 placeholders which use 'code|name'. Not present in the JSON.
  key?: string;
  name: string;
  description: string;
  credits: number;
  department: string;
  pillar: Pillar;
  term: Term;
  // Official listing tags from sutd.edu.sg (e.g. "Term 5", "AI Track",
  // "Freshmore Core") - the fuel for specialisation-track matching.
  tags?: string[];
  prerequisites?: string[];
  prereqTree?: PrereqTree;
  corequisites?: string[];
  fulfilRequirements?: string[];
  schedules: Schedule[];
  grading?: GradingScheme;
  workload?: Workload;
}

export type VenueType =
  | 'Lecture Theatre'
  | 'Cohort Classroom'
  | 'Think Tank'
  | 'Lab'
  | 'Seminar Room'
  | 'Meeting Room'
  | 'Studio'
  | 'Auditorium'
  | 'Facility';

export interface Venue {
  code: string;
  name: string;
  building: string;
  floor: number;
  type: VenueType;
  capacity?: number;
  facilities?: string[];
  // Short landmark phrases shown as chips next to the room title.
  /** Derived by sync-data.mjs from the survey. Never edited into a venue
   *  file: a typed copy could only disagree with the map. */
  landmarks?: string[];
  // Other names on the door plate (donor names, TT numbers).
  altNames?: string[];
  // This room's label on the third-party indoor map, which deep-links by
  // exact name and fails silently on anything else. Absent = not on that map,
  // or ambiguous; the link is simply not offered. Never a source of truth for
  // the room's own name or code, and it is the only field allowed to carry a
  // code, because the map resolves by exact label and fails silently.
  mapName?: string;
  // virtualtour.sutd.edu.sg panos (scene id minus 'scene_'), in nav order.
  panoScenes?: Array<{ scene: string; title: string }>;
  // Named campus facility, no room code: never shows FREE/BUSY state.
  facility?: boolean;
  // Centroid of the room as surveyed on foot and uploaded to OpenStreetMap,
  // attached at build time by sync-data.mjs from data/_meta/room-coords.json.
  // Do not hand-edit into a venue file: there is one generator for it, so an
  // edit here could only disagree with the survey.
  lat?: number;
  lng?: number;
  // OSM's own level numbering, where ground is 0. The plate says one more
  // ("Level 3" is level 2), which is why floor and this are different numbers.
  osmLevel?: number;
  // Which surveyed shapes ARE this venue - door plate, or name where there is
  // none. A list because a venue can be more than one shape: the hostel is two
  // lobbies. The map picks out every one of them.
  osmKeys?: string[];
  // Nearest surveyed lift lobby in this building, on this floor. Derived by
  // sync-data.mjs, which is why it exists for 177 venues rather than the nine
  // somebody once wrote a sentence for.
  liftLobby?: string;
  // The pin is the mean of the placed rooms in this building, not this room.
  // Set by sync-data.mjs for the 15 venues the survey did not reach, and shown
  // on screen - an approximate pin presented as exact is how someone hunts the
  // wrong floor of the right building.
  coordApprox?: boolean;
}

export interface VenueTimeSlot {
  day: Schedule['day'];
  startTime: string;
  endTime: string;
  modCode?: string;
  modName?: string;
  type?: LessonType;
}

export interface VenueAvailability {
  venueCode: string;
  schedule: VenueTimeSlot[];
}

export interface TimetableEvent {
  modCode: string;
  modName: string;
  type: string;
  day: Schedule['day'];
  startTime: string;
  endTime: string;
  location: string;
  instructors: string[];
  startDate: string;
  endDate: string;
  // Exact class dates (ISO), when known - e.g. captured from the live MyPortal
  // DOM, which sees holidays and reschedules. When present, the ICS export
  // emits one event per date instead of a weekly recurrence rule.
  occurrences?: string[];
}

export interface ModsState {
  data: Record<string, Mod>;
  loading: boolean;
  error: string | null;
}

export interface VenuesState {
  data: Record<string, Venue>;
  availability: Record<string, VenueAvailability>;
  loading: boolean;
  error: string | null;
}

export type Curriculum = 'classic' | 'ay2026';

// One curriculum's plan: which mods the student placed, and at which of
// the 10 term levels. Mods without a level default to their catalogue term.
export interface PlanState {
  selectedMods: string[];
  planLevels: Record<string, number>;
}

export interface TimetableState {
  events: TimetableEvent[];
  // The classic and AY2026 plans are fully independent - the AY2026?
  // toggle switches views without either side bleeding into the other.
  plans: Record<Curriculum, PlanState>;
  savedAt?: string;
}

// A record carries its own editable copy of the grading components (not a
// reference to the mod's data) so ad-hoc changes don't touch the catalogue.
export interface RecordComponent {
  name: string;
  weight: number; // % of the final grade
  score: number | null; // achieved %, null = not entered
}

export interface ModRecord {
  notes: string;
  components?: RecordComponent[];
  // Legacy shape (pre components) - migrated on first open.
  scores?: Record<string, number | null>;
}

export type RecordsState = Record<string, ModRecord>;

export interface RootState {
  mods: ModsState;
  venues: VenuesState;
  timetable: TimetableState;
  records: RecordsState;
}
