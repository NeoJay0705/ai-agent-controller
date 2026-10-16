import {
  AstroTime,
  Body,
  Ecliptic,
  GeoVector,
  SiderealTime,
  e_tilt,
} from 'astronomy-engine';

export const ASTRONOMY_ENGINE_VERSION = '2.1.19';
export const NATAL_METHOD_VERSION = 'natal-chart-v1';
export const MAX_NATAL_ASPECT_ORB_DEGREES = 6;

export type BirthValidationCode =
  | 'INVALID_INPUT'
  | 'INVALID_DATE'
  | 'DATE_OUT_OF_RANGE'
  | 'TIME_REQUIRED'
  | 'INVALID_TIME'
  | 'INVALID_TIME_ZONE'
  | 'NONEXISTENT_LOCAL_TIME'
  | 'AMBIGUOUS_LOCAL_TIME'
  | 'UTC_OFFSET_MISMATCH'
  | 'INVALID_LATITUDE'
  | 'INVALID_LONGITUDE'
  | 'INVALID_UTC_OFFSET'
  | 'CALCULATION_ERROR';

export class BirthValidationError extends TypeError {
  readonly code: BirthValidationCode;

  constructor(code: BirthValidationCode) {
    super(`Birth chart input is invalid (${code}).`);
    this.name = 'BirthValidationError';
    this.code = code;
  }
}

export interface BirthChartInput {
  readonly localDate: string;
  readonly localTime: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly timeZone: string;
  /** Minutes east of UTC. Required only to select one side of a DST overlap. */
  readonly utcOffsetMinutes?: number;
}

export interface ZodiacPoint {
  readonly longitude: number;
  readonly sign: string;
}

export interface PlanetPosition extends ZodiacPoint {
  readonly body: string;
  readonly house: number;
}

export type NatalAspectName =
  'conjunction' | 'sextile' | 'square' | 'trine' | 'opposition';

export interface NatalAspect {
  readonly first: string;
  readonly second: string;
  readonly aspect: NatalAspectName;
  readonly exactDegrees: number;
  readonly orbDegrees: number;
}

export interface NatalChartResult {
  readonly input: BirthChartInput;
  readonly utcDate: string;
  readonly method: {
    readonly version: string;
    readonly engine: string;
    readonly engineVersion: string;
    readonly coordinates: 'geocentric apparent tropical ecliptic-of-date';
    readonly zodiac: 'tropical';
    readonly houses: 'equal';
    readonly aspectOrbDegrees: number;
  };
  readonly planets: readonly PlanetPosition[];
  readonly ascendant: ZodiacPoint;
  readonly midheaven: ZodiacPoint;
  readonly houseCusps: readonly ZodiacPoint[];
  readonly aspects: readonly NatalAspect[];
}

interface LocalDateTimeParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

const SIGNS = [
  '牡羊座',
  '金牛座',
  '雙子座',
  '巨蟹座',
  '獅子座',
  '處女座',
  '天秤座',
  '天蠍座',
  '射手座',
  '摩羯座',
  '水瓶座',
  '雙魚座',
] as const;

const PLANETS = [
  { name: 'Sun', body: Body.Sun },
  { name: 'Moon', body: Body.Moon },
  { name: 'Mercury', body: Body.Mercury },
  { name: 'Venus', body: Body.Venus },
  { name: 'Mars', body: Body.Mars },
  { name: 'Jupiter', body: Body.Jupiter },
  { name: 'Saturn', body: Body.Saturn },
  { name: 'Uranus', body: Body.Uranus },
  { name: 'Neptune', body: Body.Neptune },
  { name: 'Pluto', body: Body.Pluto },
] as const;

const ASPECTS: readonly {
  readonly name: NatalAspectName;
  readonly degrees: number;
}[] = [
  { name: 'conjunction', degrees: 0 },
  { name: 'sextile', degrees: 60 },
  { name: 'square', degrees: 90 },
  { name: 'trine', degrees: 120 },
  { name: 'opposition', degrees: 180 },
];

export function validateBirthChartInput(value: unknown): BirthChartInput {
  if (!isPlainRecord(value)) throw new BirthValidationError('INVALID_INPUT');
  const allowed = new Set([
    'localDate',
    'localTime',
    'latitude',
    'longitude',
    'timeZone',
    'utcOffsetMinutes',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new BirthValidationError('INVALID_INPUT');
  }

  const localDate = value['localDate'];
  const localTime = value['localTime'];
  const latitude = value['latitude'];
  const longitude = value['longitude'];
  const timeZone = value['timeZone'];
  if (typeof localDate !== 'string')
    throw new BirthValidationError('INVALID_DATE');
  const dateParts = parseCalendarDate(localDate);
  if (dateParts.year < 1900 || dateParts.year > 2100) {
    throw new BirthValidationError('DATE_OUT_OF_RANGE');
  }
  if (localTime === undefined || localTime === null || localTime === '') {
    throw new BirthValidationError('TIME_REQUIRED');
  }
  if (
    typeof localTime !== 'string' ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(localTime)
  ) {
    throw new BirthValidationError('INVALID_TIME');
  }
  if (
    typeof latitude !== 'number' ||
    !Number.isFinite(latitude) ||
    latitude < -66 ||
    latitude > 66
  ) {
    throw new BirthValidationError('INVALID_LATITUDE');
  }
  if (
    typeof longitude !== 'number' ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw new BirthValidationError('INVALID_LONGITUDE');
  }
  if (typeof timeZone !== 'string' || timeZone.length === 0) {
    throw new BirthValidationError('INVALID_TIME_ZONE');
  }
  try {
    new Intl.DateTimeFormat('en-CA-u-ca-iso8601-nu-latn', { timeZone });
  } catch {
    throw new BirthValidationError('INVALID_TIME_ZONE');
  }

  const offset = value['utcOffsetMinutes'];
  if (
    offset !== undefined &&
    (typeof offset !== 'number' ||
      !Number.isSafeInteger(offset) ||
      offset < -840 ||
      offset > 840)
  ) {
    throw new BirthValidationError('INVALID_UTC_OFFSET');
  }
  const result: BirthChartInput = {
    localDate,
    localTime,
    latitude,
    longitude,
    timeZone,
    ...(offset === undefined ? {} : { utcOffsetMinutes: offset }),
  };
  return result;
}

export function resolveBirthTimeToUtc(value: unknown): Date {
  const input = validateBirthChartInput(value);
  const dateParts = parseCalendarDate(input.localDate);
  const [hourText, minuteText] = input.localTime.split(':');
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const wallClockEpoch = Date.UTC(
    dateParts.year,
    dateParts.month - 1,
    dateParts.day,
    hour,
    minute,
  );
  const formatter = new Intl.DateTimeFormat('en-CA-u-ca-iso8601-nu-latn', {
    timeZone: input.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const offsets = new Set<number>();
  for (let hours = -48; hours <= 48; hours += 6) {
    offsets.add(offsetSecondsAt(wallClockEpoch + hours * 3_600_000, formatter));
  }
  const candidates = [...offsets]
    .map((offsetSeconds) => ({
      epoch: wallClockEpoch - offsetSeconds * 1000,
      offsetSeconds,
    }))
    .filter(({ epoch }) =>
      matchesLocalTime(epoch, formatter, dateParts, hour, minute),
    )
    .sort((left, right) => left.epoch - right.epoch);
  if (candidates.length === 0)
    throw new BirthValidationError('NONEXISTENT_LOCAL_TIME');

  let selected = candidates;
  const requestedOffset = input.utcOffsetMinutes;
  if (requestedOffset !== undefined) {
    selected = candidates.filter(
      (candidate) => candidate.offsetSeconds === requestedOffset * 60,
    );
    if (selected.length === 0)
      throw new BirthValidationError('UTC_OFFSET_MISMATCH');
  }
  if (selected.length > 1)
    throw new BirthValidationError('AMBIGUOUS_LOCAL_TIME');
  const epoch = selected[0]?.epoch;
  if (epoch === undefined || !Number.isFinite(epoch)) {
    throw new BirthValidationError('CALCULATION_ERROR');
  }
  return new Date(epoch);
}

export function calculateNatalChart(value: unknown): NatalChartResult {
  const input = validateBirthChartInput(value);
  const utcDate = resolveBirthTimeToUtc(input);
  const time = new AstroTime(utcDate);
  const ascendant = calculateAscendant(time, input.latitude, input.longitude);
  const midheaven = calculateMidheaven(time, input.longitude);
  const houseCusps = Array.from({ length: 12 }, (_, index) =>
    zodiacPoint(normalizeDegrees(ascendant.longitude + index * 30)),
  );
  const planets = PLANETS.map(({ name, body }): PlanetPosition => {
    const ecliptic = Ecliptic(GeoVector(body, time, true));
    const longitude = normalizeDegrees(ecliptic.elon);
    const house =
      Math.floor(normalizeDegrees(longitude - ascendant.longitude) / 30) + 1;
    return { body: name, longitude, sign: signFor(longitude), house };
  });
  const aspects = calculateAspects(planets);
  const values = [
    ascendant.longitude,
    midheaven.longitude,
    ...houseCusps.map((cusp) => cusp.longitude),
    ...planets.flatMap((planet) => [planet.longitude, planet.house]),
    ...aspects.flatMap((aspect) => [aspect.exactDegrees, aspect.orbDegrees]),
  ];
  if (values.some((number) => !Number.isFinite(number))) {
    throw new BirthValidationError('CALCULATION_ERROR');
  }
  return {
    input,
    utcDate: utcDate.toISOString(),
    method: {
      version: NATAL_METHOD_VERSION,
      engine: 'astronomy-engine',
      engineVersion: ASTRONOMY_ENGINE_VERSION,
      coordinates: 'geocentric apparent tropical ecliptic-of-date',
      zodiac: 'tropical',
      houses: 'equal',
      aspectOrbDegrees: MAX_NATAL_ASPECT_ORB_DEGREES,
    },
    planets,
    ascendant,
    midheaven,
    houseCusps,
    aspects,
  };
}

export function normalizeDegrees(degrees: number): number {
  if (!Number.isFinite(degrees))
    throw new BirthValidationError('CALCULATION_ERROR');
  const normalized = ((degrees % 360) + 360) % 360;
  return Object.is(normalized, -0) ? 0 : normalized;
}

function calculateAscendant(
  time: AstroTime,
  latitude: number,
  longitude: number,
): ZodiacPoint {
  const thetaDegrees = normalizeDegrees(SiderealTime(time) * 15 + longitude);
  const theta = degreesToRadians(thetaDegrees);
  const epsilon = degreesToRadians(e_tilt(time).tobl);
  const phi = degreesToRadians(latitude);
  const base = normalizeDegrees(
    radiansToDegrees(
      Math.atan2(
        Math.cos(theta),
        -(
          Math.sin(theta) * Math.cos(epsilon) +
          Math.tan(phi) * Math.sin(epsilon)
        ),
      ),
    ),
  );
  const candidates = [base, normalizeDegrees(base + 180)];
  const rising = candidates.find((candidate) => {
    const lambda = degreesToRadians(candidate);
    const eastDot =
      -Math.cos(lambda) * Math.sin(theta) +
      Math.sin(lambda) * Math.cos(epsilon) * Math.cos(theta);
    return eastDot > 0;
  });
  if (rising === undefined) throw new BirthValidationError('CALCULATION_ERROR');
  return zodiacPoint(rising);
}

function calculateMidheaven(time: AstroTime, longitude: number): ZodiacPoint {
  const theta = degreesToRadians(
    normalizeDegrees(SiderealTime(time) * 15 + longitude),
  );
  const epsilon = degreesToRadians(e_tilt(time).tobl);
  const angle = radiansToDegrees(
    Math.atan2(Math.sin(theta), Math.cos(theta) * Math.cos(epsilon)),
  );
  return zodiacPoint(normalizeDegrees(angle));
}

function calculateAspects(
  planets: readonly PlanetPosition[],
): readonly NatalAspect[] {
  const result: NatalAspect[] = [];
  for (let firstIndex = 0; firstIndex < planets.length; firstIndex += 1) {
    const first = planets[firstIndex];
    if (first === undefined) continue;
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < planets.length;
      secondIndex += 1
    ) {
      const second = planets[secondIndex];
      if (second === undefined) continue;
      const difference = Math.abs(first.longitude - second.longitude);
      const separation = Math.min(difference, 360 - difference);
      const match = ASPECTS.find(
        (aspect) =>
          Math.abs(separation - aspect.degrees) <= MAX_NATAL_ASPECT_ORB_DEGREES,
      );
      if (match !== undefined) {
        result.push({
          first: first.body,
          second: second.body,
          aspect: match.name,
          exactDegrees: match.degrees,
          orbDegrees: Math.abs(separation - match.degrees),
        });
      }
    }
  }
  return result;
}

function zodiacPoint(longitude: number): ZodiacPoint {
  const normalized = normalizeDegrees(longitude);
  return { longitude: normalized, sign: signFor(normalized) };
}

function signFor(longitude: number): string {
  const index = Math.floor(normalizeDegrees(longitude) / 30);
  return SIGNS[index] ?? SIGNS[0];
}

function parseCalendarDate(value: string): LocalDateTimeParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) throw new BirthValidationError('INVALID_DATE');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== day
  ) {
    throw new BirthValidationError('INVALID_DATE');
  }
  return { year, month, day, hour: 0, minute: 0, second: 0 };
}

function offsetSecondsAt(
  epoch: number,
  formatter: Intl.DateTimeFormat,
): number {
  const parts = formatParts(epoch, formatter);
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return Math.round((localAsUtc - epoch) / 1000);
}

function matchesLocalTime(
  epoch: number,
  formatter: Intl.DateTimeFormat,
  date: LocalDateTimeParts,
  hour: number,
  minute: number,
): boolean {
  const parts = formatParts(epoch, formatter);
  return (
    parts.year === date.year &&
    parts.month === date.month &&
    parts.day === date.day &&
    parts.hour === hour &&
    parts.minute === minute &&
    parts.second === 0
  );
}

function formatParts(
  epoch: number,
  formatter: Intl.DateTimeFormat,
): LocalDateTimeParts {
  const parts = formatter.formatToParts(new Date(epoch));
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.get('year')),
    month: Number(values.get('month')),
    day: Number(values.get('day')),
    hour: Number(values.get('hour')),
    minute: Number(values.get('minute')),
    second: Number(values.get('second')),
  };
}

function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function radiansToDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}
