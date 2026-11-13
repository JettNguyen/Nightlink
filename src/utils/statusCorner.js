/**
 * Flags the screens whose top edge the header has to fit around.
 *
 * `data-status-corner`: the open Duo held upright keeps its clock and signal in
 * the top right corner, yet reserves an 82pt row across the whole width for
 * them, so the header landed in a second row under an almost empty one. No
 * iPhone with a notch or Dynamic Island reserves more than 62pt.
 *
 * `data-camera-corner`: the folded Duo runs its clock down a column on the
 * right and reports no top inset, but its camera sits at the top of that
 * column, level with the header and lower than the bar's middle.
 *
 * In both, the system draws a dark shape behind the corner that reaches the
 * header's bottom line and breaks it. Navigation.css centers the header's row
 * on the clock or the camera and deepens the bar to hold that shape.
 *
 * `data-tab-row`: on an iPad, the tab bar floats in a row of its own across the
 * top of the screen, and the top inset grows to hold it: 96pt on iPadOS 27,
 * where the status bar alone is 32pt. That row has room on either side of the
 * tabs, so the header moves up into it, the way a native iPad screen puts its
 * back button and title beside the tabs, rather than stacking a second bar
 * under them. This used to pass for the Duo's clock row, which pulled the
 * header up under the tabs with the logo hidden behind them. When the window is
 * too narrow for that row, iPadOS puts the tabs back at the bottom, the inset
 * drops to the status bar, and the header is the phone's again. A sheet hides
 * the tabs while it is open, which drops the inset too; the row is kept then,
 * at the inset it had, so the page behind the sheet does not jump.
 *
 * `data-tabs-beside-clock`: held sideways, iPadOS 27 lifts the tabs up into the
 * clock's row and the inset shrinks to 74pt. Level with the tabs, the name
 * would sit on the time, so the header's own row goes under the clock instead.
 *
 * CSS cannot compare an inset to a number, so this measures them and sets the
 * flags on <html>.
 */
const CORNER_ROW_MIN = 70;
const SIDE_COLUMN_MIN = 60;
const FOLDED_MAX_WIDTH = 600;
// The tab row under the clock is 96pt deep on iPadOS 27, beside it 74pt.
const TABS_UNDER_CLOCK_MIN = 90;

/**
 * Which flags a screen gets, from its insets and width in CSS pixels.
 * `tabsCovered` is whether a sheet is hiding the tabs, and `keptInset` the
 * tab row's inset from before, if there was one. `rowInset` is the inset the
 * tab row is laid out for.
 */
export function cornerFlags({ top, sides, width, ipad = false, tabsCovered = false, keptInset = 0 }) {
  if (ipad) {
    let inset = 0;
    if (top >= CORNER_ROW_MIN) inset = top;
    else if (tabsCovered && keptInset >= CORNER_ROW_MIN) inset = keptInset;
    return {
      statusCorner: false,
      cameraCorner: false,
      tabRow: inset > 0,
      tabsBesideClock: inset > 0 && inset < TABS_UNDER_CLOCK_MIN,
      rowInset: inset,
    };
  }
  return {
    statusCorner: top >= CORNER_ROW_MIN && sides === 0,
    cameraCorner: top === 0 && sides >= SIDE_COLUMN_MIN && width < FOLDED_MAX_WIDTH,
    tabRow: false,
    tabsBesideClock: false,
    rowInset: 0,
  };
}

/**
 * `tabsCovered` is a function that says whether a sheet is hiding the native
 * tabs (nativeTabs.js), so the tab row can outlast the inset it had.
 */
export default function watchStatusCorner({ ipad = false, tabsCovered = () => false } = {}) {
  // Sized by the insets, so the observer fires whenever they change. They are
  // still zero when this first runs at startup, and a change of inset alone
  // fires no resize event.
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;'
    + 'width:calc(1px + env(safe-area-inset-left) + env(safe-area-inset-right));'
    + 'height:calc(1px + env(safe-area-inset-top))';
  document.body.appendChild(probe);

  const check = () => {
    const root = document.documentElement;
    const flags = cornerFlags({
      top: probe.offsetHeight - 1,
      sides: probe.offsetWidth - 1,
      width: window.innerWidth,
      ipad,
      tabsCovered: tabsCovered(),
      keptInset: parseFloat(root.style.getPropertyValue('--tab-row-inset')) || 0,
    });
    root.toggleAttribute('data-status-corner', flags.statusCorner);
    root.toggleAttribute('data-camera-corner', flags.cameraCorner);
    root.toggleAttribute('data-tab-row', flags.tabRow);
    root.toggleAttribute('data-tabs-beside-clock', flags.tabsBesideClock);
    // The tab row's depth, for ipad.css.
    if (flags.tabRow) root.style.setProperty('--tab-row-inset', `${flags.rowInset}px`);
    else root.style.removeProperty('--tab-row-inset');
  };

  new ResizeObserver(check).observe(probe);
  window.addEventListener('resize', check);
}
