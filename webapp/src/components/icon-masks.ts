import activityRunningUrl from '../assets/icons/activity-running.svg';
import archiveUrl from '../assets/icons/archive.svg';
import arrowUpUrl from '../assets/icons/arrow-up.svg';
import boltUrl from '../assets/icons/bolt.svg';
import bookmarkUrl from '../assets/icons/bookmark.svg';
import brainUrl from '../assets/icons/brain.svg';
import callUrl from '../assets/icons/call.svg';
import checkCircleUrl from '../assets/icons/check-circle.svg';
import checkUrl from '../assets/icons/check.svg';
import chevronLeftUrl from '../assets/icons/chevron-left.svg';
import chevronRightUrl from '../assets/icons/chevron-right.svg';
import chevronsDownUrl from '../assets/icons/chevrons-down.svg';
import circleUrl from '../assets/icons/circle.svg';
import closeUrl from '../assets/icons/close.svg';
import collapseStripUrl from '../assets/icons/collapse-strip.svg';
import copyUrl from '../assets/icons/copy.svg';
import crosshairUrl from '../assets/icons/crosshair.svg';
import doneUrl from '../assets/icons/done.svg';
import errorUrl from '../assets/icons/error.svg';
import externalUrl from '../assets/icons/external.svg';
import folderUrl from '../assets/icons/folder.svg';
import forkUrl from '../assets/icons/fork.svg';
import globeUrl from '../assets/icons/globe.svg';
import helpCircleUrl from '../assets/icons/help-circle.svg';
import historyUrl from '../assets/icons/history.svg';
import infoUrl from '../assets/icons/info.svg';
import insertDownUrl from '../assets/icons/insert-down.svg';
import linkUrl from '../assets/icons/link.svg';
import pinUrl from '../assets/icons/pin.svg';
import playUrl from '../assets/icons/play.svg';
import plusCircleUrl from '../assets/icons/plus-circle.svg';
import plusUrl from '../assets/icons/plus.svg';
import queueNowUrl from '../assets/icons/queue-now.svg';
import refreshUrl from '../assets/icons/refresh.svg';
import resizeCornerBottomLeftUrl from '../assets/icons/resize-corner-bottom-left.svg';
import saveUrl from '../assets/icons/save.svg';
import scrollDownUrl from '../assets/icons/scroll-down.svg';
import searchUrl from '../assets/icons/search.svg';
import sendUrl from '../assets/icons/send.svg';
import sparklesUrl from '../assets/icons/sparkles.svg';
import stopUrl from '../assets/icons/stop.svg';
import themeDarkUrl from '../assets/icons/theme-dark.svg';
import themeLightUrl from '../assets/icons/theme-light.svg';
import toggleTriangleUrl from '../assets/icons/toggle-triangle.svg';
import toolsUrl from '../assets/icons/tools.svg';
import trashUrl from '../assets/icons/trash.svg';
import uploadCloudUrl from '../assets/icons/upload-cloud.svg';
import usersUrl from '../assets/icons/users.svg';
import warningUrl from '../assets/icons/warning.svg';

const asMaskUrl = (assetUrl: string): string => `url("${assetUrl}")`;

export const ICON_MASK_URLS = {
  toggleTriangle: asMaskUrl(toggleTriangleUrl),
  chevronLeft: asMaskUrl(chevronLeftUrl),
  chevronRight: asMaskUrl(chevronRightUrl),
  chevronsDown: asMaskUrl(chevronsDownUrl),
  plus: asMaskUrl(plusUrl),
  plusCircle: asMaskUrl(plusCircleUrl),
  refresh: asMaskUrl(refreshUrl),
  archive: asMaskUrl(archiveUrl),
  done: asMaskUrl(doneUrl),
  trash: asMaskUrl(trashUrl),
  external: asMaskUrl(externalUrl),
  copy: asMaskUrl(copyUrl),
  fork: asMaskUrl(forkUrl),
  play: asMaskUrl(playUrl),
  stop: asMaskUrl(stopUrl),
  warning: asMaskUrl(warningUrl),
  helpCircle: asMaskUrl(helpCircleUrl),
  history: asMaskUrl(historyUrl),
  activityRunning: asMaskUrl(activityRunningUrl),
  search: asMaskUrl(searchUrl),
  users: asMaskUrl(usersUrl),
  call: asMaskUrl(callUrl),
  tools: asMaskUrl(toolsUrl),
  save: asMaskUrl(saveUrl),
  bookmark: asMaskUrl(bookmarkUrl),
  close: asMaskUrl(closeUrl),
  arrowUp: asMaskUrl(arrowUpUrl),
  link: asMaskUrl(linkUrl),
  crosshair: asMaskUrl(crosshairUrl),
  send: asMaskUrl(sendUrl),
  queueNow: asMaskUrl(queueNowUrl),
  insertDown: asMaskUrl(insertDownUrl),
  uploadCloud: asMaskUrl(uploadCloudUrl),
  collapseStrip: asMaskUrl(collapseStripUrl),
  scrollDown: asMaskUrl(scrollDownUrl),
  folder: asMaskUrl(folderUrl),
  checkCircle: asMaskUrl(checkCircleUrl),
  error: asMaskUrl(errorUrl),
  info: asMaskUrl(infoUrl),
  check: asMaskUrl(checkUrl),
  circle: asMaskUrl(circleUrl),
  pin: asMaskUrl(pinUrl),
  globe: asMaskUrl(globeUrl),
  brain: asMaskUrl(brainUrl),
  bolt: asMaskUrl(boltUrl),
  sparkles: asMaskUrl(sparklesUrl),
  themeDark: asMaskUrl(themeDarkUrl),
  themeLight: asMaskUrl(themeLightUrl),
  resizeCornerBottomLeft: asMaskUrl(resizeCornerBottomLeftUrl),
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
