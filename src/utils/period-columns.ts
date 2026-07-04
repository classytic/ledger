import type { ComparativeMode, PeriodColumn } from '../types/report.js';
import { civilDateOf } from '@classytic/primitives/timezone';
import { civilPartsOf, endBefore, zonedFirstOfMonth } from './zoned-boundaries.js';

const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

export interface InternalPeriod {
  column: PeriodColumn;
  start: Date;
  end: Date;
}

/** Civil date (`YYYY-MM-DD`) of `d` in the reporting `zone` (default `'UTC'`). */
export function isoDate(d: Date, zone = 'UTC'): string {
  return civilDateOf(d, zone);
}

function maxDate(a: Date, b: Date): Date {
  return a > b ? a : b;
}

function minDate(a: Date, b: Date): Date {
  return a < b ? a : b;
}

function pushClampedPeriod(
  periods: InternalPeriod[],
  column: Omit<PeriodColumn, 'startDate' | 'endDate'>,
  rawStart: Date,
  rawEnd: Date,
  outerStart: Date,
  outerEnd: Date,
  zone: string,
) {
  const start = maxDate(rawStart, outerStart);
  const end = minDate(rawEnd, outerEnd);
  if (start > end) return;

  periods.push({
    column: {
      ...column,
      startDate: isoDate(start, zone),
      endDate: isoDate(end, zone),
    },
    start,
    end,
  });
}

export function buildPeriodColumns(
  outerStart: Date,
  outerEnd: Date,
  comparative: ComparativeMode,
  zone = 'UTC',
): InternalPeriod[] {
  if (!comparative) {
    return [
      {
        column: {
          key: 'total',
          label: `${outerStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: zone })} - ${outerEnd.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: zone })}`,
          startDate: isoDate(outerStart, zone),
          endDate: isoDate(outerEnd, zone),
        },
        start: outerStart,
        end: outerEnd,
      },
    ];
  }

  const periods: InternalPeriod[] = [];
  const s = civilPartsOf(outerStart, zone);
  const e = civilPartsOf(outerEnd, zone);
  const startYear = s.year;
  const startMonth = s.month - 1; // 0-indexed
  const endYear = e.year;
  const endMonth = e.month - 1;

  if (comparative === 'monthly') {
    let y = startYear;
    let m = startMonth;
    while (y < endYear || (y === endYear && m <= endMonth)) {
      pushClampedPeriod(
        periods,
        { key: `${y}-${String(m + 1).padStart(2, '0')}`, label: `${MONTH_LABELS[m]} ${y}` },
        zonedFirstOfMonth(y, m + 1, zone),
        endBefore(zonedFirstOfMonth(y, m + 2, zone)),
        outerStart,
        outerEnd,
        zone,
      );
      m += 1;
      if (m === 12) {
        m = 0;
        y += 1;
      }
    }
  } else {
    let y = startYear;
    let q = Math.floor(startMonth / 3);
    const endQ = Math.floor(endMonth / 3);
    while (y < endYear || (y === endYear && q <= endQ)) {
      pushClampedPeriod(
        periods,
        { key: `${y}-Q${q + 1}`, label: `Q${q + 1} ${y}` },
        zonedFirstOfMonth(y, q * 3 + 1, zone),
        endBefore(zonedFirstOfMonth(y, q * 3 + 4, zone)),
        outerStart,
        outerEnd,
        zone,
      );
      q += 1;
      if (q === 4) {
        q = 0;
        y += 1;
      }
    }
  }

  periods.push({
    column: {
      key: 'total',
      label: `Total ${endYear === startYear ? endYear : `${startYear}-${endYear}`}`,
      startDate: isoDate(outerStart, zone),
      endDate: isoDate(outerEnd, zone),
      isTotal: true,
    },
    start: outerStart,
    end: outerEnd,
  });

  return periods;
}

export function buildAgeBucketColumns(
  buckets: Array<{ label: string }>,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- preserved for future use; aging buckets don't use a fixed date window
  asOfDate: Date,
): PeriodColumn[] {
  // Age buckets represent age windows ('Current', '31-60', '90+') relative to
  // asOfDate, not absolute date ranges. Emit empty startDate/endDate so the
  // wire shape doesn't suggest a meaningful range — consumers rely on
  // `isAgeBucket` + `label` for rendering.
  return buckets.map((bucket) => ({
    key: bucket.label,
    label: bucket.label,
    startDate: '',
    endDate: '',
    isAgeBucket: true,
  }));
}
