// The lineart currently loaded. Later this will be picked from a gallery
// of multiple linearts, but for now we just load Purra directly.
const CURRENT_LINEART = {
  id: "purra",
  name: "Purra",
  lines: "assets/linearts/purra/lines.png",
  colorable: "assets/linearts/purra/colorable.png",
};

// History snapshots include every layer's pixels, so both caps together
// bound how much image data can pile up in memory at once.
const MAX_HISTORY = 12;
const MAX_LAYERS = 6;

// Sentinel activeLayerId for the special "Line Color" target, which isn't
// a real entry in the `layers` array (see below).
const LINES_LAYER_ID = "lines-color";

const linesCanvas = document.getElementById("linesCanvas");
const paintCanvas = document.getElementById("paintCanvas");
const lineColorCanvas = document.getElementById("lineColorCanvas");
const linesCtx = linesCanvas.getContext("2d");
const paintCtx = paintCanvas.getContext("2d");
const lineColorCtx = lineColorCanvas.getContext("2d");
const brushCursor = document.getElementById("brushCursor");
const canvasStack = document.getElementById("canvasStack");
const canvasViewport = document.getElementById("canvasViewport");
const canvasArea = document.getElementById("canvasArea");

const colorPicker = document.getElementById("colorPicker");
const brushSize = document.getElementById("brushSize");
const toolOpacityInput = document.getElementById("toolOpacity");
const toolStabilizationInput = document.getElementById("toolStabilization");
const pressureToggle = document.getElementById("pressureToggle");
const layerBlendModeInput = document.getElementById("layerBlendMode");
const layerOpacityInput = document.getElementById("layerOpacity");
const clearBtn = document.getElementById("clearBtn");
const undoBtn = document.getElementById("undoBtn");
const redoBtn = document.getElementById("redoBtn");
const toolButtons = document.querySelectorAll(".tool-btn");
const addLayerBtn = document.getElementById("addLayerBtn");
const layerListEl = document.getElementById("layerList");
const zoomInBtn = document.getElementById("zoomInBtn");
const zoomOutBtn = document.getElementById("zoomOutBtn");
const zoomResetBtn = document.getElementById("zoomResetBtn");
const zoomLevelDisplay = document.getElementById("zoomLevelDisplay");

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.25;

// The colorable-area mask (for regular layers) and the lineart's own ink
// shape (for the Line Color target), both static once loaded.
const maskCanvas = document.createElement("canvas");
const maskCtx = maskCanvas.getContext("2d");
const linesMaskCanvas = document.createElement("canvas");
const linesMaskCtx = linesMaskCanvas.getContext("2d");

// Holds only the in-progress brush/eraser/fill mark. It gets merged onto
// the active target (with the chosen tool opacity) once the action
// finishes, which keeps opacity from compounding where a stroke overlaps
// itself mid-drag.
const tempActionCanvas = document.createElement("canvas");
const tempActionCtx = tempActionCanvas.getContext("2d");

// Scratch canvas used to preview the in-progress action merged onto its
// target, without touching the real layer canvas until the stroke ends.
const previewCanvas = document.createElement("canvas");
const previewCtx = previewCanvas.getContext("2d");

let artworkWidth = 0;
let artworkHeight = 0;
let maskBBox = null; // {x, y, width, height} - crops regular-layer history snapshots
let linesMaskBBox = null; // same, for the Line Color target

let layers = []; // { id, name, visible, blendMode, canvas, ctx }
let linesColorLayer = null; // { id: LINES_LAYER_ID, name, visible, canvas, ctx }
let activeLayerId = null; // a layers[].id, or LINES_LAYER_ID
let nextLayerNumber = 1;

let currentTool = "brush";
let isDrawing = false;
let smoothedPoint = null;

let zoomLevel = 1;
let isPanning = false;
let panStart = null; // { x, y, scrollLeft, scrollTop }

// Connected-component labeling, so the fill tool only colors the shape
// that was clicked - one for the body mask, one for the lineart's ink.
let regionLabelMap = null; // Int32Array, 0 = not colorable, >0 = region id
let linesRegionLabelMap = null;

let history = []; // [{ activeLayerId, layers: [...], linesColor: {...} }]
let historyIndex = -1;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function createLayer(name) {
  const canvas = document.createElement("canvas");
  canvas.width = artworkWidth;
  canvas.height = artworkHeight;
  return {
    id: `layer-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    visible: true,
    blendMode: "source-over",
    opacity: 1,
    canvas,
    ctx: canvas.getContext("2d"),
  };
}

function isLinesActive() {
  return activeLayerId === LINES_LAYER_ID;
}

function getActiveLayer() {
  return layers.find((layer) => layer.id === activeLayerId);
}

function getActiveTargetCtx() {
  return isLinesActive() ? linesColorLayer.ctx : getActiveLayer()?.ctx;
}

function getActiveRegionLabelMap() {
  return isLinesActive() ? linesRegionLabelMap : regionLabelMap;
}

async function init() {
  const [linesImg, colorableImg] = await Promise.all([
    loadImage(CURRENT_LINEART.lines),
    loadImage(CURRENT_LINEART.colorable),
  ]);

  artworkWidth = linesImg.naturalWidth;
  artworkHeight = linesImg.naturalHeight;

  for (const canvas of [
    linesCanvas,
    paintCanvas,
    lineColorCanvas,
    maskCanvas,
    linesMaskCanvas,
    tempActionCanvas,
    previewCanvas,
  ]) {
    canvas.width = artworkWidth;
    canvas.height = artworkHeight;
  }

  linesCtx.drawImage(linesImg, 0, 0);
  maskCtx.drawImage(colorableImg, 0, 0);
  linesMaskCtx.drawImage(linesImg, 0, 0); // the ink's own alpha is its mask

  const bodyRegions = computeRegionLabels(maskCtx, artworkWidth, artworkHeight);
  regionLabelMap = bodyRegions.labelMap;
  maskBBox = bodyRegions.bbox;

  const lineRegions = computeRegionLabels(linesMaskCtx, artworkWidth, artworkHeight);
  linesRegionLabelMap = lineRegions.labelMap;
  linesMaskBBox = lineRegions.bbox;

  const linesColorCanvasInner = document.createElement("canvas");
  linesColorCanvasInner.width = artworkWidth;
  linesColorCanvasInner.height = artworkHeight;
  linesColorLayer = {
    id: LINES_LAYER_ID,
    name: "Line Color",
    visible: true,
    opacity: 1,
    canvas: linesColorCanvasInner,
    ctx: linesColorCanvasInner.getContext("2d"),
  };

  const firstLayer = createLayer(`Layer ${nextLayerNumber++}`);
  layers = [firstLayer];
  activeLayerId = firstLayer.id;

  renderLayerList();
  compositePaint();
  recordHistory();

  attachPointerHandlers();
  attachToolbarHandlers();
  attachLayerHandlers();
  attachZoomHandlers();
}

// Redraws paintCanvas from every visible regular layer (bottom to top,
// each with its own blend mode), clipped to the body mask; and redraws
// lineColorCanvas from the Line Color target, clipped to the ink's own
// shape (shown normally, layered on top of the black ink).
function compositePaint() {
  paintCtx.clearRect(0, 0, artworkWidth, artworkHeight);

  for (const layer of layers) {
    if (!layer.visible) continue;

    let sourceCanvas = layer.canvas;
    if (isDrawing && !isLinesActive() && layer.id === activeLayerId) {
      sourceCanvas = buildPreviewCanvas(layer.canvas);
    }

    paintCtx.globalAlpha = layer.opacity;
    paintCtx.globalCompositeOperation = layer.blendMode;
    paintCtx.drawImage(sourceCanvas, 0, 0);
  }

  paintCtx.globalAlpha = 1;
  paintCtx.globalCompositeOperation = "destination-in";
  paintCtx.drawImage(maskCanvas, 0, 0);
  paintCtx.globalCompositeOperation = "source-over";

  lineColorCtx.clearRect(0, 0, artworkWidth, artworkHeight);
  if (linesColorLayer.visible) {
    let sourceCanvas = linesColorLayer.canvas;
    if (isDrawing && isLinesActive()) {
      sourceCanvas = buildPreviewCanvas(linesColorLayer.canvas);
    }

    lineColorCtx.globalAlpha = linesColorLayer.opacity;
    lineColorCtx.globalCompositeOperation = "source-over";
    lineColorCtx.drawImage(sourceCanvas, 0, 0);
    lineColorCtx.globalAlpha = 1;
    lineColorCtx.globalCompositeOperation = "destination-in";
    lineColorCtx.drawImage(linesMaskCanvas, 0, 0);
    lineColorCtx.globalCompositeOperation = "source-over";
  }
}

// Returns a scratch canvas showing `baseCanvas` with the in-progress
// action merged on top at the current tool opacity, for live preview
// only - the real layer canvas isn't touched until the stroke ends.
function buildPreviewCanvas(baseCanvas) {
  previewCtx.clearRect(0, 0, artworkWidth, artworkHeight);
  previewCtx.globalAlpha = 1;
  previewCtx.globalCompositeOperation = "source-over";
  previewCtx.drawImage(baseCanvas, 0, 0);
  previewCtx.globalAlpha = getToolOpacity();
  previewCtx.globalCompositeOperation = currentTool === "eraser" ? "destination-out" : "source-over";
  previewCtx.drawImage(tempActionCanvas, 0, 0);
  previewCtx.globalAlpha = 1;
  previewCtx.globalCompositeOperation = "source-over";
  return previewCanvas;
}

function getToolOpacity() {
  return Number(toolOpacityInput.value) / 100;
}

function getStabilizationFactor() {
  return Number(toolStabilizationInput.value) / 100; // 0 - 0.9
}

// Groups a mask's opaque pixels into connected shapes (flood fill), so
// the fill tool only colors the one shape that was clicked. Used for
// both the body's colorable mask and the lineart's own ink shape. Also
// returns the mask's pixel bounding box, used to keep undo history
// snapshots small instead of storing the whole (mostly-empty) canvas.
function computeRegionLabels(ctx, width, height) {
  const { data } = ctx.getImageData(0, 0, width, height);
  const total = width * height;
  const labelMap = new Int32Array(total);
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);

  const isColorable = (idx) => data[idx * 4 + 3] > 128;

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  let nextLabel = 0;
  for (let start = 0; start < total; start++) {
    if (visited[start] || !isColorable(start)) continue;

    nextLabel++;
    let qHead = 0;
    let qTail = 0;
    queue[qTail++] = start;
    visited[start] = 1;

    while (qHead < qTail) {
      const idx = queue[qHead++];
      labelMap[idx] = nextLabel;
      const x = idx % width;
      const y = (idx / width) | 0;

      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      if (x > 0) {
        const n = idx - 1;
        if (!visited[n] && isColorable(n)) {
          visited[n] = 1;
          queue[qTail++] = n;
        }
      }
      if (x < width - 1) {
        const n = idx + 1;
        if (!visited[n] && isColorable(n)) {
          visited[n] = 1;
          queue[qTail++] = n;
        }
      }
      if (y > 0) {
        const n = idx - width;
        if (!visited[n] && isColorable(n)) {
          visited[n] = 1;
          queue[qTail++] = n;
        }
      }
      if (y < height - 1) {
        const n = idx + width;
        if (!visited[n] && isColorable(n)) {
          visited[n] = 1;
          queue[qTail++] = n;
        }
      }
    }
  }

  const bbox =
    maxX >= minX
      ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
      : { x: 0, y: 0, width, height };

  return { labelMap, bbox };
}

function hexToRgb(hex) {
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function hexToRgba(hex, alpha) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function getCanvasPoint(evt) {
  const rect = linesCanvas.getBoundingClientRect();
  const scaleX = artworkWidth / rect.width;
  const scaleY = artworkHeight / rect.height;
  return {
    x: (evt.clientX - rect.left) * scaleX,
    y: (evt.clientY - rect.top) * scaleY,
    // Mouse/untouched-touch devices report 0 or a flat 0.5; only real
    // pressure-sensitive styluses vary this meaningfully.
    pressure: evt.pressure > 0 ? evt.pressure : 0.5,
  };
}

// Even at minimum pressure the stroke stays at least this fraction of
// the chosen brush size, so light touches don't disappear entirely.
const MIN_PRESSURE_RATIO = 0.25;

function getPressureAdjustedSize(pressure) {
  const base = Number(brushSize.value);
  if (!pressureToggle.checked) return base;
  const factor = MIN_PRESSURE_RATIO + (1 - MIN_PRESSURE_RATIO) * pressure;
  return base * factor;
}

function drawActionSegment(from, to) {
  tempActionCtx.globalCompositeOperation = "source-over";
  tempActionCtx.globalAlpha = 1;
  tempActionCtx.strokeStyle = colorPicker.value;
  tempActionCtx.lineWidth = getPressureAdjustedSize(to.pressure);
  tempActionCtx.lineCap = "round";
  tempActionCtx.lineJoin = "round";
  tempActionCtx.beginPath();
  tempActionCtx.moveTo(from.x, from.y);
  tempActionCtx.lineTo(to.x, to.y);
  tempActionCtx.stroke();
}

// Airbrush: unlike the other tools, it keeps depositing paint the longer
// it's held over one spot, like a real spray can, and lays down a soft
// (radial-gradient) dab instead of a hard-edged line. Two things trigger
// a dab: moving far enough from the last dab (so a normal drag gets
// dense, consistent coverage no matter how fast it's moving - stamping
// on a fixed timer alone left fast drags almost blank, since the pointer
// had already moved on before the next tick), and a timer that fires
// regardless of movement (so holding still keeps building up). Each dab
// is low-alpha and drawn with normal source-over, so overlapping dabs
// naturally build toward full opacity at the center while the feathered
// edges stay gradual - no special blending trick needed.
const AIRBRUSH_INTERVAL_MS = 30;
const AIRBRUSH_DAB_ALPHA = 0.22;
let airbrushIntervalId = null;
let lastAirbrushStampPoint = null;

function stampAirbrushDab(point) {
  const radius = getPressureAdjustedSize(point.pressure) / 2;
  if (radius <= 0) return;

  const gradient = tempActionCtx.createRadialGradient(point.x, point.y, 0, point.x, point.y, radius);
  gradient.addColorStop(0, hexToRgba(colorPicker.value, AIRBRUSH_DAB_ALPHA));
  gradient.addColorStop(1, hexToRgba(colorPicker.value, 0));

  tempActionCtx.globalCompositeOperation = "source-over";
  tempActionCtx.globalAlpha = 1;
  tempActionCtx.fillStyle = gradient;
  tempActionCtx.beginPath();
  tempActionCtx.arc(point.x, point.y, radius, 0, Math.PI * 2);
  tempActionCtx.fill();

  lastAirbrushStampPoint = { ...point };
}

// Called from pointermove while airbrushing. Stamps a dab if the pointer
// has moved far enough since the last one - the threshold scales with
// the current brush size so dabs always overlap enough for solid
// coverage, whether the brush is tiny or huge. If the pointer jumped
// further than that in one move event (coarse pointer polling, or a
// fast flick), stamps are interpolated along the path between the two
// points instead of just at the endpoint, so fast strokes don't end up
// as a dotted line with gaps.
function maybeStampAirbrushDabForMove(point) {
  if (!lastAirbrushStampPoint) {
    stampAirbrushDab(point);
    compositePaint();
    return;
  }

  // Captured now, before the loop below starts reassigning
  // lastAirbrushStampPoint on every stamp - otherwise later steps would
  // drift, interpolating from an already-moved point instead of here.
  const startPoint = lastAirbrushStampPoint;
  const diameter = getPressureAdjustedSize(point.pressure);
  const minSpacing = Math.max(1.5, diameter * 0.12);
  const dx = point.x - startPoint.x;
  const dy = point.y - startPoint.y;
  const dist = Math.hypot(dx, dy);
  if (dist < minSpacing) return;

  const steps = Math.floor(dist / minSpacing);
  for (let i = 1; i <= steps; i++) {
    stampAirbrushDab({
      x: startPoint.x + (dx * i) / steps,
      y: startPoint.y + (dy * i) / steps,
      pressure: point.pressure,
    });
  }
  compositePaint();
}

function startAirbrushLoop() {
  stopAirbrushLoop();
  airbrushIntervalId = setInterval(() => {
    if (!isDrawing || currentTool !== "airbrush") {
      stopAirbrushLoop();
      return;
    }
    stampAirbrushDab(smoothedPoint);
    compositePaint();
  }, AIRBRUSH_INTERVAL_MS);
}

function stopAirbrushLoop() {
  if (airbrushIntervalId !== null) {
    clearInterval(airbrushIntervalId);
    airbrushIntervalId = null;
  }
}

// Permanently applies the in-progress action (tempActionCanvas) onto the
// active target (a regular layer, or the Line Color target), using the
// current tool opacity, then clears the action canvas and records the
// result in undo history.
function mergeActionIntoActiveLayer() {
  const ctx = getActiveTargetCtx();
  if (!ctx) return;

  ctx.globalAlpha = getToolOpacity();
  ctx.globalCompositeOperation = currentTool === "eraser" ? "destination-out" : "source-over";
  ctx.drawImage(tempActionCanvas, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";

  tempActionCtx.clearRect(0, 0, artworkWidth, artworkHeight);
  compositePaint();
  recordHistory();
}

function fillRegionAt(point) {
  const x = Math.floor(point.x);
  const y = Math.floor(point.y);
  if (x < 0 || y < 0 || x >= artworkWidth || y >= artworkHeight) return;

  const labelMap = getActiveRegionLabelMap();
  const idx = y * artworkWidth + x;
  const label = labelMap[idx];
  if (label === 0) return; // clicked outside the colorable/ink area

  tempActionCtx.clearRect(0, 0, artworkWidth, artworkHeight);
  const imageData = tempActionCtx.createImageData(artworkWidth, artworkHeight);
  const data = imageData.data;
  const [r, g, b] = hexToRgb(colorPicker.value);

  for (let i = 0; i < labelMap.length; i++) {
    if (labelMap[i] === label) {
      const o = i * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
  }

  tempActionCtx.putImageData(imageData, 0, 0);
  mergeActionIntoActiveLayer();
}

function attachPointerHandlers() {
  linesCanvas.addEventListener("pointerdown", (evt) => {
    if (currentTool === "pan") {
      isPanning = true;
      panStart = {
        x: evt.clientX,
        y: evt.clientY,
        scrollLeft: canvasViewport.scrollLeft,
        scrollTop: canvasViewport.scrollTop,
      };
      linesCanvas.style.cursor = "grabbing";
      linesCanvas.setPointerCapture(evt.pointerId);
      return;
    }

    const point = getCanvasPoint(evt);

    if (currentTool === "fill") {
      fillRegionAt(point);
      return;
    }

    isDrawing = true;
    smoothedPoint = { ...point };
    tempActionCtx.clearRect(0, 0, artworkWidth, artworkHeight);

    if (currentTool === "airbrush") {
      lastAirbrushStampPoint = null;
      stampAirbrushDab(smoothedPoint);
      compositePaint();
      startAirbrushLoop();
    } else {
      drawActionSegment(smoothedPoint, smoothedPoint);
      compositePaint();
    }
    linesCanvas.setPointerCapture(evt.pointerId);
  });

  linesCanvas.addEventListener("pointermove", (evt) => {
    if (isPanning) {
      canvasViewport.scrollLeft = panStart.scrollLeft - (evt.clientX - panStart.x);
      canvasViewport.scrollTop = panStart.scrollTop - (evt.clientY - panStart.y);
      return;
    }

    updateBrushCursor(evt);
    if (!isDrawing) return;

    const raw = getCanvasPoint(evt);
    const followFactor = 1 - getStabilizationFactor();
    const next = {
      x: smoothedPoint.x + (raw.x - smoothedPoint.x) * followFactor,
      y: smoothedPoint.y + (raw.y - smoothedPoint.y) * followFactor,
      pressure: raw.pressure,
    };

    if (currentTool === "airbrush") {
      smoothedPoint = next;
      maybeStampAirbrushDabForMove(next);
      return;
    }

    drawActionSegment(smoothedPoint, next);
    smoothedPoint = next;
    compositePaint();
  });

  function endStroke() {
    if (isPanning) {
      isPanning = false;
      panStart = null;
      linesCanvas.style.cursor = "grab";
      return;
    }
    if (!isDrawing) return;
    isDrawing = false;
    stopAirbrushLoop();
    mergeActionIntoActiveLayer();
  }

  linesCanvas.addEventListener("pointerup", endStroke);
  linesCanvas.addEventListener("pointercancel", endStroke);
  linesCanvas.addEventListener("pointerleave", () => {
    hideBrushCursor();
    endStroke();
  });
  linesCanvas.addEventListener("pointerenter", updateBrushCursor);
}

function updateBrushCursor(evt) {
  if (currentTool === "fill" || currentTool === "pan") {
    brushCursor.style.display = "none";
    return;
  }

  // Positioned relative to canvasArea (a plain, non-scrolling container)
  // rather than canvasStack - the cursor previously lived inside the
  // scrollable/zoomable canvasStack, which meant its own bounding box
  // (drawn past the canvas edge for large brushes) counted as scrollable
  // overflow and jittered the scrollbar on every mouse move.
  const canvasRect = linesCanvas.getBoundingClientRect();
  const areaRect = canvasArea.getBoundingClientRect();
  const scale = canvasRect.width / artworkWidth; // CSS px per canvas px
  const diameter = Number(brushSize.value) * scale;
  const localX = evt.clientX - areaRect.left;
  const localY = evt.clientY - areaRect.top;

  brushCursor.style.width = `${diameter}px`;
  brushCursor.style.height = `${diameter}px`;
  brushCursor.style.left = `${localX - diameter / 2}px`;
  brushCursor.style.top = `${localY - diameter / 2}px`;
  brushCursor.style.display = "block";
}

function hideBrushCursor() {
  brushCursor.style.display = "none";
}

function setActiveTool(tool) {
  currentTool = tool;
  toolButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.tool === tool));
  if (tool === "fill") {
    linesCanvas.style.cursor = "pointer";
  } else if (tool === "pan") {
    linesCanvas.style.cursor = "grab";
  } else {
    linesCanvas.style.cursor = "none";
  }
  toolStabilizationInput.disabled = tool === "fill" || tool === "pan";
  if (tool === "fill" || tool === "pan") hideBrushCursor();
}

function attachToolbarHandlers() {
  toolButtons.forEach((btn) => {
    btn.addEventListener("click", () => setActiveTool(btn.dataset.tool));
  });
  setActiveTool(currentTool);

  clearBtn.addEventListener("click", () => {
    const ctx = getActiveTargetCtx();
    if (!ctx) return;
    ctx.clearRect(0, 0, artworkWidth, artworkHeight);
    compositePaint();
    recordHistory();
  });

  undoBtn.addEventListener("click", undo);
  redoBtn.addEventListener("click", redo);

  layerBlendModeInput.addEventListener("change", () => {
    if (isLinesActive()) return; // fixed to Normal; select is disabled
    const layer = getActiveLayer();
    if (!layer) return;
    layer.blendMode = layerBlendModeInput.value;
    compositePaint();
    recordHistory();
  });

  // Live-update while dragging, but only commit one undo step when the
  // slider is released - otherwise every intermediate tick would spam
  // the history stack.
  layerOpacityInput.addEventListener("input", () => {
    const target = isLinesActive() ? linesColorLayer : getActiveLayer();
    if (!target) return;
    target.opacity = Number(layerOpacityInput.value) / 100;
    compositePaint();
  });
  layerOpacityInput.addEventListener("change", () => {
    recordHistory();
  });
}

function attachZoomHandlers() {
  zoomInBtn.addEventListener("click", () => setZoom(zoomLevel + ZOOM_STEP));
  zoomOutBtn.addEventListener("click", () => setZoom(zoomLevel - ZOOM_STEP));
  zoomResetBtn.addEventListener("click", () => setZoom(1));
  setZoom(1);
}

// Scales canvasStack while keeping whatever's currently at the viewport's
// center visually stable, and lets canvasViewport's native scrolling
// handle panning into the overflow.
function setZoom(newZoom) {
  const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, newZoom));
  const rect = canvasViewport.getBoundingClientRect();
  const centerX = (canvasViewport.scrollLeft + rect.width / 2) / zoomLevel;
  const centerY = (canvasViewport.scrollTop + rect.height / 2) / zoomLevel;

  zoomLevel = clamped;
  canvasStack.style.transform = `scale(${zoomLevel})`;
  zoomLevelDisplay.textContent = `${Math.round(zoomLevel * 100)}%`;

  canvasViewport.scrollLeft = centerX * zoomLevel - rect.width / 2;
  canvasViewport.scrollTop = centerY * zoomLevel - rect.height / 2;

  zoomOutBtn.disabled = zoomLevel <= MIN_ZOOM;
  zoomInBtn.disabled = zoomLevel >= MAX_ZOOM;
}

// --- Layers --------------------------------------------------------------

function attachLayerHandlers() {
  addLayerBtn.addEventListener("click", addLayer);
}

function addLayer() {
  if (layers.length >= MAX_LAYERS) return;
  const activeIndex = layers.findIndex((layer) => layer.id === activeLayerId);
  const newLayer = createLayer(`Layer ${nextLayerNumber++}`);
  layers.splice(activeIndex + 1, 0, newLayer);
  activeLayerId = newLayer.id;
  renderLayerList();
  compositePaint();
  recordHistory();
}

function deleteLayer(layerId) {
  if (layers.length <= 1) return;
  const index = layers.findIndex((layer) => layer.id === layerId);
  if (index === -1) return;

  layers.splice(index, 1);
  if (activeLayerId === layerId) {
    const newIndex = Math.min(index, layers.length - 1);
    activeLayerId = layers[newIndex].id;
  }

  renderLayerList();
  compositePaint();
  recordHistory();
}

function moveLayer(fromIndex, toIndex) {
  if (toIndex < 0 || toIndex >= layers.length) return;
  const [layer] = layers.splice(fromIndex, 1);
  layers.splice(toIndex, 0, layer);
  renderLayerList();
  compositePaint();
  recordHistory();
}

function renderLayerList() {
  layerListEl.innerHTML = "";

  // Special, always-present target for recoloring the permanent lineart.
  // Pinned above regular layers; it can't be deleted or reordered since
  // it isn't really part of the paint stack (it renders separately, on
  // top of the ink).
  const linesLi = document.createElement("li");
  linesLi.className = "layer-row lines-row" + (isLinesActive() ? " active" : "");

  const linesVisBtn = document.createElement("button");
  linesVisBtn.type = "button";
  linesVisBtn.textContent = linesColorLayer.visible ? "\u{1F441}" : "\u{1F6AB}";
  linesVisBtn.title = linesColorLayer.visible ? "Hide line coloring" : "Show line coloring";
  linesVisBtn.addEventListener("click", (evt) => {
    evt.stopPropagation();
    linesColorLayer.visible = !linesColorLayer.visible;
    compositePaint();
    renderLayerList();
    recordHistory();
  });

  const linesNameSpan = document.createElement("span");
  linesNameSpan.className = "layer-name";
  linesNameSpan.textContent = linesColorLayer.name;
  linesNameSpan.title = "Color the lineart itself - can't remove or extend it";

  linesLi.addEventListener("click", () => {
    activeLayerId = LINES_LAYER_ID;
    renderLayerList();
  });

  linesLi.append(linesVisBtn, linesNameSpan);
  layerListEl.appendChild(linesLi);

  // Top of the stack is drawn last, so show it first in the list (matches
  // how most layer panels order things).
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    const li = document.createElement("li");
    li.className = "layer-row" + (layer.id === activeLayerId ? " active" : "");

    const visibilityBtn = document.createElement("button");
    visibilityBtn.type = "button";
    visibilityBtn.textContent = layer.visible ? "\u{1F441}" : "\u{1F6AB}";
    visibilityBtn.title = layer.visible ? "Hide layer" : "Show layer";
    visibilityBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      layer.visible = !layer.visible;
      compositePaint();
      renderLayerList();
      recordHistory();
    });

    const nameSpan = document.createElement("span");
    nameSpan.className = "layer-name";
    nameSpan.textContent = layer.name;
    nameSpan.title = "Double-click to rename";
    nameSpan.addEventListener("dblclick", (evt) => {
      evt.stopPropagation();
      const newName = prompt("Rename layer", layer.name);
      if (newName && newName.trim()) {
        layer.name = newName.trim();
        renderLayerList();
        recordHistory();
      }
    });

    const upBtn = document.createElement("button");
    upBtn.type = "button";
    upBtn.textContent = "↑";
    upBtn.title = "Move layer up";
    upBtn.disabled = i === layers.length - 1;
    upBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      moveLayer(i, i + 1);
    });

    const downBtn = document.createElement("button");
    downBtn.type = "button";
    downBtn.textContent = "↓";
    downBtn.title = "Move layer down";
    downBtn.disabled = i === 0;
    downBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      moveLayer(i, i - 1);
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.textContent = "✕";
    deleteBtn.title = "Delete layer";
    deleteBtn.disabled = layers.length <= 1;
    deleteBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      deleteLayer(layer.id);
    });

    li.addEventListener("click", () => {
      activeLayerId = layer.id;
      renderLayerList();
    });

    li.append(visibilityBtn, nameSpan, upBtn, downBtn, deleteBtn);
    layerListEl.appendChild(li);
  }

  addLayerBtn.disabled = layers.length >= MAX_LAYERS;

  if (isLinesActive()) {
    layerBlendModeInput.value = "source-over";
    layerBlendModeInput.disabled = true;
    layerOpacityInput.value = Math.round(linesColorLayer.opacity * 100);
  } else {
    const layer = getActiveLayer();
    layerBlendModeInput.value = layer ? layer.blendMode : "source-over";
    layerBlendModeInput.disabled = false;
    layerOpacityInput.value = layer ? Math.round(layer.opacity * 100) : 100;
  }
}

// --- Undo / redo -----------------------------------------------------------
// Each history entry is a snapshot of every regular layer's pixels plus
// the Line Color target's pixels (all cropped to their mask's bounding
// box to keep memory down), plus which target was active. Undo/redo just
// move a pointer through these snapshots and rebuild everything from
// whichever one it lands on.

function snapshotLayers() {
  const { x, y, width, height } = maskBBox;
  return layers.map((layer) => ({
    id: layer.id,
    name: layer.name,
    visible: layer.visible,
    blendMode: layer.blendMode,
    opacity: layer.opacity,
    imageData: layer.ctx.getImageData(x, y, width, height),
  }));
}

function recordHistory() {
  const { x, y, width, height } = linesMaskBBox;
  const snapshot = {
    activeLayerId,
    layers: snapshotLayers(),
    linesColor: {
      visible: linesColorLayer.visible,
      opacity: linesColorLayer.opacity,
      imageData: linesColorLayer.ctx.getImageData(x, y, width, height),
    },
  };

  history = history.slice(0, historyIndex + 1);
  history.push(snapshot);

  if (history.length > MAX_HISTORY) {
    history.shift();
  }
  historyIndex = history.length - 1;

  updateHistoryButtons();
}

function restoreHistory(index) {
  const snapshot = history[index];
  const { x, y } = maskBBox;

  layers = snapshot.layers.map((entry) => {
    const canvas = document.createElement("canvas");
    canvas.width = artworkWidth;
    canvas.height = artworkHeight;
    const ctx = canvas.getContext("2d");
    ctx.putImageData(entry.imageData, x, y);
    return {
      id: entry.id,
      name: entry.name,
      visible: entry.visible,
      blendMode: entry.blendMode,
      opacity: entry.opacity,
      canvas,
      ctx,
    };
  });

  linesColorLayer.visible = snapshot.linesColor.visible;
  linesColorLayer.opacity = snapshot.linesColor.opacity;
  linesColorLayer.ctx.clearRect(0, 0, artworkWidth, artworkHeight);
  linesColorLayer.ctx.putImageData(snapshot.linesColor.imageData, linesMaskBBox.x, linesMaskBBox.y);

  activeLayerId = snapshot.activeLayerId;
  historyIndex = index;

  renderLayerList();
  compositePaint();
  updateHistoryButtons();
}

function undo() {
  if (historyIndex <= 0) return;
  restoreHistory(historyIndex - 1);
}

function redo() {
  if (historyIndex >= history.length - 1) return;
  restoreHistory(historyIndex + 1);
}

function updateHistoryButtons() {
  undoBtn.disabled = historyIndex <= 0;
  redoBtn.disabled = historyIndex >= history.length - 1;
}

init();
