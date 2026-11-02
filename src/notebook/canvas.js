const DEFAULT_COLOR = '#5146e5';

export function createNotebookCanvas(canvas, initialStrokes, onSave, initialView, getAnnotationContext) {
  const context = canvas.getContext('2d', { alpha: false });
  let strokes = normalizeLegacyStrokes(Array.isArray(initialStrokes) ? initialStrokes : [], canvas);
  const redoStack = [];
  let activeStroke = null;
  let activePointer = null;
  let tool = 'pen';
  let color = DEFAULT_COLOR;
  let baseWidth = 2.4;
  let pixelRatio = 1;
  let selectedStrokeIds = [];
  const view = { zoom: clamp(initialView?.zoom || 1, 0.75, 2.5), panX: Number(initialView?.panX) || 0, panY: Number(initialView?.panY) || 0 };

  function resize() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    pixelRatio = Math.min(window.devicePixelRatio || 1, 3);
    const nextWidth = Math.max(1, Math.floor(width * pixelRatio));
    const nextHeight = Math.max(1, Math.floor(height * pixelRatio));
    if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
      canvas.width = nextWidth;
      canvas.height = nextHeight;
    }
    canvas.dataset.viewportWidth = String(width);
    canvas.dataset.viewportHeight = String(height);
    if (strokes.some(function (stroke) { return !stroke.normalized; })) strokes = normalizeLegacyStrokes(strokes, canvas);
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    redraw();
  }

  function redraw() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    context.save();
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.fillStyle = getComputedStyle(document.body).getPropertyValue('--surface').trim() || '#fff';
    context.fillRect(0, 0, width, height);
    strokes.forEach(drawStroke);
    if (activeStroke && activeStroke.tool !== 'lasso' && activeStroke.tool !== 'pan') drawStroke(activeStroke);
    drawSelection();
    context.restore();
    canvas.style.transform = 'translate(' + view.panX + 'px, ' + view.panY + 'px) scale(' + view.zoom + ')';
  }

  function drawStroke(stroke) {
    if (!stroke.points?.length) return;
    const points = stroke.points.map(function (point) { return { ...point, x: point.x * canvas.clientWidth, y: point.y * canvas.clientHeight }; });
    context.save();
    context.globalCompositeOperation = stroke.tool === 'highlighter' ? 'multiply' : 'source-over';
    context.globalAlpha = stroke.tool === 'highlighter' ? 0.34 : 1;
    const surfaceColor = getComputedStyle(document.body).getPropertyValue('--surface').trim() || '#fff';
    context.strokeStyle = stroke.tool === 'eraser' ? surfaceColor : (stroke.color || DEFAULT_COLOR);
    context.fillStyle = stroke.tool === 'eraser' ? surfaceColor : (stroke.color || DEFAULT_COLOR);
    context.lineCap = 'round';
    context.lineJoin = 'round';
    const width = stroke.tool === 'eraser' ? Math.max(14, stroke.baseWidth || 22) : (stroke.baseWidth || 2.4);
    if (stroke.tool === 'rectangle' || stroke.tool === 'ellipse') {
      const first = points[0];
      const last = points[points.length - 1];
      context.lineWidth = width;
      if (stroke.tool === 'rectangle') context.strokeRect(first.x, first.y, last.x - first.x, last.y - first.y);
      else {
        context.beginPath();
        context.ellipse((first.x + last.x) / 2, (first.y + last.y) / 2, Math.abs(last.x - first.x) / 2, Math.abs(last.y - first.y) / 2, 0, 0, Math.PI * 2);
        context.stroke();
      }
    } else if (stroke.tool === 'line' || stroke.tool === 'arrow') {
      const first = points[0];
      const last = points[points.length - 1];
      context.lineWidth = width;
      context.beginPath();
      context.moveTo(first.x, first.y);
      context.lineTo(last.x, last.y);
      context.stroke();
      if (stroke.tool === 'arrow') drawArrowHead(first, last, width);
    } else if (points.length === 1) {
      context.beginPath();
      context.arc(points[0].x, points[0].y, width * (0.35 + (points[0].pressure || 0.5) * 0.65) / 2, 0, Math.PI * 2);
      context.fill();
    } else {
      for (let index = 1; index < points.length; index += 1) {
        const start = points[index - 1];
        const end = points[index];
        const pressure = Math.max(0.08, ((start.pressure || 0.5) + (end.pressure || 0.5)) / 2);
        const tilt = Math.min(1, (Math.abs(start.tiltX || 0) + Math.abs(start.tiltY || 0) + Math.abs(end.tiltX || 0) + Math.abs(end.tiltY || 0)) / 360);
        context.lineWidth = stroke.tool === 'eraser' ? width : width * (0.32 + pressure * 1.15) * (1 + tilt * 0.35);
        context.beginPath();
        context.moveTo(start.x, start.y);
        context.lineTo(end.x, end.y);
        context.stroke();
      }
    }
    context.restore();
  }

  function drawArrowHead(start, end, width) {
    const angle = Math.atan2(end.y - start.y, end.x - start.x);
    const size = Math.max(9, width * 3.4);
    context.beginPath();
    context.moveTo(end.x, end.y);
    context.lineTo(end.x - size * Math.cos(angle - Math.PI / 6), end.y - size * Math.sin(angle - Math.PI / 6));
    context.moveTo(end.x, end.y);
    context.lineTo(end.x - size * Math.cos(angle + Math.PI / 6), end.y - size * Math.sin(angle + Math.PI / 6));
    context.stroke();
  }

  function drawSelection() {
    if (!selectedStrokeIds.length) return;
    const selected = strokes.filter(function (stroke) { return selectedStrokeIds.includes(stroke.id); });
    const points = selected.flatMap(function (stroke) { return stroke.points || []; });
    if (!points.length) return;
    const xs = points.map(function (point) { return point.x * canvas.clientWidth; });
    const ys = points.map(function (point) { return point.y * canvas.clientHeight; });
    context.save();
    context.strokeStyle = getComputedStyle(document.body).getPropertyValue('--accent').trim() || DEFAULT_COLOR;
    context.setLineDash([5, 4]);
    context.strokeRect(Math.min(...xs) - 6, Math.min(...ys) - 6, Math.max(10, Math.max(...xs) - Math.min(...xs) + 12), Math.max(10, Math.max(...ys) - Math.min(...ys) + 12));
    context.restore();
  }

  function position(event) {
    const rect = canvas.getBoundingClientRect();
    const width = rect.width || canvas.clientWidth || 1;
    const height = rect.height || canvas.clientHeight || 1;
    return {
      x: clamp((event.clientX - rect.left) / width, 0, 1),
      y: clamp((event.clientY - rect.top) / height, 0, 1),
      pressure: Number.isFinite(event.pressure) && event.pressure > 0 ? event.pressure : 0.5,
      tiltX: Number.isFinite(event.tiltX) ? event.tiltX : 0,
      tiltY: Number.isFinite(event.tiltY) ? event.tiltY : 0,
      twist: Number.isFinite(event.twist) ? event.twist : 0,
      time: Number.isFinite(event.timeStamp) ? event.timeStamp : Date.now()
    };
  }

  function onPointerDown(event) {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    if (activePointer !== null && event.pointerType === 'touch' && activePointer.type === 'pen') return;
    activePointer = { id: event.pointerId, type: event.pointerType, x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
    if (tool === 'pan') return;
    activeStroke = { id: crypto.randomUUID(), tool, color, baseWidth, normalized: true, annotation: getAnnotationContext?.() || null, points: [position(event)] };
    if (event.cancelable) event.preventDefault();
    redraw();
  }

  function onPointerMove(event) {
    if (!activePointer || activePointer.id !== event.pointerId) return;
    if (tool === 'pan') {
      view.panX += event.clientX - activePointer.x;
      view.panY += event.clientY - activePointer.y;
      activePointer.x = event.clientX;
      activePointer.y = event.clientY;
      redraw();
      onSave(strokes, { ...view });
      return;
    }
    if (!activeStroke) return;
    const samples = event.getCoalescedEvents ? event.getCoalescedEvents() : [event];
    samples.forEach(function (sample) { activeStroke.points.push(position(sample)); });
    redraw();
  }

  function onPointerUp() {
    if (!activePointer) return;
    activePointer = null;
    if (!activeStroke) { onSave(strokes, { ...view }); return; }
    if (tool === 'lasso') {
      selectWithinLasso(activeStroke.points);
      activeStroke = null;
      redraw();
      return;
    }
    strokes.push(activeStroke);
    activeStroke = null;
    redoStack.length = 0;
    redraw();
    onSave(strokes, { ...view });
  }

  function onPointerCancel() {
    if (!activePointer) return;
    activePointer = null;
    activeStroke = null;
    redraw();
  }

  function selectWithinLasso(points) {
    if (points.length < 3) return;
    selectedStrokeIds = strokes.filter(function (stroke) {
      return stroke.points.some(function (point) { return pointInPolygon(point, points); });
    }).map(function (stroke) { return stroke.id; });
  }

  function undo() {
    if (!strokes.length) return false;
    redoStack.push(strokes.pop());
    selectedStrokeIds = [];
    redraw();
    onSave(strokes, { ...view });
    return true;
  }

  function redo() {
    if (!redoStack.length) return false;
    strokes.push(redoStack.pop());
    redraw();
    onSave(strokes, { ...view });
    return true;
  }

  function deleteSelection() {
    if (!selectedStrokeIds.length) return false;
    const selected = new Set(selectedStrokeIds);
    const removed = strokes.filter(function (stroke) { return selected.has(stroke.id); });
    strokes = strokes.filter(function (stroke) { return !selected.has(stroke.id); });
    redoStack.push(...removed);
    selectedStrokeIds = [];
    redraw();
    onSave(strokes, { ...view });
    return true;
  }

  function setZoom(value) {
    view.zoom = clamp(value, 0.75, 2.5);
    redraw();
    onSave(strokes, { ...view });
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  window.addEventListener('themechange', redraw);
  let observer;
  if ('ResizeObserver' in window) { observer = new ResizeObserver(resize); observer.observe(canvas); }
  else window.addEventListener('resize', resize, { passive: true });
  resize();

  return {
    setTool: function (nextTool) { tool = nextTool; canvas.dataset.penTool = nextTool; },
    setColor: function (nextColor) { color = nextColor; },
    setWidth: function (nextWidth) { baseWidth = clamp(Number(nextWidth) || 2.4, 1, 18); },
    clear: function () { if (!strokes.length) return; strokes = []; selectedStrokeIds = []; redoStack.length = 0; redraw(); onSave(strokes, { ...view }); },
    undo,
    redo,
    deleteSelection,
    load: function (nextStrokes, nextView) {
      strokes = normalizeLegacyStrokes(Array.isArray(nextStrokes) ? nextStrokes : [], canvas);
      redoStack.length = 0;
      selectedStrokeIds = [];
      if (nextView) Object.assign(view, { zoom: clamp(nextView.zoom || 1, 0.75, 2.5), panX: Number(nextView.panX) || 0, panY: Number(nextView.panY) || 0 });
      redraw();
    },
    setZoom,
    resetView: function () { view.zoom = 1; view.panX = 0; view.panY = 0; redraw(); onSave(strokes, { ...view }); },
    getView: function () { return { ...view }; },
    getStrokes: function () { return strokes; },
    getSelectionCount: function () { return selectedStrokeIds.length; },
    destroy: function () {
      observer?.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('themechange', redraw);
      window.removeEventListener('resize', resize);
    }
  };
}

function normalizeLegacyStrokes(strokes, canvas) {
  const width = canvas.clientWidth || canvas.getBoundingClientRect().width;
  const height = canvas.clientHeight || canvas.getBoundingClientRect().height;
  return strokes.map(function (stroke) {
    if (!stroke || !Array.isArray(stroke.points)) return null;
    if (stroke.normalized) return { ...stroke, id: stroke.id || crypto.randomUUID(), baseWidth: stroke.baseWidth || 2.4 };
    if (width < 2 || height < 2) return { ...stroke, id: stroke.id || crypto.randomUUID(), normalized: false };
    return {
      ...stroke,
      id: stroke.id || crypto.randomUUID(),
      normalized: true,
      baseWidth: stroke.baseWidth || (stroke.tool === 'eraser' ? 22 : 2.4),
      points: stroke.points.map(function (point) { return { ...point, x: clamp(Number(point.x) / width, 0, 1), y: clamp(Number(point.y) / height, 0, 1), pressure: Number(point.pressure) || 0.5, tiltX: point.tiltX || 0, tiltY: point.tiltY || 0, twist: point.twist || 0 }; })
    };
  }).filter(Boolean);
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    const intersects = ((a.y > point.y) !== (b.y > point.y)) && (point.x < (b.x - a.x) * (point.y - a.y) / ((b.y - a.y) || 1e-8) + a.x);
    if (intersects) inside = !inside;
  }
  return inside;
}

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
