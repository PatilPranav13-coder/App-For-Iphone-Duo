export function createNotebookCanvas(canvas, initialStrokes, onSave) {
  const context = canvas.getContext('2d', { alpha: false });
  let strokes = Array.isArray(initialStrokes) ? initialStrokes : [];
  let activeStroke = null;
  let tool = 'pen';
  let pixelRatio = 1;

  const resize = function () {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(rect.width * pixelRatio);
    canvas.height = Math.floor(rect.height * pixelRatio);
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    redraw();
  };

  const redraw = function () {
    const rect = canvas.getBoundingClientRect();
    context.save();
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.fillStyle = getComputedStyle(document.body).getPropertyValue('--surface').trim() || '#fff';
    context.fillRect(0, 0, rect.width, rect.height);
    strokes.forEach(drawStroke);
    if (activeStroke) drawStroke(activeStroke);
    context.restore();
  };

  function drawStroke(stroke) {
    if (!stroke.points?.length) return;
    context.save();
    context.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
    context.strokeStyle = stroke.color || '#5146e5';
    context.fillStyle = stroke.color || '#5146e5';
    context.lineWidth = stroke.tool === 'eraser' ? 18 : 2.4;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    const point = stroke.points[0];
    context.beginPath();
    context.moveTo(point.x, point.y);
    if (stroke.points.length === 1) {
      context.arc(point.x, point.y, context.lineWidth / 2, 0, Math.PI * 2);
      context.fill();
    } else {
      stroke.points.slice(1).forEach(function (item) { context.lineTo(item.x, item.y); });
      context.stroke();
    }
    context.restore();
  }

  function position(event) {
    const bounds = canvas.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top, pressure: event.pressure || 0.5 };
  }

  canvas.addEventListener('pointerdown', function (event) {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    canvas.setPointerCapture(event.pointerId);
    activeStroke = { tool, color: getComputedStyle(document.body).getPropertyValue('--accent').trim(), points: [position(event)] };
    redraw();
  });
  canvas.addEventListener('pointermove', function (event) {
    if (!activeStroke) return;
    const samples = event.getCoalescedEvents ? event.getCoalescedEvents() : [event];
    samples.forEach(function (sample) { activeStroke.points.push(position(sample)); });
    redraw();
  });
  const end = function () {
    if (!activeStroke) return;
    strokes.push(activeStroke);
    activeStroke = null;
    redraw();
    onSave(strokes);
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  new ResizeObserver(resize).observe(canvas);
  window.addEventListener('themechange', redraw);
  resize();

  return {
    setTool: function (nextTool) { tool = nextTool; },
    clear: function () { strokes = []; activeStroke = null; redraw(); onSave(strokes); },
    load: function (nextStrokes) { strokes = Array.isArray(nextStrokes) ? nextStrokes : []; redraw(); },
    getStrokes: function () { return strokes; }
  };
}
