/**
 * Local-time helpers for the rhythm layer.
 *
 * A person's rhythm is a LOCAL phenomenon: "I work at 23:00" means 23:00 on
 * their wall clock, not UTC. Every bucket in this module is derived from the
 * machine's local timezone (the default interpretation of Date), and no
 * timezone conversion happens anywhere in the analysis layer. The cost is
 * that two machines in different timezones bucket the same ts differently —
 * that is exactly what we want: the portrait describes a life, not a server.
 *
 * Day keys are 'YYYY-MM-DD' strings built from local date parts. They sort
 * lexicographically, so series can be indexed and diffed as plain strings.
 *
 * Day enumeration uses setDate() arithmetic rather than adding 86_400_000 ms,
 * so a DST transition does not shift or duplicate a day.
 */

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Local calendar day of `ts` as 'YYYY-MM-DD'. */
export function localDayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Local hour of day, 0..23. */
export function hourOfDay(ts: number): number {
  return new Date(ts).getHours();
}

/** ISO weekday index: 0 = Monday … 6 = Sunday. */
export function dayOfWeekMondayFirst(ts: number): number {
  return (new Date(ts).getDay() + 6) % 7;
}

/** Epoch ms of 00:00 local on the day containing `ts`. */
export function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Add whole local days, keeping the wall-clock time (DST-safe). */
export function addDays(ts: number, days: number): number {
  const d = new Date(ts);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

/**
 * Every day key from the day containing `startTs` through the day containing
 * `endTs`, inclusive. Returns [] when endTs < startTs. A span of one day
 * yields one key.
 */
export function enumerateDayKeys(startTs: number, endTs: number): string[] {
  if (endTs < startTs) return [];
  const keys: string[] = [];
  const lastDayStart = startOfLocalDay(endTs);
  let cursor = startOfLocalDay(startTs);
  for (;;) {
    keys.push(localDayKey(cursor));
    if (cursor >= lastDayStart) break;
    const next = addDays(cursor, 1);
    if (next <= cursor) break; // arithmetic must always advance; bail if not
    cursor = next;
  }
  return keys;
}

/** Inclusive count of local days between two timestamps. */
export function dayCountInclusive(startTs: number, endTs: number): number {
  return enumerateDayKeys(startTs, endTs).length;
}
