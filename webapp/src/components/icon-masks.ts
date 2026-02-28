const asMaskUrl = (svg: string): string => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;

export const ICON_MASK_URLS = {
  toggleTriangle: asMaskUrl(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 10'><path fill='black' d='M1 1L7 5L1 9Z'/></svg>",
  ),
  chevronLeft: asMaskUrl(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><polyline points='15 18 9 12 15 6' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/></svg>",
  ),
  chevronRight: asMaskUrl(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><polyline points='9 18 15 12 9 6' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/></svg>",
  ),
  chevronsDown: asMaskUrl(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><polyline points='6 8 12 14 18 8' fill='none' stroke='black' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'/><polyline points='6 13 12 19 18 13' fill='none' stroke='black' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'/></svg>",
  ),
  plus: asMaskUrl(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><line x1='12' y1='5' x2='12' y2='19' stroke='black' stroke-width='2' stroke-linecap='round'/><line x1='5' y1='12' x2='19' y2='12' stroke='black' stroke-width='2' stroke-linecap='round'/></svg>",
  ),
  plusCircle: asMaskUrl(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><circle cx='12' cy='12' r='10' fill='none' stroke='black' stroke-width='2'/><line x1='12' y1='8' x2='12' y2='16' stroke='black' stroke-width='2' stroke-linecap='round'/><line x1='8' y1='12' x2='16' y2='12' stroke='black' stroke-width='2' stroke-linecap='round'/></svg>",
  ),
  refresh: asMaskUrl(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><polyline points='1 4 1 10 7 10' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/><polyline points='23 20 23 14 17 14' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/><path d='M20.49 9A9 9 0 0 0 5.64 5.64L1 10' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/><path d='M3.51 15A9 9 0 0 0 18.36 18.36L23 14' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/></svg>",
  ),
  archive: asMaskUrl(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><polyline points='21 8 21 21 3 21 3 8' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/><rect x='1' y='3' width='22' height='5' fill='none' stroke='black' stroke-width='2'/><line x1='10' y1='12' x2='14' y2='12' stroke='black' stroke-width='2' stroke-linecap='round'/></svg>",
  ),
  done: asMaskUrl(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M22 11.08V12a10 10 0 1 1-5.93-9.14' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/><polyline points='22 4 12 14 9 11' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/></svg>",
  ),
  trash: asMaskUrl(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><polyline points='3 6 5 6 21 6' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/><path d='M19 6l-1 14H6L5 6' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/><path d='M10 11v6' fill='none' stroke='black' stroke-width='2' stroke-linecap='round'/><path d='M14 11v6' fill='none' stroke='black' stroke-width='2' stroke-linecap='round'/><path d='M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/></svg>",
  ),
  external: asMaskUrl(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M14 3h7v7' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/><path d='M10 14L21 3' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/><path d='M21 14v7H3V3h7' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/></svg>",
  ),
  copy: asMaskUrl(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><rect x='9' y='9' width='13' height='13' rx='2' ry='2' fill='none' stroke='black' stroke-width='2'/><path d='M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/></svg>",
  ),
  play: asMaskUrl(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M4 3v18l17-9z' fill='black'/></svg>",
  ),
  stop: asMaskUrl(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><rect x='3' y='3' width='18' height='18' rx='2' ry='2' fill='black'/></svg>",
  ),
  warning: asMaskUrl(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M12 2L1 21h22L12 2zM12 8v7M12 19.5h.01' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/></svg>",
  ),
  history: asMaskUrl(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M3 12a9 9 0 1 0 3-6.7' fill='none' stroke='black' stroke-width='1.9' stroke-linecap='round' stroke-linejoin='round'/><polyline points='3 3 3 9 9 9' fill='none' stroke='black' stroke-width='1.9' stroke-linecap='round' stroke-linejoin='round'/><path d='M12 7v5l3 2' fill='none' stroke='black' stroke-width='1.9' stroke-linecap='round' stroke-linejoin='round'/></svg>",
  ),
  activityRunning: asMaskUrl(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><polyline points='22 12 18 12 15 21 9 3 6 12 2 12' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/></svg>",
  ),
  search: asMaskUrl(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><circle cx='11' cy='11' r='8' fill='none' stroke='black' stroke-width='2'/><line x1='21' y1='21' x2='16.65' y2='16.65' stroke='black' stroke-width='2' stroke-linecap='round'/></svg>",
  ),
  users: asMaskUrl(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M17 21v-2a4 4 0 0 0-3-3.87' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/><path d='M7 21v-2a4 4 0 0 1 3-3.87' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/><circle cx='12' cy='7' r='4' fill='none' stroke='black' stroke-width='2'/><path d='M18 8a3 3 0 1 0 0-6' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/><path d='M6 8a3 3 0 1 1 0-6' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/></svg>",
  ),
  tools: asMaskUrl(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M14.7 6.3a4.5 4.5 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4.5 4.5 0 0 0 5.4-5.4l-2.2 2.2-2.2-2.2 2.4-2.4z' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/></svg>",
  ),
  save: asMaskUrl(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/><polyline points='17 21 17 13 7 13 7 21' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/><polyline points='7 3 7 8 15 8' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/></svg>",
  ),
  bookmark: asMaskUrl(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/></svg>",
  ),
  close: asMaskUrl(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><line x1='18' y1='6' x2='6' y2='18' stroke='black' stroke-width='2' stroke-linecap='round'/><line x1='6' y1='6' x2='18' y2='18' stroke='black' stroke-width='2' stroke-linecap='round'/></svg>",
  ),
  arrowUp: asMaskUrl(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M12 19V5' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/><path d='m5 12 7-7 7 7' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/></svg>",
  ),
  link: asMaskUrl(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M10 13a5 5 0 0 1 0-7l1-1a5 5 0 0 1 7 7l-1 1' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/><path d='M14 11a5 5 0 0 1 0 7l-1 1a5 5 0 0 1-7-7l1-1' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/></svg>",
  ),
  crosshair: asMaskUrl(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><circle cx='12' cy='12' r='3' fill='none' stroke='black' stroke-width='2'/><path d='M12 2v3M12 19v3M2 12h3M19 12h3' fill='none' stroke='black' stroke-width='2' stroke-linecap='round'/></svg>",
  ),
  send: asMaskUrl(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M12 2L2 22' fill='none' stroke='black' stroke-width='2'/><path d='M12 2L22 22' fill='none' stroke='black' stroke-width='2'/><line x1='12' y1='2' x2='12' y2='16.8' stroke='black' stroke-width='2'/></svg>",
  ),
  insertDown: asMaskUrl(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><line x1='12' y1='4' x2='12' y2='14' stroke='black' stroke-width='2.8' stroke-linecap='round'/><polyline points='6.5 12.5 12 18 17.5 12.5' fill='none' stroke='black' stroke-width='2.8' stroke-linecap='round' stroke-linejoin='round'/></svg>",
  ),
  uploadCloud: asMaskUrl(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M20 16.5a4.5 4.5 0 0 0-1.9-8.7 6 6 0 0 0-11.7 1.7A4 4 0 0 0 4 16.5' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/><path d='M12 21v-9' fill='none' stroke='black' stroke-width='2' stroke-linecap='round'/><path d='m8 16 4-4 4 4' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/></svg>",
  ),
  collapseStrip: asMaskUrl(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 56 8'><path d='M2 2.2L8 5.8L14 2.2M21 2.2L27 5.8L33 2.2M40 2.2L46 5.8L52 2.2' fill='none' stroke='black' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round'/></svg>",
  ),
  scrollDown: asMaskUrl(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><polyline points='7 10 12 15 17 10' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/></svg>",
  ),
} as const;

export const ICON_MASK_BASE_CSS = `
  .icon-mask {
    display: inline-block;
    width: 14px;
    height: 14px;
    flex: 0 0 auto;
    background-color: currentColor;
    -webkit-mask: var(--icon-mask) no-repeat center / contain;
    mask: var(--icon-mask) no-repeat center / contain;
    pointer-events: none;
  }
`;
