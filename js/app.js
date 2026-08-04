// The lineart currently loaded. Later this will be picked from a gallery
// of multiple linearts, but for now we just load Purra directly.
const CURRENT_LINEART = {
  id: "purra",
  name: "Purra",
  lines: "assets/linearts/purra/lines.png",
  colorable: "assets/linearts/purra/colorable.png",
};

const linesCanvas = document.getElementById("linesCanvas");
const paintCanvas = document.getElementById("paintCanvas");
const linesCtx = linesCanvas.getContext("2d");
const paintCtx = paintCanvas.getContext("2d");

const colorPicker = document.getElementById("colorPicker");
const brushSize = document.getElementById("brushSize");
const clearBtn = document.getElementById("clearBtn");

// Offscreen canvases: one holds the raw brush strokes (unclipped), the
// other holds the colorable-area mask. Every time a stroke changes we
// recombine them so only the parts inside the mask ever become visible.
const strokesCanvas = document.createElement("canvas");
const strokesCtx = strokesCanvas.getContext("2d");
const maskCanvas = document.createElement("canvas");
const maskCtx = maskCanvas.getContext("2d");

let isDrawing = false;
let lastPoint = null;

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

  compositePaint();
  attachPointerHandlers();
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
  strokesCtx.strokeStyle = colorPicker.value;
  strokesCtx.lineWidth = Number(brushSize.value);
  strokesCtx.lineCap = "round";
  strokesCtx.lineJoin = "round";
  strokesCtx.beginPath();
  strokesCtx.moveTo(from.x, from.y);
  strokesCtx.lineTo(to.x, to.y);
  strokesCtx.stroke();
}

function attachPointerHandlers() {
  linesCanvas.addEventListener("pointerdown", (evt) => {
    isDrawing = true;
    lastPoint = getCanvasPoint(evt);
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

  function endStroke(evt) {
    if (!isDrawing) return;
    isDrawing = false;
    lastPoint = null;
  }

  linesCanvas.addEventListener("pointerup", endStroke);
  linesCanvas.addEventListener("pointercancel", endStroke);
  linesCanvas.addEventListener("pointerleave", endStroke);
}

clearBtn.addEventListener("click", () => {
  strokesCtx.clearRect(0, 0, strokesCanvas.width, strokesCanvas.height);
  compositePaint();
});

init();
