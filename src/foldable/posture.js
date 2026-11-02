const LAYOUTS = ['compact', 'focus', 'studio'];

export function detectAutomaticLayout() {
  const width = window.visualViewport?.width || window.innerWidth;
  const segments = typeof window.getWindowSegments === 'function' ? window.getWindowSegments() : null;
  const segmentQueries = [
    window.matchMedia?.('(horizontal-viewport-segments: 2)'),
    window.matchMedia?.('(vertical-viewport-segments: 2)')
  ].filter(Boolean);
  const segmented = Boolean(segments?.length > 1 || segmentQueries.some(function (query) { return query.matches; }));
  return segmented ? (width < 1180 ? 'focus' : 'studio') : width < 700 ? 'compact' : width < 1160 ? 'focus' : 'studio';
}

export function initFoldableLayout(onLayout, savedPreference) {
  const url = new URLSearchParams(location.search);
  const urlPreference = url.get('layout');
  let preference = LAYOUTS.includes(urlPreference) ? urlPreference : (['auto', ...LAYOUTS].includes(savedPreference) ? savedPreference : 'auto');
  const segmentQueries = [
    window.matchMedia?.('(horizontal-viewport-segments: 2)'),
    window.matchMedia?.('(vertical-viewport-segments: 2)')
  ].filter(Boolean);

  function automaticLayout() {
    const layout = detectAutomaticLayout();
    if (preference === 'auto') onLayout('auto', { preference: 'auto', layout, source: 'feature-detected viewport' });
  }

  LAYOUTS.concat(['auto']).forEach(function (layout) {
    const button = document.querySelector('[data-layout="' + layout + '"]');
    button?.addEventListener('click', function () {
      preference = layout;
      if (layout === 'auto') automaticLayout();
      else onLayout(layout, { manual: true, preference: layout, source: 'manual' });
    });
  });

  window.addEventListener('resize', automaticLayout, { passive: true });
  window.visualViewport?.addEventListener('resize', automaticLayout, { passive: true });
  segmentQueries.forEach(function (query) { query.addEventListener?.('change', automaticLayout); });
  if (preference === 'auto') automaticLayout();
  else onLayout(preference, { manual: false, preference, source: urlPreference ? 'url' : 'saved' });
}
