/* The signature modal: two tabs, both required to work.

   Each typed face is a REAL system font stack, not just `cursive`. If every
   option falls back to the same generic face, all four render identically and
   look like a bug. */
export const FACES = [
  { id: 'brush',    label: 'Brush',    stack: '"Segoe Script","Bradley Hand","Brush Script MT","Lucida Handwriting",cursive' },
  { id: 'formal',   label: 'Formal',   stack: '"Palatino Linotype","Book Antiqua",Palatino,"URW Palladio L",Georgia,serif' },
  { id: 'casual',   label: 'Casual',   stack: '"Comic Sans MS","Chalkboard SE","Segoe Print","Marker Felt",cursive' },
  { id: 'monoline', label: 'Monoline', stack: '"Gabriola","Edwardian Script ITC","Snell Roundhand","Apple Chancery",cursive' },
];

// Minimum ink travel before a drawing counts. Without it a stray click
// registers as a signature.
const MIN_INK_PX = 24;

const RENDER_SCALE = 3; // stamp at 3x so the signature is not soft in the PDF

export function createSignatureMaker({ signerName, onAccept }) {
  const modal = document.getElementById('sigModal');
  let tab = 'type';
  let chosenFace = FACES[0].id;
  let typedText = signerName || '';

  // --- draw state ---
  let drawing = false, inkTravel = 0, lastX = 0, lastY = 0, hasStrokes = false;

  const els = {
    tabType:  document.getElementById('tabType'),
    tabDraw:  document.getElementById('tabDraw'),
    paneType: document.getElementById('paneType'),
    paneDraw: document.getElementById('paneDraw'),
    input:    document.getElementById('typedInput'),
    faces:    document.getElementById('faceList'),
    canvas:   document.getElementById('drawCanvas'),
    clear:    document.getElementById('clearDraw'),
    accept:   document.getElementById('acceptSig'),
    cancel:   document.getElementById('cancelSig'),
    hint:     document.getElementById('drawHint'),
  };

  const ctx = els.canvas.getContext('2d');

  function sizeCanvas() {
    const rect = els.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    // Preserve any existing ink across a resize.
    const prev = hasStrokes ? els.canvas.toDataURL() : null;
    els.canvas.width = Math.floor(rect.width * dpr);
    els.canvas.height = Math.floor(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#111827';
    if (prev) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, rect.width, rect.height);
      img.src = prev;
    }
  }

  function renderFaces() {
    const sample = typedText || signerName || 'Your name';
    els.faces.innerHTML = '';
    for (const f of FACES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'face' + (f.id === chosenFace ? ' selected' : '');
      btn.dataset.face = f.id;
      /* Set the stack as a property, not an inline style attribute: the family
         names carry double quotes, which would close the attribute early and
         void the declaration - every face would fall back to the same font and
         all four would look identical. */
      btn.style.fontFamily = f.stack;

      const s = document.createElement('span');
      s.className = 'face-sample';
      s.textContent = sample;

      const n = document.createElement('span');
      n.className = 'face-name';
      n.textContent = f.label;

      btn.append(s, n);
      els.faces.appendChild(btn);
    }
  }

  function pos(e) {
    const r = els.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function startDraw(e) {
    drawing = true;
    els.canvas.setPointerCapture(e.pointerId);
    const p = pos(e);
    lastX = p.x; lastY = p.y;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    e.preventDefault();
  }

  function moveDraw(e) {
    if (!drawing) return;
    const p = pos(e);
    inkTravel += Math.hypot(p.x - lastX, p.y - lastY);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    lastX = p.x; lastY = p.y;
    hasStrokes = true;
    updateState();
    e.preventDefault();
  }

  function endDraw(e) {
    if (!drawing) return;
    drawing = false;
    try { els.canvas.releasePointerCapture(e.pointerId); } catch {}
    updateState();
  }

  function drawValid() { return hasStrokes && inkTravel >= MIN_INK_PX; }
  function typeValid() { return typedText.trim().length > 0; }
  function valid() { return tab === 'type' ? typeValid() : drawValid(); }

  function updateState() {
    els.accept.disabled = !valid();
    if (tab === 'draw') {
      els.hint.textContent = hasStrokes && !drawValid()
        ? 'That is too short to be a signature - draw a little more.'
        : 'Draw your signature above using a mouse, trackpad or finger.';
      els.hint.classList.toggle('warn', hasStrokes && !drawValid());
    }
  }

  function setTab(next) {
    tab = next;
    els.tabType.classList.toggle('active', next === 'type');
    els.tabDraw.classList.toggle('active', next === 'draw');
    els.paneType.hidden = next !== 'type';
    els.paneDraw.hidden = next !== 'draw';
    if (next === 'draw') sizeCanvas();
    updateState();
  }

  /* Render the typed name to a transparent canvas so both tabs hand back the
     same thing: a PNG data URL. */
  function typedToDataUrl() {
    const face = FACES.find((f) => f.id === chosenFace);
    const c = document.createElement('canvas');
    const w = 600, h = 200;
    c.width = w * RENDER_SCALE; c.height = h * RENDER_SCALE;
    const g = c.getContext('2d');
    g.scale(RENDER_SCALE, RENDER_SCALE);
    g.fillStyle = '#111827';
    g.textAlign = 'center';
    g.textBaseline = 'middle';

    // Shrink to fit rather than overflow the box.
    let size = 84;
    do {
      g.font = `${size}px ${face.stack}`;
      if (g.measureText(typedText).width <= w - 40) break;
      size -= 4;
    } while (size > 20);

    g.fillText(typedText, w / 2, h / 2);
    return c.toDataURL('image/png');
  }

  /* Crop the drawing to its ink, so a signature drawn small in the corner is
     not stamped as mostly empty space. */
  function drawnToDataUrl() {
    const src = els.canvas;
    const g = src.getContext('2d');
    const { width, height } = src;
    const data = g.getImageData(0, 0, width, height).data;

    let minX = width, minY = height, maxX = 0, maxY = 0, found = false;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] > 8) {
          found = true;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (!found) return src.toDataURL('image/png');

    const pad = 8;
    minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
    maxX = Math.min(width, maxX + pad); maxY = Math.min(height, maxY + pad);

    const out = document.createElement('canvas');
    out.width = maxX - minX; out.height = maxY - minY;
    out.getContext('2d').drawImage(src, minX, minY, out.width, out.height,
                                        0, 0, out.width, out.height);
    return out.toDataURL('image/png');
  }

  function clearDraw() {
    ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
    inkTravel = 0; hasStrokes = false;
    updateState();
  }

  // --- wiring ---
  els.tabType.onclick = () => setTab('type');
  els.tabDraw.onclick = () => setTab('draw');
  els.input.oninput = (e) => { typedText = e.target.value; renderFaces(); updateState(); };
  els.faces.onclick = (e) => {
    const b = e.target.closest('[data-face]');
    if (!b) return;
    chosenFace = b.dataset.face;
    renderFaces();
  };
  els.canvas.addEventListener('pointerdown', startDraw);
  els.canvas.addEventListener('pointermove', moveDraw);
  els.canvas.addEventListener('pointerup', endDraw);
  els.canvas.addEventListener('pointercancel', endDraw);
  els.canvas.addEventListener('pointerleave', endDraw);
  els.clear.onclick = clearDraw;
  els.cancel.onclick = close;
  els.accept.onclick = () => {
    if (!valid()) return;
    const dataUrl = tab === 'type' ? typedToDataUrl() : drawnToDataUrl();
    onAccept({ dataUrl, method: tab === 'type' ? 'Typed' : 'Drawn' });
    close();
  };
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) close();
  });

  function open() {
    modal.hidden = false;
    els.input.value = typedText;
    renderFaces();
    setTab('type');
    els.input.focus();
  }
  function close() { modal.hidden = true; }

  return { open, close };
}
