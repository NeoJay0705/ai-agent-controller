import { describe, expect, it } from 'vitest';

import {
  ASTRONOMY_ENGINE_VERSION,
  BirthValidationError,
  calculateNatalChart,
  resolveBirthTimeToUtc,
  validateBirthChartInput,
} from '../../src/flow/natal.js';
import type { BirthChartInput } from '../../src/flow/natal.js';

const validInput: BirthChartInput = {
  localDate: '2000-01-01',
  localTime: '12:00',
  latitude: 0,
  longitude: 0,
  timeZone: 'UTC',
};

describe('birth input validation and timezone resolution', () => {
  it('accepts real leap days and rejects overflow or out-of-range dates', () => {
    expect(
      validateBirthChartInput({ ...validInput, localDate: '2000-02-29' })
        .localDate,
    ).toBe('2000-02-29');
    expect(() =>
      validateBirthChartInput({ ...validInput, localDate: '2023-02-29' }),
    ).toThrow(BirthValidationError);
    expect(() =>
      validateBirthChartInput({ ...validInput, localDate: '2024-02-30' }),
    ).toThrow(/Birth chart input is invalid \(INVALID_DATE\)/);
    expect(() =>
      validateBirthChartInput({ ...validInput, localDate: '1899-12-31' }),
    ).toThrow(/DATE_OUT_OF_RANGE/);
    expect(() =>
      validateBirthChartInput({ ...validInput, localDate: '2101-01-01' }),
    ).toThrow(/DATE_OUT_OF_RANGE/);
    expect(() =>
      validateBirthChartInput({ ...validInput, localDate: '2100-02-29' }),
    ).toThrow(/INVALID_DATE/);
  });

  it('requires an explicit local time and strict HH:mm format', () => {
    expect(() =>
      validateBirthChartInput({ ...validInput, localTime: undefined }),
    ).toThrow(/TIME_REQUIRED/);
    expect(() =>
      validateBirthChartInput({ ...validInput, localTime: null }),
    ).toThrow(/TIME_REQUIRED/);
    expect(() =>
      validateBirthChartInput({ ...validInput, localTime: '24:00' }),
    ).toThrow(/INVALID_TIME/);
    expect(() =>
      validateBirthChartInput({ ...validInput, localTime: '9:30' }),
    ).toThrow(/INVALID_TIME/);
  });

  it('validates IANA zones, coordinates, optional offsets, and unknown fields', () => {
    expect(() =>
      validateBirthChartInput({ ...validInput, timeZone: 'Not/A_Zone' }),
    ).toThrow(/INVALID_TIME_ZONE/);
    expect(() =>
      validateBirthChartInput({ ...validInput, latitude: 66.01 }),
    ).toThrow(/INVALID_LATITUDE/);
    expect(() =>
      validateBirthChartInput({ ...validInput, latitude: Number.NaN }),
    ).toThrow(/INVALID_LATITUDE/);
    expect(() =>
      validateBirthChartInput({ ...validInput, longitude: 180.01 }),
    ).toThrow(/INVALID_LONGITUDE/);
    expect(() =>
      validateBirthChartInput({
        ...validInput,
        longitude: Number.POSITIVE_INFINITY,
      }),
    ).toThrow(/INVALID_LONGITUDE/);
    expect(() =>
      validateBirthChartInput({ ...validInput, utcOffsetMinutes: 60.5 }),
    ).toThrow(/INVALID_UTC_OFFSET/);
    expect(() =>
      validateBirthChartInput({ ...validInput, utcOffsetMinutes: 900 }),
    ).toThrow(/INVALID_UTC_OFFSET/);
    expect(() =>
      validateBirthChartInput({ ...validInput, city: 'Taipei' }),
    ).toThrow(/INVALID_INPUT/);
  });

  it('rejects a DST gap and requires an offset for a DST overlap in New York', () => {
    const gap = {
      ...validInput,
      localDate: '2024-03-10',
      localTime: '02:30',
      timeZone: 'America/New_York',
    };
    expect(() => resolveBirthTimeToUtc(gap)).toThrow(/NONEXISTENT_LOCAL_TIME/);

    const overlap = {
      ...validInput,
      localDate: '2024-11-03',
      localTime: '01:30',
      timeZone: 'America/New_York',
    };
    expect(() => resolveBirthTimeToUtc(overlap)).toThrow(
      /AMBIGUOUS_LOCAL_TIME/,
    );
    expect(
      resolveBirthTimeToUtc({
        ...overlap,
        utcOffsetMinutes: -240,
      }).toISOString(),
    ).toBe('2024-11-03T05:30:00.000Z');
    expect(
      resolveBirthTimeToUtc({
        ...overlap,
        utcOffsetMinutes: -300,
      }).toISOString(),
    ).toBe('2024-11-03T06:30:00.000Z');
    expect(() =>
      resolveBirthTimeToUtc({ ...overlap, utcOffsetMinutes: -360 }),
    ).toThrow(/UTC_OFFSET_MISMATCH/);
  });

  it('uses the supplied IANA zone instead of the server timezone', () => {
    const utc = resolveBirthTimeToUtc({
      ...validInput,
      localDate: '2024-06-01',
      localTime: '12:00',
    });
    const losAngeles = resolveBirthTimeToUtc({
      ...validInput,
      localDate: '2024-06-01',
      localTime: '12:00',
      timeZone: 'America/Los_Angeles',
    });
    expect(utc.toISOString()).toBe('2024-06-01T12:00:00.000Z');
    expect(losAngeles.toISOString()).toBe('2024-06-01T19:00:00.000Z');
    expect(utc.getTime()).not.toBe(losAngeles.getTime());
  });
});

describe('offline natal chart calculation', () => {
  it('matches J2000 Sun and Moon reference longitudes within one degree', () => {
    const chart = calculateNatalChart(validInput);
    const sun = chart.planets.find((planet) => planet.body === 'Sun');
    const moon = chart.planets.find((planet) => planet.body === 'Moon');

    expect(sun?.longitude).toBeCloseTo(280.4, 0);
    expect(Math.abs((sun?.longitude ?? 0) - 280.4)).toBeLessThanOrEqual(1);
    expect(Math.abs((moon?.longitude ?? 0) - 223.3)).toBeLessThanOrEqual(1);
    expect(chart.method.engineVersion).toBe(ASTRONOMY_ENGINE_VERSION);
    expect(chart.method.coordinates).toBe(
      'geocentric apparent tropical ecliptic-of-date',
    );
  });

  it('returns ten planets, twelve equal cusps, valid houses, and unique major aspects', () => {
    const chart = calculateNatalChart(validInput);
    expect(chart.planets.map((planet) => planet.body)).toEqual([
      'Sun',
      'Moon',
      'Mercury',
      'Venus',
      'Mars',
      'Jupiter',
      'Saturn',
      'Uranus',
      'Neptune',
      'Pluto',
    ]);
    expect(chart.houseCusps).toHaveLength(12);
    expect(chart.houseCusps[0]?.longitude).toBeCloseTo(
      chart.ascendant.longitude,
      10,
    );
    for (let index = 0; index < chart.houseCusps.length; index += 1) {
      const cusp = chart.houseCusps[index];
      if (cusp === undefined) throw new Error('Missing house cusp.');
      expect(cusp.longitude).toBeCloseTo(
        (chart.ascendant.longitude + index * 30) % 360,
        10,
      );
      expect(cusp.longitude).toBeGreaterThanOrEqual(0);
      expect(cusp.longitude).toBeLessThan(360);
    }
    for (const planet of chart.planets) {
      expect(planet.house).toBeGreaterThanOrEqual(1);
      expect(planet.house).toBeLessThanOrEqual(12);
      expect(planet.longitude).toBeGreaterThanOrEqual(0);
      expect(planet.longitude).toBeLessThan(360);
      expect(planet.sign.length).toBeGreaterThan(0);
    }
    const pairs = chart.aspects.map(
      (aspect) => `${aspect.first}/${aspect.second}`,
    );
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(
      chart.aspects.every(
        (aspect) =>
          aspect.orbDegrees >= 0 &&
          aspect.orbDegrees <= 6 &&
          [0, 60, 90, 120, 180].includes(aspect.exactDegrees),
      ),
    ).toBe(true);
    expect(chart.ascendant.longitude).toBeGreaterThanOrEqual(0);
    expect(chart.ascendant.longitude).toBeLessThan(360);
    expect(chart.midheaven.longitude).toBeGreaterThanOrEqual(0);
    expect(chart.midheaven.longitude).toBeLessThan(360);
  });

  it('is deterministic for the same validated input', () => {
    const first = calculateNatalChart(validInput);
    const second = calculateNatalChart({ ...validInput });
    expect(second).toEqual(first);
    expect(first.utcDate).toBe('2000-01-01T12:00:00.000Z');
  });

  it('converts the same local clock reading differently in different zones', () => {
    const utcChart = calculateNatalChart({
      ...validInput,
      localDate: '2024-06-01',
      localTime: '12:00',
    });
    const zoneChart = calculateNatalChart({
      ...validInput,
      localDate: '2024-06-01',
      localTime: '12:00',
      timeZone: 'America/Los_Angeles',
    });
    expect(utcChart.utcDate).toBe('2024-06-01T12:00:00.000Z');
    expect(zoneChart.utcDate).toBe('2024-06-01T19:00:00.000Z');
    expect(utcChart.utcDate).not.toBe(zoneChart.utcDate);
  });

  it('returns only finite numeric values', () => {
    const chart = calculateNatalChart({
      ...validInput,
      localDate: '1990-07-15',
      localTime: '08:45',
      latitude: 65.9,
      longitude: 179.9,
      timeZone: 'Pacific/Fiji',
    });
    const numbers = [
      chart.ascendant.longitude,
      chart.midheaven.longitude,
      ...chart.houseCusps.map((cusp) => cusp.longitude),
      ...chart.planets.flatMap((planet) => [planet.longitude, planet.house]),
      ...chart.aspects.flatMap((aspect) => [
        aspect.exactDegrees,
        aspect.orbDegrees,
      ]),
    ];
    expect(numbers.every(Number.isFinite)).toBe(true);
  });
});
