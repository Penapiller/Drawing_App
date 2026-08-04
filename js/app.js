// The lineart currently loaded. Later this will be picked from a gallery
// of multiple linearts, but for now we just load Purra directly.
const CURRENT_LINEART = {
  id: "purra",
  name: "Purra",
  lines: "assets/linearts/purra/lines.png",
  colorable: "assets/linearts/purra/colorable.png",
};

const MAX_HISTORY = 20;

const linesCanvas = document.getElementById("linesCanvas");
const paintCanvas = document.getElementById("paintCanvas");
const linesCtx = linesCanvas.getContext("2d");
const paintCtx = paintCanvas.getContext("2d");

const colorPicker = document.getElementById("colorPicker");
const brushSize = document.getElementById("brushSize");
const clearBtn = document.getElementById("clearBtn");
const undoBtn = document.getElementById("undoBtn");
const redoBtn = document.getElementById("redoBtn");
const toolButtons = document.querySelectorAll(".tool-btn");

// Offscreen canvases: one holds the raw brush/eraser strokes (unclipped),
// the other holds the colorable-area mask. Every time a stroke changes we
// recombine them so only the parts inside the mask ever become visible.
const strokesCanvas = document.createElement("canvas");
const strokesCtx = strokesCanvas.getContext("2d");
const maskCanvas = document.createElement("canvas");
const maskCtx = maskCanvas.getContext("2d");

let currentTool = "brush";
let isDrawing = false;
let lastPoint = null;

// Connected-component labeling of the mask, so the fill tool can color
// just the shape that was clicked instead of the whole mask at once.
let regionLabelMap = null; // Int32Array, 0 = not colorable, >0 = region id

let history = [];
let historyIndex = -1;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function init() {
  const [linesImg, colorableImg] = await Promise.all([
    loadImage(CURRENT_LINEART.lines),
    loadImage(CURRENT_LINEART.colorable),
  ]);

  const width = linesImg.naturalWidth;
  const height = linesImg.naturalHeight;

  for (const canvas of [linesCanvas, paintCanvas, strokesCanvas, maskCanvas]) {
    canvas.width = width;
    canvas.height = height;
  }

  linesCtx.drawImage(linesImg, 0, 0);
  maskCtx.drawImage(colorableImg, 0, 0);

  regionLabelMap = computeRegionLabels(maskCtx, width, height);

  compositePaint();
  recordHistory();
  attachPointerHandlers();
  attachToolbarHandlers();
}

// Redraws paintCanvas from strokesCanvas, clipped to maskCanvas's shape.
function compositePaint() {
  paintCtx.clearRect(0, 0, paintCanvas.width, paintCanvas.height);
  paintCtx.globalCompositeOperation = "source-over";
  paintCtx.drawImage(strokesCanvas, 0, 0);
  paintCtx.globalCompositeOperation = "destination-in";
  paintCtx.drawImage(maskCanvas, 0, 0);
  paintCtx.globalCompositeOperation = "source-over";
}

// Groups the mask's opaque pixels into connected shapes (flood fill), so
// the fill tool only colors the one shape that was clicked. For the
// current single-piece lineart this is one big region, but this keeps
// the fill tool correct once linearts have separate colorable pieces.
function computeRegionLabels(ctx, width, height) {
  const { data } = ctx.getImageData(0, 0, width, height);
  const total = width * height;
  const labelMap = new Int32Array(total);
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);

  const isColorable = (idx) => data[idx * 4 + 3] > 128;

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

  return labelMap;
}

function hexToRgb(hex) {
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function getCanvasPoint(evt) {
  const rect = linesCanvas.getBoundingClientRect();
  const scaleX = linesCanvas.width / rect.width;
  const scaleY = linesCanvas.height / rect.height;
  return {
    x: (evt.clientX - rect.left) * scaleX,
    y: (evt.clientY - rect.top) * scaleY,
  };
}

function drawStrokeSegment(from, to) {
  strokesCtx.globalCompositeOperation =
    currentTool === "eraser" ? "destination-out" : "source-over";
  strokesCtx.strokeStyle = colorPicker.value;
  strokesCtx.lineWidth = Number(brushSize.value);
  strokesCtx.lineCap = "round";
  strokesCtx.lineJoin = "round";
  strokesCtx.beginPath();
  strokesCtx.moveTo(from.x, from.y);
  strokesCtx.lineTo(to.x, to.y);
  strokesCtx.stroke();
  strokesCtx.globalCompositeOperation = "source-over";
}

function fillRegionAt(point) {
  const x = Math.floor(point.x);
  const y = Math.floor(point.y);
  if (x < 0 || y < 0 || x >= strokesCanvas.width || y >= strokesCanvas.height) {
    return;
  }

  const idx = y * strokesCanvas.width + x;
  const label = regionLabelMap[idx];
  if (label === 0) return; // clicked outside the colorable area

  const imageData = strokesCtx.getImageData(0, 0, strokesCanvas.width, strokesCanvas.height);
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

  strokesCtx.putImageData(imageData, 0, 0);
  compositePaint();
  recordHistory();
}

function attachPointerHandlers() {
  linesCanvas.addEventListener("pointerdown", (evt) => {
    const point = getCanvasPoint(evt);

    if (currentTool === "fill") {
      fillRegionAt(point);
      return;
    }

    isDrawing = true;
    lastPoint = point;
    // Draw a dot for a single click/tap, not just drags.
    drawStrokeSegment(lastPoint, lastPoint);
    compositePaint();
    linesCanvas.setPointerCapture(evt.pointerId);
  });

  linesCanvas.addEventListener("pointermove", (evt) => {
    if (!isDrawing) return;
    const point = getCanvasPoint(evt);
    drawStrokeSegment(lastPoint, point);
    lastPoint = point;
    compositePaint();
  });

  function endStroke() {
    if (!isDrawing) return;
    isDrawing = false;
    lastPoint = null;
    recordHistory();
  }

  linesCanvas.addEventListener("pointerup", endStroke);
  linesCanvas.addEventListener("pointercancel", endStroke);
  linesCanvas.addEventListener("pointerleave", endStroke);
}

function attachToolbarHandlers() {
  toolButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      currentTool = btn.dataset.tool;
      toolButtons.forEach((b) => b.classList.toggle("active", b === btn));
    });
  });

  clearBtn.addEventListener("click", () => {
    strokesCtx.clearRect(0, 0, strokesCanvas.width, strokesCanvas.height);
    compositePaint();
    recordHistory();
  });

  undoBtn.addEventListener("click", undo);
  redoBtn.addEventListener("click", redo);
}

// --- Undo / redo -----------------------------------------------------
// history holds full snapshots of strokesCanvas. historyIndex points at
// the snapshot currently shown. Undo/redo just move that pointer and
// restore the snapshot at it; a new action after undoing discards the
// redo branch, same as most drawing apps.

function recordHistory() {
  const snapshot = strokesCtx.getImageData(0, 0, strokesCanvas.width, strokesCanvas.height);

  history = history.slice(0, historyIndex + 1);
  history.push(snapshot);

  if (history.length > MAX_HISTORY) {
    history.shift();
  }
  historyIndex = history.length - 1;

  updateHistoryButtons();
}

function restoreHistory(index) {
  historyIndex = index;
  strokesCtx.putImageData(history[historyIndex], 0, 0);
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
