// canvas-pan-zoom.js — shared pan/zoom for canvas or plain-element views.
// Tracks scale/offset in "world" (DXF-space) units and exposes world<->screen
// conversions plus a fit-to-view helper, so each view only owns its draw logic.

(function () {
  class CanvasPanZoom {
    constructor(el, opts = {}) {
      this.el = el;
      this.onRedraw = opts.onRedraw || function () {};
      this.scale = 1;
      this.offsetX = 0;
      this.offsetY = 0;
      this.bounds = null; // [xmin, ymin, xmax, ymax] in world space

      this._dragging = false;
      this._lastX = 0;
      this._lastY = 0;

      el.addEventListener('wheel', (ev) => this._onWheel(ev), { passive: false });
      el.addEventListener('mousedown', (ev) => this._onMouseDown(ev));
      window.addEventListener('mousemove', (ev) => this._onMouseMove(ev));
      window.addEventListener('mouseup', () => { this._dragging = false; });
    }

    _elSize() {
      const w = this.el.width || this.el.clientWidth;
      const h = this.el.height || this.el.clientHeight;
      return [w, h];
    }

    fitToView(bounds) {
      this.bounds = bounds;
      const [xmin, ymin, xmax, ymax] = bounds;
      const [w, h] = this._elSize();
      const bw = Math.max(xmax - xmin, 1e-6);
      const bh = Math.max(ymax - ymin, 1e-6);
      this.scale = Math.min(w / bw, h / bh) * 0.9;
      this.offsetX = (w - bw * this.scale) / 2 - xmin * this.scale;
      this.offsetY = (h - bh * this.scale) / 2 - ymin * this.scale;
      this.onRedraw();
    }

    worldToScreen(x, y) {
      const [, h] = this._elSize();
      const sx = x * this.scale + this.offsetX;
      const sy = h - (y * this.scale + this.offsetY);
      return [sx, sy];
    }

    screenToWorld(px, py) {
      const [, h] = this._elSize();
      const x = (px - this.offsetX) / this.scale;
      const y = (h - py - this.offsetY) / this.scale;
      return [x, y];
    }

    _onWheel(ev) {
      ev.preventDefault();
      const rect = this.el.getBoundingClientRect();
      const px = ev.clientX - rect.left;
      const py = ev.clientY - rect.top;
      const [wx, wy] = this.screenToWorld(px, py);

      const zoomFactor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
      this.scale *= zoomFactor;

      // Keep the point under the cursor fixed on screen.
      const [, h] = this._elSize();
      this.offsetX = px - wx * this.scale;
      this.offsetY = (h - py) - wy * this.scale;

      this.onRedraw();
    }

    _onMouseDown(ev) {
      this._dragging = true;
      this._lastX = ev.clientX;
      this._lastY = ev.clientY;
    }

    // Lets a consumer veto the pan that just started on this mousedown,
    // e.g. because the press landed on a draggable icon instead of empty canvas.
    cancelDrag() {
      this._dragging = false;
    }

    _onMouseMove(ev) {
      if (!this._dragging) return;
      const dx = ev.clientX - this._lastX;
      const dy = ev.clientY - this._lastY;
      this._lastX = ev.clientX;
      this._lastY = ev.clientY;
      this.offsetX += dx;
      this.offsetY -= dy;
      this.onRedraw();
    }
  }

  window.CanvasPanZoom = CanvasPanZoom;
})();
