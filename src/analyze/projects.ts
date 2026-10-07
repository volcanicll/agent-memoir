/**
 * Projects — the *where* of the portrait.
 *
 * A "project" is a cwd (or a stable ancestor of it): sessions whose cwd is a
 * descendant of a project root fold into that root. Folding is what keeps
 * `repo/packages/a` and `repo/packages/b` from being two unrelated projects
 * when the cwd texts alone suggest a monorepo: the root is the longest common
 * ancestor of at least MIN_SESSIONS_FOR_ROOT sessions.
 *
 * Measured on this machine the two evidence bases differ sharply: Claude Code
 * and Codex always carry refs.cwd, Hermes almost never does (2,895 of 2,898
 * sessions have none). Sessions without a cwd are returned as an explicit
 * "no project" bucket, NEVER dropped: for interactive class the unlocated
 * share is a real fact about the data, and hiding it would overstate how
 * precisely the portrait knows where work happened.
 *
 * Redaction happens HERE, at the boundary: the Session keeps raw cwd (local,
 * never rendered), and everything in Project is display-ready. The rendered
 * site and the export only ever see redacted strings.
 */

import { matchesClassFilter, type ClassFilter } from './classify.ts';
import type { Session } from './session.ts';
import { redactHome } from './redact.ts';
import { localDayKey } from './time.ts';
import { topEntries } from './vocabulary.ts';

/**
 * A cwd ancestor must be shared by at least this many sessions to become a
 * project root. 2 is the smallest number that can express "recurring"; 1
 * would make every session its own project and the folder tree would lose
 * its meaning.
 */
export const MIN_SESSIONS_FOR_ROOT = 2;

/** Sessions with no cwd are shown under this label, never omitted. */
export const UNLOCATED_PROJECT = '(no project recorded)';

export interface Project {
  /** Redacted root path, display-ready. '~/codespace/agent-memoir'. */
  readonly root: string;
  /** The root's last segment, redacted. 'agent-memoir'. */
  readonly name: string;
  /** How many distinct raw cwds folded into this root. */
  readonly cwds: number;
  readonly sessions: number;
  readonly events: number;
  readonly firstTs: number;
  readonly lastTs: number;
  readonly activeDays: number;
  readonly topTools: ReadonlyArray<{ name: string; count: number }>;
  readonly model: string | null;
  /** True for the bucket holding sessions with no recorded cwd. */
  readonly unlocated: boolean;
}

export interface Projects {
  readonly projects: readonly Project[];
  readonly unlocatedSessions: number;
  readonly totalSessions: number;
  readonly locatedSessions: number;
}

/**
 * Map every cwd to its project root: a cwd with >= MIN_SESSIONS_FOR_ROOT
 * sessions is its own root; anything else attaches to the longest present
 * root that is an ancestor of it, or stands alone.
 *
 * Drift reuses this so both views cut the tree the same way.
 */
export function projectRootMap(cwdsToSessionCount: ReadonlyMap<string, number>): Map<string, string> {
  const frequent = [...cwdsToSessionCount.entries()]
    .filter(([, count]) => count >= MIN_SESSIONS_FOR_ROOT)
    .map(([cwd]) => cwd)
    .sort();

  const roots = new Map<string, string>();
  for (const cwd of cwdsToSessionCount.keys()) {
    let best = '';
    for (const candidate of frequent) {
      if (cwd === candidate || cwd.startsWith(`${candidate}/`)) {
        if (candidate.length > best.length) best = candidate;
      }
    }
    roots.set(cwd, best.length > 0 ? best : cwd);
  }
  return roots;
}

/** Count sessions per raw cwd across the given sessions. */
export function cwdSessionCounts(sessions: readonly Session[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    if (session.cwd === undefined) continue;
    counts.set(session.cwd, (counts.get(session.cwd) ?? 0) + 1);
  }
  return counts;
}

/** Group the located sessions by their derived root. */
export function groupSessionsByRoot(sessions: readonly Session[]): Map<string, Session[]> {
  const rootMap = projectRootMap(cwdSessionCounts(sessions));
  const groups = new Map<string, Session[]>();
  for (const session of sessions) {
    if (session.cwd === undefined) continue;
    const root = rootMap.get(session.cwd) ?? session.cwd;
    const list = groups.get(root);
    if (list === undefined) groups.set(root, [session]);
    else list.push(session);
  }
  return groups;
}

function lastSegment(path: string): string {
  const parts = path.split('/').filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? path;
}

interface ProjectStats {
  tools: Map<string, number>;
  models: Map<string, number>;
  days: Set<string>;
  events: number;
  firstTs: number;
  lastTs: number;
}

function emptyStats(): ProjectStats {
  return {
    tools: new Map(),
    models: new Map(),
    days: new Set(),
    events: 0,
    firstTs: Number.POSITIVE_INFINITY,
    lastTs: 0,
  };
}

function accumulate(stats: ProjectStats, session: Session): void {
  stats.events += session.eventCount;
  if (session.startTs < stats.firstTs) stats.firstTs = session.startTs;
  if (session.endTs > stats.lastTs) stats.lastTs = session.endTs;
  if (session.model !== undefined) stats.models.set(session.model, (stats.models.get(session.model) ?? 0) + 1);
  for (const event of session.events) {
    stats.days.add(localDayKey(event.ts));
    if (event.kind === 'tool_call' && event.tool !== undefined && event.tool.name.length > 0) {
      stats.tools.set(event.tool.name, (stats.tools.get(event.tool.name) ?? 0) + 1);
    }
  }
}

function toProject(root: string, cwds: number, sessions: number, stats: ProjectStats, unlocated: boolean): Project {
  const redacted = redactHome(root);
  return {
    root: redacted,
    name: unlocated ? UNLOCATED_PROJECT : lastSegment(redacted),
    cwds,
    sessions,
    events: stats.events,
    firstTs: Number.isFinite(stats.firstTs) ? stats.firstTs : 0,
    lastTs: stats.lastTs,
    activeDays: stats.days.size,
    topTools: topEntries(stats.tools, 5).map(([name, count]) => ({ name, count })),
    model: topEntries(stats.models, 1)[0]?.[0] ?? null,
    unlocated,
  };
}

export function computeProjects(sessions: readonly Session[], filter: ClassFilter): Projects {
  const selected = sessions.filter((session) => matchesClassFilter(session.cls, filter));
  const located = selected.filter((session) => session.cwd !== undefined);
  const projects: Project[] = [];

  for (const [root, group] of groupSessionsByRoot(located)) {
    const stats = emptyStats();
    const cwds = new Set<string>();
    for (const session of group) {
      accumulate(stats, session);
      if (session.cwd !== undefined) cwds.add(session.cwd);
    }
    projects.push(toProject(root, cwds.size, group.length, stats, false));
  }

  projects.sort((a, b) => b.events - a.events || a.root.localeCompare(b.root));

  const unlocated = selected.filter((session) => session.cwd === undefined);
  if (unlocated.length > 0) {
    // The bucket is a real group with real activity — it reports its own
    // events and days rather than zeros, so the page never implies that
    // unlocated work did not happen.
    const stats = emptyStats();
    for (const session of unlocated) accumulate(stats, session);
    projects.push(toProject(UNLOCATED_PROJECT, 0, unlocated.length, stats, true));
  }

  return {
    projects,
    unlocatedSessions: unlocated.length,
    totalSessions: selected.length,
    locatedSessions: located.length,
  };
}
