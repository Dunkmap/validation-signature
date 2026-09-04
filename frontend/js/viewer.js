/* Renders the document with PDF.js and overlays the signature box.

   PDF.js RENDERS for display. pdf-lib WRITES into the file. They do opposite
   jobs - do not reach for one where the other belongs. */

const { pdfjsLib } = window;
pdfjsLib.GlobalWorkerOptions.workerSrc =
  '/vendor/pdf.worker.min.js';

/* THE COORDINATE TRAP.

   A browser measures y DOWNWARD from the top. A PDF measures y UPWARD from the
   bottom. Boxes arrive in PDF points and must be flipped to sit on screen.
   Get this wrong and the box appears mirrored down the page - first thing to
   check if a box looks misplaced. */
export function boxToCssPercent(box, pageWidth, pageHeight) {
  return {
    left:   (box.x / pageWidth) * 100 + '%',
    top:    ((pageHeight - box.y - box.h) / pageHeight) * 100 + '%',
    width:  (box.w / pageWidth) * 100 + '%',
    height: (box.h / pageHeight) * 100 + '%',
  };
}

/* If the worker script cannot be fetched, PDF.js neither resolves nor rejects -
   the page would sit on "Loading..." forever with nothing said. Never let a
   failure be silent: time it out and surface it. */
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]);
}

export async function renderDocument(bytes, container, box) {
  container.innerHTML = '';
  // PDF.js transfers ownership of the buffer it is given, which would empty the
  // copy we still need for pdf-lib. Hand it a throwaway slice.
  const doc = await withTimeout(
    pdfjsLib.getDocument({ data: bytes.slice(0) }).promise,
    30000,
    'The document viewer did not start. Check your connection and reload the page.',
  );
  const pages = [];

  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale: 1 });
    const scale = Math.min(2, (container.clientWidth || 900) / viewport.width);
    const scaled = page.getViewport({ scale: scale * (window.devicePixelRatio || 1) });

    const wrap = document.createElement('div');
    wrap.className = 'page-wrap';

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(scaled.width);
    canvas.height = Math.floor(scaled.height);
    canvas.style.width = '100%';
    canvas.style.display = 'block';

    wrap.appendChild(canvas);
    container.appendChild(wrap);

    await page.render({ canvasContext: canvas.getContext('2d'), viewport: scaled }).promise;

    // The box lives on exactly one page.
    if (box && box.page === n) {
      const el = document.createElement('div');
      el.className = 'sig-box';
      el.id = 'sigBox';
      Object.assign(el.style, boxToCssPercent(box, viewport.width, viewport.height));
      el.innerHTML = '<span class="sig-box-label">Your signature</span>';
      wrap.appendChild(el);
      pages.push({ n, wrap, el });
    }
  }

  return { numPages: doc.numPages, boxPage: pages[0] || null };
}

/* Drop the chosen signature image into the on-screen box, so what the signer
   sees before submitting matches what pdf-lib is about to stamp. */
export function previewSignature(dataUrl) {
  const el = document.getElementById('sigBox');
  if (!el) return;
  el.classList.add('filled');
  el.innerHTML = `<img src="${dataUrl}" alt="Your signature">`;
}

export function scrollToBox() {
  document.getElementById('sigBox')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
