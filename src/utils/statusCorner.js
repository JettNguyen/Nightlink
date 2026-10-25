/**
 * Flags the two iPhone Duo screens whose top corner the header has to fit around.
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
 * on the clock or the camera and deepens the bar to hold that shape. CSS cannot
 * compare an inset to a number, so this measures them and sets the flag on
 * <html>.
 */
const CORNER_ROW_MIN = 70;
const SIDE_COLUMN_MIN = 60;
const FOLDED_MAX_WIDTH = 600;

export default function watchStatusCorner() {
  // Sized by the insets, so the observer fires whenever they change. They are
  // still zero when this first runs at startup, and a change of inset alone
  // fires no resize event.
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;'
    + 'width:calc(1px + env(safe-area-inset-left) + env(safe-area-inset-right));'
    + 'height:calc(1px + env(safe-area-inset-top))';
  document.body.appendChild(probe);

  const check = () => {
    const top = probe.offsetHeight - 1;
    const sides = probe.offsetWidth - 1;
    const root = document.documentElement;
    root.toggleAttribute('data-status-corner', top >= CORNER_ROW_MIN && sides === 0);
    root.toggleAttribute('data-camera-corner',
      top === 0 && sides >= SIDE_COLUMN_MIN && window.innerWidth < FOLDED_MAX_WIDTH);
  };

  new ResizeObserver(check).observe(probe);
  window.addEventListener('resize', check);
}
