/**
 * Flags the screen shape where the clock sits in a corner of its own row.
 *
 * The open iPhone Duo held upright keeps its clock and signal in the top right
 * corner, yet reserves an 82pt row across the whole width for them, so the
 * header landed in a second row under an almost empty one. No iPhone with a
 * notch or Dynamic Island reserves more than 62pt. CSS cannot compare an
 * inset to a number, so this measures it and sets `data-status-corner` on
 * <html>, and the header moves up into that row (Navigation.css).
 */
const CORNER_ROW_MIN = 70;

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
    const corner = probe.offsetHeight - 1 >= CORNER_ROW_MIN && probe.offsetWidth === 1;
    document.documentElement.toggleAttribute('data-status-corner', corner);
  };

  new ResizeObserver(check).observe(probe);
}
