'use strict';
/* Line icons drawn on a 24×24 grid, 1.6 stroke, currentColor — black in light mode, white in dark. */

const EX_ICONS = {
  barbell: '<path d="M8 12h8M2.5 12H4M20 12h1.5"/><rect x="4" y="7.5" width="2.6" height="9" rx=".9"/><rect x="17.4" y="7.5" width="2.6" height="9" rx=".9"/><path d="M8 9.5v5M16 9.5v5"/>',
  squat: '<path d="M3 8h18"/><rect x="3.6" y="5.6" width="1.9" height="4.8" rx=".7"/><rect x="18.5" y="5.6" width="1.9" height="4.8" rx=".7"/><circle cx="12" cy="4.6" r="1.6"/><path d="M9 8l3 1.4L15 8M12 9.4v4.6M12 14l-4 1.9 1 5M12 14l4 1.9-1 5"/>',
  bench: '<path d="M3.5 17h13.5M6 17v3.2M15 17v3.2"/><circle cx="5.4" cy="14.4" r="1.5"/><path d="M7.4 14.9H14l3-2 1.4 7.3M10.2 14.9V10.2"/><circle cx="10.2" cy="7.6" r="2.6"/><circle cx="10.2" cy="7.6" r=".7"/>',
  deadlift: '<circle cx="12" cy="4.5" r="1.6"/><path d="M12 6.6V13M12 8l-2.2 6M12 8l2.2 6M12 13l-2 7.5M12 13l2 7.5M3 14h18"/><rect x="3.8" y="11.2" width="2" height="5.6" rx=".7"/><rect x="18.2" y="11.2" width="2" height="5.6" rx=".7"/>',
  press: '<path d="M3 4h18"/><rect x="3.8" y="1.8" width="1.9" height="4.4" rx=".7"/><rect x="18.3" y="1.8" width="1.9" height="4.4" rx=".7"/><circle cx="12" cy="8.2" r="1.5"/><path d="M8.6 4l3.4 6.2L15.4 4M12 10.2v5.3M12 15.5l-2 5.5M12 15.5l2 5.5"/>',
  row: '<circle cx="5.6" cy="7.2" r="1.5"/><path d="M7.4 8.2L15 10.2l-1.2 4.6 1.6 5.7M15 10.2l3 4.2-.8 6.1M9.8 8.8l.2 3.8"/><circle cx="10" cy="15.2" r="2.5"/><circle cx="10" cy="15.2" r=".6"/>',
  dumbbell: '<path d="M9 12h6"/><rect x="6.2" y="7.5" width="2.8" height="9" rx="1"/><rect x="15" y="7.5" width="2.8" height="9" rx="1"/><rect x="3.4" y="9.3" width="2.8" height="5.4" rx="1"/><rect x="17.8" y="9.3" width="2.8" height="5.4" rx="1"/>',
  kettlebell: '<path d="M9 10.2V8a3 3 0 016 0v2.2"/><circle cx="12" cy="14.6" r="5.4"/><path d="M9.4 19.6h5.2"/>',
  machine: '<path d="M3 20.5h17M7 20.5V4.5h4M7 7.2l9.2 3.9M9.5 15.5h5.5M12.2 15.5v5"/><circle cx="17.6" cy="11.8" r="3"/><circle cx="17.6" cy="11.8" r=".7"/>',
  cable: '<path d="M5 21V3h11M3.5 21H20.5"/><circle cx="16" cy="4.8" r="1.6"/><path d="M17.6 4.8v9.4M15.4 14.2h4.4"/><rect x="7" y="11" width="4.6" height="8.4" rx=".7"/><path d="M7 13.8h4.6M7 16.6h4.6"/>',
  pullup: '<path d="M3 3.5h18M9 3.5l1.5 6M15 3.5l-1.5 6M10.5 9.5h3"/><circle cx="12" cy="7.2" r="1.5"/><path d="M12 9.5v6M12 15.5l-1.6 5.5M12 15.5l1.6 5.5"/>',
  dip: '<path d="M3.5 10h4.5M16 10h4.5M5.8 10v10.5M18.2 10v10.5"/><circle cx="12" cy="4.6" r="1.5"/><path d="M8.6 10L10 7h4l1.4 3M12 6.6v7.4M12 14l-1.2 3.8 2.6 2"/>',
  core: '<circle cx="5" cy="10" r="1.5"/><path d="M6.8 11.4L19 14.6M8.5 12v4.6h3M19 14.6v2.6M3 18.6h18"/>',
  cardio: '<path d="M12 20s-7.5-4.6-7.5-10.2A4.2 4.2 0 0112 7.3a4.2 4.2 0 017.5 2.5C19.5 15.4 12 20 12 20z"/><path d="M6.5 12.5h3l1.2-2.2 2 4.2 1.3-2h3.5"/>',
  body: '<circle cx="12" cy="4.8" r="1.8"/><path d="M12 7.4v7M7 10.4l5-1.6 5 1.6M12 14.4l-2.5 6.6M12 14.4l2.5 6.6"/>',
};

const UI_ICONS = {
  chevR: '<path d="M9.5 6l6 6-6 6"/>',
  chevL: '<path d="M15 5l-7 7 7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>',
  video: '<rect x="3" y="6.5" width="12.5" height="11" rx="2.5"/><path d="M15.5 10.5l5-3v9l-5-3z"/>',
  more: '<circle cx="6" cy="12" r=".9" fill="currentColor"/><circle cx="12" cy="12" r=".9" fill="currentColor"/><circle cx="18" cy="12" r=".9" fill="currentColor"/>',
  check: '<path d="M5.5 12.5l4.2 4.2 8.8-9.4"/>',
  timer: '<circle cx="12" cy="13.5" r="7"/><path d="M12 13.5V10M10 3h4"/>',
  search: '<circle cx="10.8" cy="10.8" r="6.3"/><path d="M15.5 15.5l4.5 4.5"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>',
  clock: '<circle cx="12" cy="12" r="8.6"/><path d="M12 7.2V12l3.2 2"/>',
  list: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.8"/>',
  scale: '<rect x="3.5" y="3.5" width="17" height="17" rx="4.5"/><path d="M8.5 10a3.5 3.5 0 017 0M12 10l1.4-2"/>',
  chart: '<path d="M4 19.5h16M6 15.5l4.2-4.2 3 3L19 8.5"/>',
};

function svgIcon(body, size, extra = '') {
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${body}</svg>`;
}
function icon(name, size = 26) { return svgIcon(EX_ICONS[name] || EX_ICONS.barbell, size); }
const I = new Proxy({}, { get: (_, k) => svgIcon(UI_ICONS[k] || '', k === 'chevR' ? 16 : 22) });
