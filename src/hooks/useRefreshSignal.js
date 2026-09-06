import { useEffect, useRef } from 'react';

export const REFRESH_EVENT = 'nightlink:refresh';

/** Ask every mounted page to re-fetch. Used by pull-to-refresh. */
export const requestRefresh = () => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(REFRESH_EVENT));
};

/**
 * Runs `handler` whenever a refresh is requested.
 *
 * Pull-to-refresh used to call `window.location.reload()`, which on iOS tears
 * the whole app down: blank frame, splash screen, session re-read, every
 * screen's state lost. Pages re-run their own fetches instead, so a pull just
 * updates the data in place the way a native refresh control does.
 */
export default function useRefreshSignal(handler) {
  const handlerRef = useRef(handler);
  useEffect(() => { handlerRef.current = handler; }, [handler]);

  useEffect(() => {
    const onRefresh = () => handlerRef.current?.();
    window.addEventListener(REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(REFRESH_EVENT, onRefresh);
  }, []);
}
