/**
 * Touch screens have no hover, so a summary cell's hover card opens while the cell is focused (tapped).
 * Some mobile browsers keep that focus when the user then taps plain content elsewhere, which would leave
 * the card open; a tap outside the focused cell blurs it instead. Taps inside the card (to scroll it) keep it open.
 */
export function closeHoverCardsOnOutsideTap() {
  document.addEventListener("pointerdown", (e) => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.classList.contains("sc-top") && !active.contains(e.target as Node)) {
      active.blur();
    }
  });
}
