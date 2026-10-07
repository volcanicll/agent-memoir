/* Agent Memoir portrait runtime — the entire client-side script.
 *
 * Deliberately tiny and dependency-free: the page is server-rendered, so this
 * file exists only to (a) switch between the three pre-rendered class views,
 * (b) keep the header's live numbers and the SVG scale note in sync with the
 * active view, and (c) honour the automation-ghost toggle. The data it reads
 * is the same Portrait the renderer used; it is inlined by the renderer in
 * the const below (no fetch, no XHR — the site must open from file://).
 */

const MEMOIR = /*__PORTRAIT_JSON__*/ null;

(function () {
  'use strict';

  const root = document.documentElement;
  const views = document.querySelectorAll('section.view');

  function human(n) {
    return typeof n === 'number' ? n.toLocaleString('en-US') : '—';
  }

  function setView(cls) {
    if (MEMOIR === null || MEMOIR.views[cls] === undefined) return;
    const view = MEMOIR.views[cls];

    root.dataset.activeView = cls;
    document.body.dataset.view = cls;

    for (const section of views) {
      section.hidden = section.dataset.view !== cls;
    }
    for (const button of document.querySelectorAll('button[data-target]')) {
      const active = button.dataset.target === cls;
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }

    // Live numbers in the header, straight from the inlined Portrait.
    const live = document.getElementById('view-live');
    if (live !== null) {
      live.textContent = human(view.events) + ' events · ' + human(view.sessions) + ' sessions';
    }
    const cls_ = document.getElementById('view-cls');
    if (cls_ !== null) {
      cls_.textContent = cls === 'all' ? 'all sessions' : cls + ' only';
    }
    // The automation ghost only makes sense while a different class is shown.
    const ghostWrap = document.getElementById('ghost-wrap');
    if (ghostWrap !== null) ghostWrap.hidden = cls === 'automation';
  }

  for (const button of document.querySelectorAll('button[data-target]')) {
    button.addEventListener('click', function () {
      setView(button.dataset.target);
    });
  }
  const ghost = document.getElementById('ghost-toggle');
  if (ghost !== null) {
    ghost.addEventListener('change', function () {
      document.body.classList.toggle('hide-ghost', !ghost.checked);
    });
  }
  setView('interactive');
})();
