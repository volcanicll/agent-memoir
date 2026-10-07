/**
 * Portrait renderer — Portrait in, a self-contained static site out.
 *
 * Three files are written (index.html, portrait.css, portrait.js) with no
 * network use at any point: the site opens correctly from file:// because the
 * only subresources are the two relative files next to it and the Portrait
 * itself is inlined into the generated script.
 *
 * Why server-rendered SVG instead of a runtime <canvas>: this is a print
 * artifact first. SVG prints at full resolution, keeps every mark in the DOM
 * (so `--dump-dom` and screen readers see the real numbers), and renders
 * even if the script never runs. The class toggle swaps which pre-rendered
 * view is visible — each view has its own field drawn from its own data, so
 * toggling genuinely re-renders the drawing rather than restyling it.
 *
 * Privacy: every path in this file is already redacted by the analysis layer;
 * `assertRedacted` on all three outputs is the net that catches a regression
 * before it reaches disk.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClassFilter } from '../analyze/classify.ts';
import type { ClassView, Portrait } from '../analyze/index.ts';
import type { TermMove, ShareMove } from '../analyze/drift.ts';
import { TERM_RANK_DELTA } from '../analyze/drift.ts';
import { contrasts, type SourceComparison } from '../analyze/compare.ts';
import { UNLOCATED_PROJECT } from '../analyze/projects.ts';
import { assertRedacted } from '../analyze/redact.ts';
import { WEEKDAY_LABELS } from '../analyze/rhythm.ts';

const SITE_DIR = fileURLToPath(new URL('./site/', import.meta.url));

/** Order of the class views on the page; the default is interactive. */
const VIEW_ORDER: readonly ClassFilter[] = ['interactive', 'all', 'automation', 'other'];
const DEFAULT_VIEW: ClassFilter = 'interactive';

// ---------------------------------------------------------------- formatting

function int(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthDay(ts: number): string {
  const d = new Date(ts);
  return `${MONTHS[d.getMonth()] ?? '?'} ${d.getDate()}`;
}

function isoDate(ts: number): string {
  const d = new Date(ts);
  const month = d.getMonth() + 1;
  const day = d.getDate();
  return `${d.getFullYear()}-${month < 10 ? '0' : ''}${month}-${day < 10 ? '0' : ''}${day}`;
}

function hourLabel(hour: number): string {
  return `${hour < 10 ? '0' : ''}${hour}:00`;
}

function pp(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(1)} pp`;
}

function signPct(value: number): string {
  return `${value > 0 ? '+' : ''}${(value * 100).toFixed(0)}%`;
}

function pctOf(part: number, whole: number): string {
  if (whole <= 0) return '0%';
  return `${((part / whole) * 100).toFixed(part / whole < 0.1 ? 1 : 0)}%`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// ------------------------------------------------------------------- the field

/**
 * A shared scale across views, so the interactive field and the automation
 * lane are drawn against the same maximum and can be compared directly:
 * per-view normalisation would make a quiet class look as busy as a loud one.
 */
interface FieldScale {
  maxCell: number;
}

function fieldScale(portrait: Portrait): FieldScale {
  let maxCell = 0;
  for (const cls of VIEW_ORDER) {
    const view = portrait.views[cls];
    for (const row of view.rhythm.hourOfWeek) {
      for (const value of row) if (value > maxCell) maxCell = value;
    }
  }
  return { maxCell: Math.max(maxCell, 1) };
}

function ramp(t: number, hue: number, sat: number, fromL: number, toL: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  const light = fromL + clamped * (toL - fromL);
  return `hsl(${hue} ${sat}% ${light.toFixed(1)}%)`;
}

const CELL = { gutter: 52, rightPad: 14, top: 30, rowH: 40, barMax: 30, width: 1120 };

/**
 * Height for a cell of the hero field.
 *
 * Linear scaling is wrong here for the same reason the linear day series
 * would be: one hot hour on one weekday (several thousand events) is an order
 * of magnitude above a typical cell (a few hundred), so a linear field
 * flattens almost every other mark to a 2px dash and the portrait stops
 * showing shape. sqrt preserves order and makes small counts visible; the
 * figure note states the transform so the height is read as a magnitude, not
 * a literal count. Zero stays zero.
 */
function cellHeight(value: number, max: number, maxPx: number): number {
  if (value <= 0) return 0;
  return Math.max(2, Math.sqrt(value / max) * maxPx);
}

/**
 * The hero: a day-of-week × hour-of-day field. Each cell holds two marks at
 * the same scale and the same baseline — the automation class on the left,
 * the active view on the right. A lane each, rather than one bar overdrawn on
 * the other, because an overlay that is invisible wherever the foreground is
 * taller is decoration; and because keeping the two lanes in fixed positions
 * means the geometry does not jump when the view is toggled, so the eye can
 * compare the same cell across classes.
 *
 * When the active view IS automation the left lane is left empty (the same
 * data would otherwise be drawn twice).
 */
function heroSvg(view: ClassView, ghost: ClassView, scale: FieldScale, label: string, cls: ClassFilter): string {
  const parts: string[] = [];
  const plotW = CELL.width - CELL.gutter - CELL.rightPad;
  const colW = plotW / 24;
  const gap = 3;
  const laneW = Math.max(5, (Math.max(12, colW - 16) - gap) / 2);
  const cellW = laneW * 2 + gap;
  const height = CELL.top + 7 * CELL.rowH + 16;
  const showGhost = cls !== 'automation';

  parts.push(`<svg viewBox="0 0 ${CELL.width} ${height}" role="img" aria-label="${escapeHtml(label)}">`);

  // Baselines and weekday labels.
  for (let row = 0; row < 7; row++) {
    const baseline = CELL.top + row * CELL.rowH + CELL.rowH - 6;
    parts.push(
      `<line x1="${CELL.gutter}" y1="${baseline}" x2="${CELL.width - CELL.rightPad}" y2="${baseline}" stroke="rgba(236,231,220,0.08)" stroke-width="1"/>`,
    );
    parts.push(
      `<text x="${CELL.gutter - 10}" y="${baseline - 8}" text-anchor="end" font-family="var(--mono)" font-size="11" fill="#9d9789" letter-spacing="1.5">${WEEKDAY_LABELS[row]?.toUpperCase() ?? ''}</text>`,
    );
  }

  // Hour ticks.
  for (let hour = 0; hour < 24; hour += 3) {
    const x = CELL.gutter + hour * colW + colW / 2;
    parts.push(
      `<text x="${x.toFixed(1)}" y="${CELL.top - 12}" text-anchor="middle" font-family="var(--mono)" font-size="10" fill="#62646c" letter-spacing="1">${hour < 10 ? `0${hour}` : hour}</text>`,
    );
  }

  const ghostMarks: string[] = [];
  const mainMarks: string[] = [];
  for (let row = 0; row < 7; row++) {
    const viewValues = view.rhythm.hourOfWeek[row] ?? [];
    const ghostValues = ghost.rhythm.hourOfWeek[row] ?? [];
    const baseline = CELL.top + row * CELL.rowH + CELL.rowH - 6;
    for (let hour = 0; hour < 24; hour++) {
      const cellX = CELL.gutter + hour * colW + (colW - cellW) / 2;
      const main = viewValues[hour] ?? 0;
      const machine = showGhost ? ghostValues[hour] ?? 0 : 0;

      if (machine > 0) {
        const h = cellHeight(machine, scale.maxCell, CELL.barMax);
        ghostMarks.push(
          `<rect x="${cellX.toFixed(1)}" y="${(baseline - h).toFixed(1)}" width="${laneW.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="${ramp(machine / scale.maxCell, 199, 45, 22, 52)}"/>`,
        );
      } else if (showGhost) {
        ghostMarks.push(
          `<rect x="${cellX.toFixed(1)}" y="${(baseline - 1.5).toFixed(1)}" width="${laneW.toFixed(1)}" height="1.5" rx="0.75" fill="rgba(236,231,220,0.10)"/>`,
        );
      }

      const mainX = cellX + laneW + gap;
      if (main > 0) {
        const h = cellHeight(main, scale.maxCell, CELL.barMax);
        mainMarks.push(
          `<rect x="${mainX.toFixed(1)}" y="${(baseline - h).toFixed(1)}" width="${laneW.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="${ramp(main / scale.maxCell, 34, 62, 30, 64)}"/>`,
        );
        if (machine > main) {
          // Where the machine outran the person in the same hour, a hairline
          // in the warm lane marks how high the machine went.
          const ghostTop = baseline - cellHeight(machine, scale.maxCell, CELL.barMax);
          mainMarks.push(
            `<line x1="${mainX.toFixed(1)}" y1="${ghostTop.toFixed(1)}" x2="${(mainX + laneW).toFixed(1)}" y2="${ghostTop.toFixed(1)}" stroke="${ramp(machine / scale.maxCell, 199, 45, 30, 58)}" stroke-width="1" stroke-dasharray="2 2"/>`,
          );
        }
      } else {
        mainMarks.push(
          `<rect x="${mainX.toFixed(1)}" y="${(baseline - 1.5).toFixed(1)}" width="${laneW.toFixed(1)}" height="1.5" rx="0.75" fill="rgba(236,231,220,0.10)"/>`,
        );
      }
    }
  }
  if (showGhost) parts.push(`<g class="ghost-layer">${ghostMarks.join('')}</g>`);
  parts.push(mainMarks.join(''));
  parts.push('</svg>');
  return parts.join('');
}

// ------------------------------------------------------------------ sections

/**
 * Chapters 05 and 06: friction and the cross-source comparison.
 *
 * Both are rendered PER VIEW like every other chapter, so the class toggle
 * genuinely re-renders them. Two deliberate choices about what reaches the
 * page:
 *
 *   - Friction shows counts, tool names and redacted path labels only. The
 *     findings' `signature`/`detail.args`/`sessions` fields stay in the
 *     Portrait (they are needed by the local CLI) and are never read here —
 *     that is the phase's privacy rule made structural, not editorial.
 *   - The comparison chapter draws the AUTOMATION-scoped table as well. The
 *     three-agent question spans the whole corpus (a scheduler is part of how
 *     a machine is used), so each row carries its own class mix and the
 *     reader is told plainly when a row is mostly cron.
 */

// ----------------------------------------------------------- chapter 05: friction

/** A labelled count, the only shape friction is allowed to take on the page. */
function metricRow(label: string, value: string, note = ''): string {
  return `<div class="metric"><span class="metric-label">${escapeHtml(label)}</span><span class="metric-value">${value}</span><span class="metric-note">${escapeHtml(note)}</span></div>`;
}

function buildFriction(view: ClassView): string {
  const friction = view.friction;
  const totals = friction.totals;
  const empty =
    totals.repeatedFailureSignatures === 0 &&
    totals.longLoopSessions === 0 &&
    totals.rewrites === 0 &&
    totals.abandonedSessions === 0;
  const head = chapterHead(
    '05',
    'What I keep hitting',
    'repeated failures, grinding loops, rewritten files, dead ends',
    `${escapeHtml(friction.cls)} scope`,
  );
  if (empty) {
    return `<section class="chapter" data-section="friction" data-view="${view.cls}">${head}<p class="empty-note">nothing above threshold in this class</p></section>`;
  }

  const metrics = `<div class="metrics">
    ${metricRow('recurring failure patterns', int(totals.repeatedFailureSignatures), `${int(totals.repeatedFailureOccurrences)} failures`)}
    ${metricRow('sessions with a long loop', int(totals.longLoopSessions), `longest ${int(totals.longLoopMaxPairs)} tool pairs`)}
    ${metricRow('files rewritten in one session', int(totals.rewrites), `${int(totals.rewriteSessions)} sessions`)}
    ${metricRow('abandoned sessions', int(totals.abandonedSessions), 'ended mid-call or on failure')}
  </div>`;

  // Repeated failure patterns: tool names and counts only. The args that make
  // a signature are local-only and deliberately absent from the page.
  const patterns = friction.repeatedFailures.slice(0, 8);
  const patternMax = Math.max(...patterns.map((finding) => finding.count), 1);
  const patternBlock =
    patterns.length === 0
      ? '<p class="empty-note">no failure signature repeated three times</p>'
      : `<div class="bars">${patterns
          .map(
            (finding) =>
              `<div class="bar-row"><span class="label">${escapeHtml(finding.label)}</span><span class="bar-track"><span class="bar-fill machine" style="width:${((finding.count / patternMax) * 100).toFixed(1)}%"></span></span><span class="value">${int(finding.count)}×</span></div>`,
          )
          .join('')}</div>`;

  // Rewrites: redacted path labels, already display-ready from friction.ts.
  const rewrites = friction.revertedWork.slice(0, 6);
  const rewriteBlock =
    rewrites.length === 0
      ? '<p class="empty-note">nothing written twice with different content</p>'
      : `<div class="rewrite-list">${rewrites
          .map((finding) => {
            const writes = Number(finding.detail.writes ?? 0);
            const versions = Number(finding.detail.versions ?? 0);
            return `<div class="rewrite-row"><span class="path" title="${escapeHtml(finding.label)}">${escapeHtml(shortPath(finding.label))}</span><span class="versions">${int(writes)} writes · ${int(versions)} versions${finding.detail.exactRevert === true ? ' · reverted to an earlier content' : ''}</span></div>`;
          })
          .join('')}</div>`;

  return `<section class="chapter" data-section="friction" data-view="${view.cls}">
    ${head}
    <div class="figure-note">counts and identifiers only — the arguments that define a failure pattern never leave the local store</div>
    ${metrics}
    <div class="term-columns" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr);margin-top:30px;">
      <div><h3>Failure patterns that kept repeating</h3>${patternBlock}</div>
      <div><h3>Files written more than once</h3>${rewriteBlock}</div>
    </div>
  </section>`;
}

// --------------------------------------------------- chapter 06: three agents

function shareCell(share: number | null): string {
  return share === null ? '—' : `${(share * 100).toFixed(1)}%`;
}

/** The pre-rendered comparison table for one scope; no runtime drawing. */
function compareTable(rows: readonly SourceComparison[], title: string): string {
  if (rows.length === 0) return `<p class="empty-note">no sources in ${escapeHtml(title)}</p>`;
  const body = rows
    .map((row) => {
      const mix = `i ${int(row.classMix.interactive)} · a ${int(row.classMix.automation)}${row.classMix.other > 0 ? ` · o ${int(row.classMix.other)}` : ''}`;
      const tools = row.toolMix
        .slice(0, 2)
        .map((tool) => `${escapeHtml(tool.name)} ${(tool.share * 100).toFixed(0)}%`)
        .join(' · ');
      const projects =
        row.topProjects
          .filter((project) => project.label !== UNLOCATED_PROJECT)
          .slice(0, 2)
          .map((project) => escapeHtml(shortPath(project.label)))
          .join(', ') || '—';
      // Unlocated sessions are a fact about the source (all of Hermes' 2,887
      // interactive sessions have no cwd), so the count is shown here rather
      // than letting an empty-looking projects column imply they do not exist.
      const unlocated =
        row.unlocatedSessions > 0
          ? `<small class="unlocated">${int(row.unlocatedSessions)} with no cwd</small>`
          : '';
      return `<tr>
        <th scope="row">${escapeHtml(row.source)}<small>${mix}</small></th>
        <td>${int(row.sessions)}</td>
        <td>${int(row.events)}</td>
        <td>${row.medianSessionMinutes === null ? '—' : `${row.medianSessionMinutes.toFixed(1)}m`}</td>
        <td>${row.eventsPerSession === null ? '—' : row.eventsPerSession.toFixed(1)}</td>
        <td>${shareCell(row.reasoningShare)}</td>
        <td>${row.failureRate === null ? '—' : `${shareCell(row.failureRate)}<small>${int(row.failureCount)}/${int(row.resolvedCount)}</small>`}</td>
        <td class="tools">${tools}</td>
        <td class="tools">${projects}${unlocated}</td>
      </tr>`;
    })
    .join('');
  return `<div class="compare-wrap" data-compare="${escapeHtml(title)}">
    <table class="compare">
      <thead><tr>
        <th scope="col">source <small>class mix i/a</small></th>
        <th scope="col">sessions</th><th scope="col">events</th><th scope="col">median</th>
        <th scope="col">ev / session</th><th scope="col">reasoning</th>
        <th scope="col">failures <small>of resolved</small></th>
        <th scope="col">top tools</th><th scope="col">projects</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>
  </div>`;
}

function buildCompare(portrait: Portrait, view: ClassView): string {
  const found = contrasts(portrait.comparison);
  const contrastBlock =
    found.length === 0
      ? '<p class="empty-note">no contrast cleared its threshold</p>'
      : `<ul class="contrasts">${found
          .map((contrast) => {
            const format = (value: number): string => {
              if (contrast.unit === 'share') return `${(value * 100).toFixed(1)}%`;
              if (contrast.unit === 'hour') return `${String(Math.round(value)).padStart(2, '0')}:00`;
              if (contrast.unit === 'minutes') return `${value.toFixed(0)}m`;
              return value.toFixed(1);
            };
            return `<li data-key="${escapeHtml(contrast.key)}">
              <p>${escapeHtml(contrast.statement)}</p>
              <div class="contrast-numbers">
                <span><b>${escapeHtml(contrast.sourceA)}</b> ${escapeHtml(contrast.labelA)} <em>${format(contrast.valueA)}</em></span>
                <span><b>${escapeHtml(contrast.sourceB)}</b> ${escapeHtml(contrast.labelB)} <em>${format(contrast.valueB)}</em></span>
              </div>
            </li>`;
          })
          .join('')}</ul>`;
  return `<section class="chapter" data-section="compare" data-view="${view.cls}">
    ${chapterHead('06', 'Three agents, three styles', 'the same measures, computed identically per source', `${int(portrait.comparison.sources.length)} sources · all classes`)}
    <div class="figure-note">each row covers that source's whole history; the class mix (i = human-driven, a = automation) is shown beside the name so a row that is mostly scheduler is visible as such</div>
    ${compareTable(portrait.comparison.sources, 'all')}
    <div style="margin-top:34px;">${contrastBlock}</div>
  </section>`;
}

function captions(entries: ReadonlyArray<readonly [string, string]>): string {
  return `<div class="captions">${entries
    .map(([label, value]) => `<div class="caption">${escapeHtml(label)}<b>${value}</b></div>`)
    .join('')}</div>`;
}

function chapterHead(num: string, title: string, sub: string, note: string): string {
  return `<header class="chapter-head"><div class="chapter-num">${num}</div><h2>${escapeHtml(title)}<small>${escapeHtml(sub)}</small></h2><div class="chapter-note">${note}</div></header>`;
}

function buildHero(view: ClassView, ghost: ClassView, scale: FieldScale, portraits: Portrait, cls: ClassFilter): string {
  const rhythm = view.rhythm;
  const busiest = rhythm.busiestDay;
  const peak = rhythm.peakHour;
  const captionRow = captions([
    ['active days', `${int(rhythm.activeDays)} <em>/ ${int(rhythm.spanDays)}</em>`],
    ['longest streak', `${int(rhythm.longestStreakDays)} <em>days</em>`],
    ['longest gap', `${int(rhythm.longestGapDays)} <em>days</em>`],
    ['peak hour', peak === null ? '—' : `${hourLabel(peak.hour)} <em>${int(peak.count)} ev</em>`],
    ['busiest day', busiest === null ? '—' : `${escapeHtml(busiest.day)} <em>${int(busiest.count)} ev</em>`],
    ['in this view', `${int(view.events)} <em>events</em>`],
  ]);
  const ghostNote =
    cls === 'automation'
      ? `both lanes are automation — ${int(view.sessions)} scheduled sessions`
      : `<span class="machine">▮</span> left lane = automation · <span class="warm">▮</span> right lane = this view (${escapeHtml(cls)})`;
  return `<section class="chapter hero" data-section="hero" data-view="${cls}">
    ${chapterHead('00', 'The week, in marks', 'every hour of every weekday, from local event counts', `${int(portraits.span.days)} days × 24 hours`)}
    ${heroSvg(view, ghost, scale, `Event counts per weekday and hour for ${cls} sessions`, cls)}
    <p class="figure-note">bar height and colour = events recorded in that hour of that weekday · height is √-scaled (one hot hour would otherwise flatten the field) · both lanes share one scale across all views · ${ghostNote}</p>
    ${captionRow}
  </section>`;
}

function stripBlock(view: ClassView, splitTs: number): string {
  const series = view.rhythm.daySeries;
  if (series.length === 0) return '';
  const first = series[0]?.day ?? '';
  const last = series[series.length - 1]?.day ?? '';
  const max = Math.max(...series.map((point) => point.count), 1);
  const bars = series
    .map((point) => {
      const h = point.count === 0 ? 0 : Math.max(3, Math.round(Math.sqrt(point.count / max) * 100));
      const cls = point.count === 0 ? ' class="zero"' : '';
      const fraction = `${h}%`;
      return `<i${cls} style="height:${point.count === 0 ? '2px' : fraction}" title="${escapeHtml(point.day)}: ${int(point.count)} events"></i>`;
    })
    .join('');
  const splitIndex = series.findIndex((point) => new Date(`${point.day}T23:59:59`).getTime() >= splitTs);
  const splitPct = splitIndex < 0 ? 100 : (splitIndex / series.length) * 100;
  return `<div class="strip-wrap" data-section="days" >
    <div class="strip">${bars}</div>
    <div class="strip-split" style="left:${splitPct.toFixed(2)}%" data-label="drift split"></div>
    <div class="tl-scale"><span>${escapeHtml(first)}</span><span>${escapeHtml(last)}</span></div>
  </div>`;
}

function buildRhythm(view: ClassView, scale: FieldScale, splitTs: number): string {
  const rhythm = view.rhythm;
  const hourMax = Math.max(...rhythm.hourOfDay, 1);
  const weekMax = Math.max(...rhythm.dayOfWeek, 1);
  const hourCols = rhythm.hourOfDay
    .map((count, hour) => {
      const h = count === 0 ? 0 : Math.max(3, Math.round(Math.sqrt(count / hourMax) * 100));
      return `<div class="col" title="${hourLabel(hour)}: ${int(count)} events"><i class="${count === 0 ? 'zero' : ''}" style="height:${count === 0 ? '2px' : `${h}%`};"></i></div>`;
    })
    .join('');
  const weekCols = rhythm.dayOfWeek
    .map((count, index) => {
      const h = count === 0 ? 0 : Math.max(3, Math.round(Math.sqrt(count / weekMax) * 100));
      return `<div class="col" title="${WEEKDAY_LABELS[index]}: ${int(count)} events"><i class="${count === 0 ? 'zero' : ''}" style="height:${count === 0 ? '2px' : `${h}%`};"></i></div>`;
    })
    .join('');

  const starts = rhythm.sessionStartHours;
  const startPeak = starts.indexOf(Math.max(...starts));
  const ends = rhythm.sessionEndHours;
  const endPeak = ends.indexOf(Math.max(...ends));
  const sessionCount = view.sessions;

  return `<section class="chapter" data-section="rhythm" data-view="${view.cls}">
    ${chapterHead('01', 'Rhythm', 'when the work happened, in local time', `${int(rhythm.activeDays)} active of ${int(rhythm.spanDays)} days`)}
    <div class="figure-note">every day of the span, zeros included — quiet stretches stay visible · height √-scaled to the busiest day</div>
    ${stripBlock(view, splitTs)}
    <div class="captions">
      <div class="caption">sessions begin most often<b>${starts[startPeak] === 0 ? '—' : hourLabel(startPeak)}</b></div>
      <div class="caption">sessions end most often<b>${ends[endPeak] === 0 ? '—' : hourLabel(endPeak)}</b></div>
      <div class="caption">sessions in view<b>${int(sessionCount)}</b></div>
    </div>
    <div class="columns" style="margin-top:34px;">${hourCols}</div>
    <div class="axis"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>
    <div class="figure-note">events per hour of day</div>
    <div class="columns weeks" style="margin-top:30px;">${weekCols}</div>
    <div class="axis">${WEEKDAY_LABELS.map((label) => `<span>${label}</span>`).join('')}</div>
    <div class="figure-note">events per weekday</div>
  </section>`;
}

function toolBars(view: ClassView): string {
  const tools = view.vocabulary.topTools.slice(0, 12);
  if (tools.length === 0) return '<p class="empty-note">no tool calls in this class</p>';
  const max = Math.max(...tools.map((tool) => tool.count), 1);
  return `<div class="bars">${tools
    .map(
      (tool) =>
        `<div class="bar-row"><span class="label">${escapeHtml(tool.name)}</span><span class="bar-track"><span class="bar-fill" style="width:${((tool.count / max) * 100).toFixed(1)}%"></span></span><span class="value">${int(tool.count)}</span></div>`,
    )
    .join('')}</div>`;
}

function kindBars(view: ClassView): string {
  const kinds = Object.entries(view.vocabulary.kindCounts).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  if (kinds.length === 0) return '';
  const max = Math.max(...kinds.map(([, count]) => count ?? 0), 1);
  return `<div class="bars">${kinds
    .map(
      ([kind, count]) =>
        `<div class="bar-row"><span class="label">${escapeHtml(kind)}</span><span class="bar-track"><span class="bar-fill dim" style="width:${(((count ?? 0) / max) * 100).toFixed(1)}%"></span></span><span class="value">${int(count ?? 0)}</span></div>`,
    )
    .join('')}</div>`;
}

function wordField(view: ClassView): string {
  const terms = view.vocabulary.topTerms.slice(0, 30);
  if (terms.length === 0) return '<p class="empty-note">no authored text in this class</p>';
  const max = Math.max(...terms.map((term) => term.count), 1);
  return `<div class="words">${terms
    .map((term) => {
      const weight = Math.sqrt(term.count / max);
      const size = (13 + weight * 25).toFixed(1);
      const opacity = (0.55 + weight * 0.45).toFixed(2);
      return `<span class="word" style="font-size:${size}px;opacity:${opacity}" title="${int(term.count)} occurrences">${escapeHtml(term.term)}<sup>${int(term.count)}</sup></span>`;
    })
    .join('')}</div>`;
}

function buildVocabulary(view: ClassView): string {
  const vocab = view.vocabulary;
  return `<section class="chapter" data-section="vocabulary" data-view="${view.cls}">
    ${chapterHead('02', 'Vocabulary', 'what was talked about, after a CJK-aware tokenizer', `${int(vocab.totalTerms)} terms · ${int(vocab.distinctTerms)} distinct`)}
    <div class="figure-note">authored text only (user + assistant messages) — tool output and reasoning are excluded, or the list would summarise terminals instead of work</div>
    ${wordField(view)}
    <div class="term-columns" style="margin-top:36px;grid-template-columns:minmax(0,1fr) minmax(0,1fr);">
      <div>
        <h3>Tools reached for</h3>
        ${toolBars(view)}
      </div>
      <div>
        <h3>Event kinds</h3>
        ${kindBars(view)}
      </div>
    </div>
  </section>`;
}

function buildTimeline(view: ClassView, splitTs: number, span: Portrait['span']): string {
  const projects = view.projects.projects.filter((project) => project.sessions > 0).slice(0, 18);
  if (projects.length === 0) return '<p class="empty-note">no located projects in this class</p>';
  const totalMs = Math.max(1, span.endTs - span.startTs);
  const rows = projects
    .map((project) => {
      const left = ((project.firstTs - span.startTs) / totalMs) * 100;
      const width = Math.max(0.4, ((project.lastTs - project.firstTs) / totalMs) * 100);
      const details = [
        `${int(project.sessions)} ses`,
        `${int(project.events)} ev`,
        project.cwds > 1 ? `${int(project.cwds)} cwds` : null,
        project.topTools[0] === undefined ? null : project.topTools[0].name,
      ]
        .filter((part): part is string => part !== null)
        .join(' · ');
      return `<div class="tl-row" data-project="${escapeHtml(project.name)}">
        <span class="name" title="${escapeHtml(project.root)}">${escapeHtml(project.name)}</span>
        <span class="tl-track"><span class="tl-span" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%"></span></span>
        <span class="when"><i>${monthDay(project.firstTs)} → ${monthDay(project.lastTs)}</i><em>${details}</em></span>
      </div>`;
    })
    .join('');
  const splitPct = ((splitTs - span.startTs) / totalMs) * 100;
  return `<div class="timeline" data-section="timeline">
    <div class="tl-grid" style="position:relative;">
      ${rows}
    </div>
    <div class="tl-scale">
      <span>${isoDate(span.startTs)}</span>
      <span style="color:var(--negative)">▲ drift split ${isoDate(splitTs)}</span>
      <span>${isoDate(span.endTs)}</span>
      <span style="opacity:0.6">split at ${splitPct.toFixed(1)}% of span</span>
    </div>
  </div>`;
}

/**
 * Short display form of a long path label: the last two segments, prefixed
 * with '…/' when anything was dropped. The move chart has no room for a
 * 60-character path, and a project path's distinguishing part is its tail —
 * 'packages/fund-pooling' says more than '~/work…'. The full label stays in
 * the title attribute. (The previous CSS rtl trick reordered the '~/' prefix
 * to the end, which read as a wrong path.)
 */
function shortPath(label: string): string {
  if (label === UNLOCATED_PROJECT || label.length <= 34) return label;
  const parts = label.split('/').filter((part) => part.length > 0);
  if (parts.length <= 2) return label;
  return `…/${parts.slice(-2).join('/')}`;
}

function moveRows(title: string, moves: readonly ShareMove[], kind: 'project' | 'tool'): string {
  if (moves.length === 0) {
    return `<h3>${escapeHtml(title)}</h3><p class="empty-note">no move above threshold</p>`;
  }
  const max = Math.max(...moves.map((move) => Math.max(move.before, move.after)), 0.0001);
  const rows = moves
    .slice(0, kind === 'project' ? 8 : 6)
    .map(
      (move) =>
        `<div class="move-row"><span class="label" title="${escapeHtml(move.label)}">${escapeHtml(shortPath(move.label))}</span><span class="move-pair"><span class="track"><span class="fill before" style="width:${((move.before / max) * 100).toFixed(1)}%"></span></span><span class="track"><span class="fill after ${move.deltaPp < 0 ? 'down' : ''}" style="width:${((move.after / max) * 100).toFixed(1)}%"></span></span></span><span class="delta ${move.deltaPp > 0 ? 'up' : 'down'}">${pp(move.deltaPp)}</span></div>`,
    )
    .join('');
  return `<h3>${escapeHtml(title)}</h3><div class="bars">${rows}</div>`;
}

function termList(title: string, moves: readonly TermMove[], direction: 'up' | 'down', depth: number): string {
  if (moves.length === 0) {
    return `<div><h3>${escapeHtml(title)}</h3><p class="empty-note">nothing cleared the ${TERM_RANK_DELTA}-rank bar</p></div>`;
  }
  // A rank of depth+1 is the clamp for 'outside the measured top N' — show it
  // as 'top 200+' rather than as a literal rank the term never held.
  const rank = (value: number | null): string => {
    if (value === null) return '—';
    return value > depth ? `top ${int(depth)}+` : `#${value}`;
  };
  const items = moves
    .slice(0, 10)
    .map((move) => {
      const traj =
        move.direction === 'new'
          ? `entered ${rank(move.afterRank)} · ${int(move.afterCount)}×`
          : move.direction === 'gone'
            ? `left, was ${rank(move.beforeRank)} · ${int(move.beforeCount)}×`
            : `${rank(move.beforeRank)} → ${rank(move.afterRank)} · ${int(direction === 'up' ? move.afterCount : move.beforeCount)}×`;
      return `<li><span class="term">${escapeHtml(move.term)}</span><span class="traj ${direction === 'up' ? 'up' : 'down'}">${traj}</span></li>`;
    })
    .join('');
  return `<div><h3>${escapeHtml(title)}</h3><ul class="term-list">${items}</ul></div>`;
}

function buildDrift(view: ClassView): string {
  const drift = view.drift;
  if (drift === null) return `<section class="chapter" data-section="drift" data-view="${view.cls}">${chapterHead('04', 'Drift', 'what changed between the halves', '')}<p class="empty-note">no events in this class</p></section>`;
  const head = `<div class="split-head">
      <span>split at <b>${escapeHtml(drift.splitLabel)}</b></span>
      <span>${int(drift.eventsBefore)} events before · ${int(drift.eventsAfter)} after</span>
      <span>${escapeHtml(drift.reason)}</span>
    </div>`;
  if (!drift.enoughData) {
    return `<section class="chapter" data-section="drift" data-view="${view.cls}">${chapterHead('04', 'Drift', 'what changed between the halves', 'insufficient data')}${head}<p class="empty-note">not enough events to compare the halves honestly — reporting nothing rather than noise</p></section>`;
  }
  const length = drift.medianSessionMinutes;
  const hourMoves = drift.hourMoves.length
    ? `<h3>Hours that moved</h3><div class="bars">${drift.hourMoves
        .map(
          (move) =>
            `<div class="move-row"><span class="label">${hourLabel(move.hour)}</span><span class="move-pair"><span class="track"><span class="fill before" style="width:${(move.before * 100 * 4).toFixed(1)}%"></span></span><span class="track"><span class="fill after ${move.deltaPp < 0 ? 'down' : ''}" style="width:${(move.after * 100 * 4).toFixed(1)}%"></span></span></span><span class="delta ${move.deltaPp > 0 ? 'up' : 'down'}">${pp(move.deltaPp)}</span></div>`,
        )
        .join('')}</div>`
    : '';
  return `<section class="chapter" data-section="drift" data-view="${view.cls}">
    ${chapterHead('04', 'Drift', 'what changed between the halves', `${int(drift.eventsBefore + drift.eventsAfter)} events compared`)}
    ${head}
    ${captions([['median session, before', `${length.before === null ? '—' : `${length.before.toFixed(0)}m`}`], ['median session, after', `${length.after === null ? '—' : `${length.after.toFixed(0)}m`}`], ['change', `${length.deltaPct === null ? '—' : signPct(length.deltaPct)}`]])}
    <div style="margin-top:30px;">${moveRows('Projects that moved', drift.projectMoves, 'project')}</div>
    <div style="margin-top:26px;">${moveRows('Tools that moved', drift.toolMoves, 'tool')}</div>
    <div class="term-columns">
      ${termList('Terms rising', drift.risingTerms, 'up', drift.termDepth)}
      ${termList('Terms falling', drift.fallingTerms, 'down', drift.termDepth)}
    </div>
    ${hourMoves}
  </section>`;
}

// -------------------------------------------------------------------- page

function ledger(portrait: Portrait): string {
  const { byClass } = portrait.totals;
  const sessions = Math.max(portrait.totals.sessions, 1);
  const events = Math.max(portrait.totals.events, 1);
  const automationShare = byClass.automation.sessions / sessions;
  const ledgerBar = (['interactive', 'automation', 'other'] as const)
    .map((cls) => `<span class="${cls}" style="width:${((byClass[cls].sessions / sessions) * 100).toFixed(2)}%" title="${cls}: ${int(byClass[cls].sessions)} sessions"></span>`)
    .join('');
  const legend = (['interactive', 'automation', 'other'] as const)
    .map(
      (cls) =>
        `<span><i class="swatch ${cls}"></i><b>${cls}</b> ${int(byClass[cls].sessions)} sessions · ${int(byClass[cls].events)} events · ${pctOf(byClass[cls].sessions, sessions)}</span>`,
    )
    .join('');
  return `<div class="ledger" data-section="ledger">
    <div>
      <div class="ledger-bar">${ledgerBar}</div>
      <div class="ledger-legend">${legend}</div>
    </div>
    <div class="verdict">${(automationShare * 100).toFixed(0)}% of sessions are machine-driven.<br/>This portrait defaults to the other ${pctOf(byClass.interactive.sessions, sessions)} — what a person chose to do. ${int(events)} events in total.</div>
  </div>`;
}

function origins(portrait: Portrait): string {
  const sources = portrait.sources
    .map((source) => `<span><b>${escapeHtml(source.source)}</b> ${int(source.sessions)} ses · ${int(source.events)} ev</span>`)
    .join('');
  // Only the non-adapter origins: Hermes channels are where its sessions
  // actually came from, and repeating 'codex'/'claude-code' here (the label
  // equals the adapter for those) would print the same fact twice in two
  // different shapes.
  const adapterIds = new Set(portrait.sources.map((source) => source.source));
  const channels = portrait.labels
    .filter((label) => label.source === 'hermes' || !adapterIds.has(label.label))
    .map((label) => `<span>${escapeHtml(label.label)} <b>${int(label.sessions)}</b></span>`)
    .join('');
  return `<div class="ledger-legend" style="margin:16px 0 0;gap:16px 26px;" data-section="origins">
    <span style="color:var(--ink-faint);letter-spacing:0.16em;text-transform:uppercase;">adapters</span>${sources}
    <span style="color:var(--ink-faint);letter-spacing:0.16em;text-transform:uppercase;">hermes channels</span>${channels}
  </div>`;
}

function buildView(portrait: Portrait, cls: ClassFilter, scale: FieldScale, hidden: boolean): string {
  const view = portrait.views[cls];
  const ghost = portrait.views.automation;
  const splitTs = view.drift?.splitTs ?? portrait.span.startTs + (portrait.span.endTs - portrait.span.startTs) / 2;
  return `<section class="view" data-view="${cls}" data-events="${view.events}" data-sessions="${view.sessions}" ${hidden ? 'hidden' : ''}>
    ${buildHero(view, ghost, scale, portrait, cls)}
    ${buildRhythm(view, scale, splitTs)}
    ${buildVocabulary(view)}
    <section class="chapter" data-section="projects" data-view="${cls}">
      ${chapterHead('03', 'Projects', 'where the work happened, home redacted to ~', `${int(view.projects.projects.length)} groups · ${int(view.projects.unlocatedSessions)} sessions with no cwd`)}
      ${buildTimeline(view, splitTs, portrait.span)}
      <div class="figure-note">line = first to last event seen in that project · unlocated sessions are kept as their own group, never dropped</div>
    </section>
    ${buildDrift(view)}
    ${buildFriction(view)}
    ${buildCompare(portrait, view)}
  </section>`;
}

export function renderPortraitHtml(portrait: Portrait): string {
  const scale = fieldScale(portrait);
  const startYear = new Date(portrait.span.startTs).getFullYear();
  const endYear = new Date(portrait.span.endTs).getFullYear();
  const sameYear = startYear === endYear;
  const title = `${monthDay(portrait.span.startTs)} – ${monthDay(portrait.span.endTs)}${sameYear ? `, ${endYear}` : ` ${startYear} – ${endYear}`}`;
  const { byClass } = portrait.totals;
  const views = VIEW_ORDER.filter((cls) => cls !== 'other' || byClass.other.sessions > 0);
  const buttons = views
    .map(
      (cls) =>
        `<button type="button" data-target="${cls}" aria-pressed="${cls === DEFAULT_VIEW ? 'true' : 'false'}">${cls === 'interactive' ? 'human-driven' : cls === 'all' ? 'everything' : cls}</button>`,
    )
    .join('');
  const body = views.map((cls) => buildView(portrait, cls, scale, cls !== DEFAULT_VIEW)).join('');

  return `<!doctype html>
<html lang="en" data-active-view="${DEFAULT_VIEW}">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Agent Memoir — ${escapeHtml(title)}</title>
<meta name="description" content="A portrait of local agent working history: rhythm, vocabulary, projects, drift."/>
<link rel="stylesheet" href="portrait.css"/>
</head>
<body data-view="${DEFAULT_VIEW}">
<div class="page">
  <header class="masthead">
    <div class="eyebrow">Agent Memoir · a portrait in local history</div>
    <h1>${escapeHtml(monthDay(portrait.span.startTs))} <span class="em">–</span> ${escapeHtml(monthDay(portrait.span.endTs))}<span class="em">, ${sameYear ? endYear : `${startYear}–${endYear}`}</span></h1>
    <p class="lede"><strong>${int(portrait.totals.events)} events</strong> across <strong>${int(portrait.totals.sessions)} sessions</strong> in <strong>${int(portrait.span.days)} days</strong> — everything three agents on this machine recorded, reduced to rhythm, words, places, and change.</p>
    ${ledger(portrait)}
    ${origins(portrait)}
  </header>

  <nav class="controls" data-section="controls">
    <div class="segmented" role="group" aria-label="Session class">${buttons}</div>
    <label class="ghost-toggle" id="ghost-wrap"><input type="checkbox" id="ghost-toggle" checked/> automation lane</label>
    <div class="note"><span id="view-live"></span> · <span id="view-cls"></span></div>
  </nav>

  ${body}

  <footer>
    <span>generated ${escapeHtml(isoDate(portrait.generatedAt))} from local histories · read-only</span>
    <span>no conversation text, no session ids, no home paths — <span id="footer-view">default view: human-driven</span></span>
  </footer>
</div>
<script src="portrait.js"></script>
</body>
</html>
`;
}

/** Serialize the Portrait for inlining into the generated script. */
function inlineData(portrait: Portrait): string {
  // `</` would end the surrounding script element, and U+2028/U+2029 are
  // illegal in JS string literals before ES2019 — escape all three.
  return JSON.stringify(portrait)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

/**
 * Write the site. Returns the absolute paths written, index.html first.
 * The caller is expected to have a Portrait built by analyzeAll; nothing here
 * reads the store.
 */
export async function renderPortrait(portrait: Portrait, outDir: string): Promise<string[]> {
  const html = renderPortraitHtml(portrait);
  const css = readFileSync(join(SITE_DIR, 'portrait.css'), 'utf8');
  const jsTemplate = readFileSync(join(SITE_DIR, 'portrait.js'), 'utf8');
  const marker = '/*__PORTRAIT_JSON__*/ null';
  if (!jsTemplate.includes(marker)) {
    throw new Error('portrait.js is missing the data marker; the renderer cannot inline the Portrait');
  }
  const js = jsTemplate.replace(marker, inlineData(portrait));

  // The last line of defense: nothing with a home path may reach disk.
  assertRedacted(html, 'renderPortrait(index.html)');
  assertRedacted(css, 'renderPortrait(portrait.css)');
  assertRedacted(js, 'renderPortrait(portrait.js)');

  mkdirSync(outDir, { recursive: true });
  const htmlPath = join(outDir, 'index.html');
  const cssPath = join(outDir, 'portrait.css');
  const jsPath = join(outDir, 'portrait.js');
  writeFileSync(htmlPath, html, 'utf8');
  writeFileSync(cssPath, css, 'utf8');
  writeFileSync(jsPath, js, 'utf8');
  return [htmlPath, cssPath, jsPath];
}
