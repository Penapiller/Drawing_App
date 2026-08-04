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

const linesCanvas = document.getElementById("linesCanvas");
const paintCanvas = document.getElementById("paintCanvas");
const linesCtx = linesCanvas.getContext("2d");
const paintCtx = paintCanvas.getContext("2d");
const brushCursor = document.getElementById("brushCursor");

const colorPicker = document.getElementById("colorPicker");
const brushSize = document.getElementById("brushSize");
const toolOpacityInput = document.getElementById("toolOpacity");
const toolStabilizationInput = document.getElementById("toolStabilization");
const toolBlendModeInput = document.getElementById("toolBlendMode");
const clearBtn = document.getElementById("clearBtn");
const undoBtn = document.getElementById("undoBtn");
const redoBtn = document.getElementById("redoBtn");
const toolButtons = document.querySelectorAll(".tool-btn");
const addLayerBtn = document.getElementById("addLayerBtn");
const layerListEl = document.getElementById("layerList");

// The colorable-area mask, static for the whole session once loaded.
const maskCanvas = document.createElement("canvas");
const maskCtx = maskCanvas.getContext("2d");

// Holds only the in-progress brush/eraser/fill mark. It gets merged onto
// the active layer (with the chosen opacity/blend mode) once the action
// finishes, which keeps opacity from compounding where a stroke overlaps
// itself mid-drag.
const tempActionCanvas = document.createElement("canvas");
const tempActionCtx = tempActionCanvas.getContext("2d");

let artworkWidth = 0;
let artworkHeight = 0;
let maskBBox = null; // {x, y, width, height} - crops history snapshots

let layers = []; // { id, name, visible, canvas, ctx }
let activeLayerId = null;
let nextLayerNumber = 1;

let currentTool = "brush";
let isDrawing = false;
let smoothedPoint = null;

// Connected-component labeling of the mask, so the fill tool can color
// just the shape that was clicked instead of the whole mask at once.
let regionLabelMap = null; // Int32Array, 0 = not colorable, >0 = region id

let history = []; // [{ activeLayerId, layers: [{id, name, visible, imageData}] }]
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
    canvas,
    ctx: canvas.getContext("2d"),
  };
}

function getActiveLayer() {
  return layers.find((layer) => layer.id === activeLayerId);
}

async function init() {
  const [linesImg, colorableImg] = await Promise.all([
    loadImage(CURRENT_LINEART.lines),
    loadImage(CURRENT_LINEART.colorable),
  ]);

  artworkWidth = linesImg.naturalWidth;
  artworkHeight = linesImg.naturalHeight;

  for (const canvas of [linesCanvas, paintCanvas, maskCanvas, tempActionCanvas]) {
    canvas.width = artworkWidth;
    canvas.height = artworkHeight;
  }

  linesCtx.drawImage(linesImg, 0, 0);
  maskCtx.drawImage(colorableImg, 0, 0);

  const regions = computeRegionLabels(maskCtx, artworkWidth, artworkHeight);
  regionLabelMap = regions.labelMap;
  maskBBox = regions.bbox;

  const firstLayer = createLayer(`Layer ${nextLayerNumber++}`);
  layers = [firstLayer];
  activeLayerId = firstLayer.id;

  renderLayerList();
  compositePaint();
  recordHistory();

  attachPointerHandlers();
  attachToolbarHandlers();
  attachLayerHandlers();
}

// Redraws paintCanvas from every visible layer (bottom to top), plus the
// in-progress action on the active layer if a stroke is underway, then
// clips the whole result to maskCanvas's shape.
function compositePaint() {
  paintCtx.clearRect(0, 0, artworkWidth, artworkHeight);

  for (const layer of layers) {
    if (!layer.visible) continue;

    paintCtx.globalAlpha = 1;
    paintCtx.globalCompositeOperation = "source-over";
    paintCtx.drawImage(layer.canvas, 0, 0);

    if (isDrawing && layer.id === activeLayerId) {
      paintCtx.globalAlpha = getToolOpacity();
      paintCtx.globalCompositeOperation = getMergeBlendMode();
      paintCtx.drawImage(tempActionCanvas, 0, 0);
    }
  }

  paintCtx.globalAlpha = 1;
  paintCtx.globalCompositeOperation = "destination-in";
  paintCtx.drawImage(maskCanvas, 0, 0);
  paintCtx.globalCompositeOperation = "source-over";
}

function getToolOpacity() {
  return Number(toolOpacityInput.value) / 100;
}

function getStabilizationFactor() {
  return Number(toolStabilizationInput.value) / 100; // 0 - 0.9
}

function getMergeBlendMode() {
  return currentTool === "eraser" ? "destination-out" : toolBlendModeInput.value;
}

// Groups the mask's opaque pixels into connected shapes (flood fill), so
// the fill tool only colors the one shape that was clicked. For the
// current single-piece lineart this is one big region, but this keeps
// the fill tool correct once linearts have separate colorable pieces.
// Also returns the mask's pixel bounding box, used to keep undo history
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

function getCanvasPoint(evt) {
  const rect = linesCanvas.getBoundingClientRect();
  const scaleX = artworkWidth / rect.width;
  const scaleY = artworkHeight / rect.height;
  return {
    x: (evt.clientX - rect.left) * scaleX,
    y: (evt.clientY - rect.top) * scaleY,
  };
}

function drawActionSegment(from, to) {
  tempActionCtx.globalCompositeOperation = "source-over";
  tempActionCtx.globalAlpha = 1;
  tempActionCtx.strokeStyle = colorPicker.value;
  tempActionCtx.lineWidth = Number(brushSize.value);
  tempActionCtx.lineCap = "round";
  tempActionCtx.lineJoin = "round";
  tempActionCtx.beginPath();
  tempActionCtx.moveTo(from.x, from.y);
  tempActionCtx.lineTo(to.x, to.y);
  tempActionCtx.stroke();
}

// Permanently applies the in-progress action (tempActionCanvas) onto the
// active layer, using the current tool opacity/blend mode, then clears
// the action canvas and records the result in undo history.
function mergeActionIntoActiveLayer() {
  const layer = getActiveLayer();
  if (!layer) return;

  layer.ctx.globalAlpha = getToolOpacity();
  layer.ctx.globalCompositeOperation = getMergeBlendMode();
  layer.ctx.drawImage(tempActionCanvas, 0, 0);
  layer.ctx.globalAlpha = 1;
  layer.ctx.globalCompositeOperation = "source-over";

  tempActionCtx.clearRect(0, 0, artworkWidth, artworkHeight);
  compositePaint();
  recordHistory();
}

function fillRegionAt(point) {
  const x = Math.floor(point.x);
  const y = Math.floor(point.y);
  if (x < 0 || y < 0 || x >= artworkWidth || y >= artworkHeight) return;

  const idx = y * artworkWidth + x;
  const label = regionLabelMap[idx];
  if (label === 0) return; // clicked outside the colorable area

  tempActionCtx.clearRect(0, 0, artworkWidth, artworkHeight);
  const imageData = tempActionCtx.createImageData(artworkWidth, artworkHeight);
  const data = imageData.data;
  const [r, g, b] = hexToRgb(colorPicker.value);

  for (let i = 0; i < regionLabelMap.length; i++) {
    if (regionLabelMap[i] === label) {
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
    const point = getCanvasPoint(evt);

    if (currentTool === "fill") {
      fillRegionAt(point);
      return;
    }

    isDrawing = true;
    smoothedPoint = { ...point };
    tempActionCtx.clearRect(0, 0, artworkWidth, artworkHeight);
    drawActionSegment(smoothedPoint, smoothedPoint);
    compositePaint();
    linesCanvas.setPointerCapture(evt.pointerId);
  });

  linesCanvas.addEventListener("pointermove", (evt) => {
    updateBrushCursor(evt);
    if (!isDrawing) return;

    const raw = getCanvasPoint(evt);
    const followFactor = 1 - getStabilizationFactor();
    const next = {
      x: smoothedPoint.x + (raw.x - smoothedPoint.x) * followFactor,
      y: smoothedPoint.y + (raw.y - smoothedPoint.y) * followFactor,
    };
    drawActionSegment(smoothedPoint, next);
    smoothedPoint = next;
    compositePaint();
  });

  function endStroke() {
    if (!isDrawing) return;
    isDrawing = false;
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
  if (currentTool === "fill") {
    brushCursor.style.display = "none";
    return;
  }

  const rect = linesCanvas.getBoundingClientRect();
  const scale = rect.width / artworkWidth; // CSS px per canvas px
  const diameter = Number(brushSize.value) * scale;
  const localX = evt.clientX - rect.left;
  const localY = evt.clientY - rect.top;

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
  linesCanvas.style.cursor = tool === "fill" ? "pointer" : "none";
  toolStabilizationInput.disabled = tool === "fill";
  toolBlendModeInput.disabled = tool === "eraser";
  if (tool === "fill") hideBrushCursor();
}

function attachToolbarHandlers() {
  toolButtons.forEach((btn) => {
    btn.addEventListener("click", () => setActiveTool(btn.dataset.tool));
  });
  setActiveTool(currentTool);

  clearBtn.addEventListener("click", () => {
    const layer = getActiveLayer();
    if (!layer) return;
    layer.ctx.clearRect(0, 0, artworkWidth, artworkHeight);
    compositePaint();
    recordHistory();
  });

  undoBtn.addEventListener("click", undo);
  redoBtn.addEventListener("click", redo);
}

// --- Layers ------------------------------------------------------------

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
}

// --- Undo / redo ---------------------------------------------------------
// Each history entry is a snapshot of every layer's pixels (cropped to the
// mask's bounding box to keep memory down) plus which layer was active.
// Undo/redo just move a pointer through these snapshots and rebuild the
// layer list from whichever one it lands on.

function snapshotLayers() {
  const { x, y, width, height } = maskBBox;
  return layers.map((layer) => ({
    id: layer.id,
    name: layer.name,
    visible: layer.visible,
    imageData: layer.ctx.getImageData(x, y, width, height),
  }));
}

function recordHistory() {
  const snapshot = {
    activeLayerId,
    layers: snapshotLayers(),
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
    return { id: entry.id, name: entry.name, visible: entry.visible, canvas, ctx };
  });
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
