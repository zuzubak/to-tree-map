/* The mobile bottom sheet, shared by every map page on this site.
 *
 * On desktop the filter panel is a plain sidebar and this does almost nothing. On a
 * narrow viewport it becomes a draggable sheet with three snap states -- minimized
 * (just the handle), collapsed (the default peek) and expanded (full access) -- so a
 * drag downward from the default has somewhere smaller to land instead of springing
 * back.
 *
 * Taps use a native "click" listener rather than measuring pointer movement: browsers
 * already suppress click after a real drag, which is a far more reliable tap/drag
 * distinction on touch hardware than a hand-rolled pixel threshold.
 *
 * The heights come from window.innerHeight, not CSS vh: on mobile browsers vh is pinned
 * to the LARGEST viewport (as if the address bar were hidden), so a vh-sized sheet
 * overflows the real viewport whenever the address bar is showing.
 *
 * Expects the markup in .panel-handle-row: #panel, #panel-toggle, #panel-hide.
 * Pass onResize to re-measure whatever is sharing the viewport (a Leaflet map, a
 * canvas overlay) once the sheet has settled.
 */
(function (global) {
  "use strict";

  const MINIMIZED_PX = 56;
  const COLLAPSED_VH = 0.42;
  const EXPANDED_VH = 0.82;
  const MOVE_THRESHOLD = 6;

  function setup({ onResize = () => {} } = {}) {
    const panel = document.getElementById("panel");
    const toggle = document.getElementById("panel-toggle");
    const hideBtn = document.getElementById("panel-hide");
    if (!panel || !toggle) return null;
    const isMobile = () => global.matchMedia("(max-width: 860px)").matches;

    function targetHeight(state) {
      // innerHeight tracks the real visible viewport, unlike CSS vh on mobile, so it
      // is the source of truth for how tall the sheet should be.
      const vh = global.innerHeight;
      if (state === "minimized") return MINIMIZED_PX;
      if (state === "expanded") return vh * EXPANDED_VH;
      return vh * COLLAPSED_VH;
    }

    function setState(state) {
      panel.dataset.state = state;
      toggle.setAttribute("aria-expanded", String(state === "expanded"));
      // Desktop's sidebar is full-height CSS, not state-driven -- an inline max-height
      // would clamp it regardless of viewport width (inline styles aren't scoped by
      // media query), so only touch it on mobile.
      if (isMobile() && !panel.classList.contains("dragging")) {
        panel.style.maxHeight = `${targetHeight(state)}px`;
      } else if (!isMobile()) {
        panel.style.maxHeight = "";
      }
      onResize();
    }

    setState("collapsed");
    global.addEventListener("resize", () => {
      if (!panel.classList.contains("dragging")) setState(panel.dataset.state);
    });
    if (hideBtn) hideBtn.addEventListener("click", () => setState("minimized"));

    let dragging = false;
    let startY = 0;
    let startHeight = 0;
    let moved = false;
    let lastHeight = 0;
    // Touch input suppresses the click that would otherwise follow a drag; a mouse does
    // not, so a drag with one (a narrow desktop window) would snap the sheet and then
    // immediately toggle it back. Swallow exactly one click after a real drag.
    let swallowClick = false;

    toggle.addEventListener("pointerdown", (e) => {
      if (!isMobile()) return;
      dragging = true;
      moved = false;
      startY = e.clientY;
      startHeight = panel.getBoundingClientRect().height;
      lastHeight = startHeight;
      panel.classList.add("dragging");
      panel.style.maxHeight = "none";
      try {
        toggle.setPointerCapture(e.pointerId);
      } catch (err) {
        // Non-fatal: pointer capture keeps tracking if the finger slides off the
        // handle, but the drag math below works without it.
      }
    });

    toggle.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const deltaY = startY - e.clientY;
      if (Math.abs(deltaY) > MOVE_THRESHOLD) moved = true;
      const vh = global.innerHeight;
      // Capped just above the expanded target so an enthusiastic drag can't overshoot
      // into something that reads as "fullscreen with no escape".
      const maxHeight = vh * EXPANDED_VH + 24;
      lastHeight = Math.min(maxHeight, Math.max(MINIMIZED_PX, startHeight + deltaY));
      panel.style.height = `${lastHeight}px`;
    });

    function endDrag() {
      if (!dragging) return;
      dragging = false;
      panel.classList.remove("dragging");
      panel.style.height = "";
      panel.style.maxHeight = "";
      if (!moved) return; // plain tap: the click listener below handles it
      swallowClick = true;

      const vh = global.innerHeight;
      const collapsedPx = vh * COLLAPSED_VH;
      const expandedPx = vh * EXPANDED_VH;
      if (lastHeight < (MINIMIZED_PX + collapsedPx) / 2) setState("minimized");
      else if (lastHeight < (collapsedPx + expandedPx) / 2) setState("collapsed");
      else setState("expanded");
    }

    toggle.addEventListener("pointerup", endDrag);
    toggle.addEventListener("pointercancel", endDrag);
    toggle.addEventListener("click", () => {
      if (swallowClick) { swallowClick = false; return; }
      if (!isMobile()) return;
      setState(panel.dataset.state === "expanded" ? "collapsed" : "expanded");
    });

    return { setState };
  }

  global.SheetPanel = { setup };
})(window);
