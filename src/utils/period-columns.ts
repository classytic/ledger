import type { ComparativeMode, PeriodColumn } from '../types/report.js';

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

export function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function endOfMonth(year: number, month: number): Date {
  return new Date(year, month + 1, 0, 23, 59, 59, 999);
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
) {
  const start = maxDate(rawStart, outerStart);
  const end = minDate(rawEnd, outerEnd);
  if (start > end) return;

  periods.push({
    column: {
      ...column,
      startDate: isoDate(start),
      endDate: isoDate(end),
    },
    start,
    end,
  });
}

export function buildPeriodColumns(
  outerStart: Date,
  outerEnd: Date,
  comparative: ComparativeMode,
): InternalPeriod[] {
  if (!comparative) {
    return [
      {
        column: {
          key: 'total',
          label: `${outerStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${outerEnd.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}`,
          startDate: isoDate(outerStart),
          endDate: isoDate(outerEnd),
        },
        start: outerStart,
        end: outerEnd,
      },
    ];
  }

  const periods: InternalPeriod[] = [];
  const startYear = outerStart.getFullYear();
  const startMonth = outerStart.getMonth();
  const endYear = outerEnd.getFullYear();
  const endMonth = outerEnd.getMonth();

  if (comparative === 'monthly') {
    let y = startYear;
    let m = startMonth;
    while (y < endYear || (y === endYear && m <= endMonth)) {
      pushClampedPeriod(
        periods,
        { key: `${y}-${String(m + 1).padStart(2, '0')}`, label: `${MONTH_LABELS[m]} ${y}` },
        new Date(y, m, 1),
        endOfMonth(y, m),
        outerStart,
        outerEnd,
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
        new Date(y, q * 3, 1),
        endOfMonth(y, q * 3 + 2),
        outerStart,
        outerEnd,
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
      startDate: isoDate(outerStart),
      endDate: isoDate(outerEnd),
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
