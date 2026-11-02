const layoutOrder = ['compact', 'focus', 'studio'];

export function initFoldableLayout(onLayout) {
  const params = new URLSearchParams(location.search);
  const requested = params.get('layout');
  const segmentQuery = window.matchMedia?.('(horizontal-viewport-segments: 2)');
  const updateAutomaticLayout = function () {
    const width = window.visualViewport?.width || window.innerWidth;
    const segmented = Boolean(segmentQuery?.matches) || (typeof window.getWindowSegments === 'function' && window.getWindowSegments().length > 1);
    const layout = segmented ? 'studio' : width < 700 ? 'compact' : width < 1160 ? 'focus' : 'studio';
    if (!requested) onLayout(layout, { segmented, source: segmented ? 'segments' : 'viewport' });
  };
  layoutOrder.forEach(function (layout) {
    const button = document.querySelector('[data-layout="' + layout + '"]');
    button?.addEventListener('click', function () { onLayout(layout, { manual: true }); });
  });
  window.addEventListener('resize', updateAutomaticLayout, { passive: true });
  window.visualViewport?.addEventListener('resize', updateAutomaticLayout, { passive: true });
  segmentQuery?.addEventListener?.('change', updateAutomaticLayout);
  if (requested && layoutOrder.includes(requested)) onLayout(requested, { manual: true });
  else updateAutomaticLayout();
}
