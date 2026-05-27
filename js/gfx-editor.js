// ---------------------------------------------------------------------------
// GfxEditor 类 — 瓦片/精灵编辑器
// ---------------------------------------------------------------------------

const COLORS = [0xffc2f0c4, 0xffa8b95a, 0xff6e601e, 0xff001b2d];

export class GfxEditor {
  /**
   * @param {object} opts
   * @param {string} opts.parentDivId          父容器 ID
   * @param {string} opts.tilesCanvasId        瓦片列表 canvas ID
   * @param {string} opts.drawCanvasId         绘制区 canvas ID
   * @param {string} opts.paletteCanvasId      调色板 canvas ID
   * @param {import('./storage.js').Storage} opts.storage  文件仓库实例
   * @param {Function} opts.onFileChange       文件内容变更回调
   */
  constructor({ parentDivId, tilesCanvasId, drawCanvasId, paletteCanvasId, storage, onFileChange }) {
    this.storage = storage;
    this.onFileChange = onFileChange || (() => {});

    this.mainDiv = document.getElementById(parentDivId);
    this.tileCanvas = document.getElementById(tilesCanvasId);
    this.drawCanvas = document.getElementById(drawCanvasId);
    this.paletteCanvas = document.getElementById(paletteCanvasId);

    this.currentFile = null;
    this.currentTileIndex = 0;
    this.selectedColor = 0;

    this._bindEvents();
    this._updatePalette();
  }

  // ---- 事件绑定 ----

  _bindEvents() {
    const self = this;

    this.drawCanvas.onmousemove = function (e) {
      const rect = e.target.getBoundingClientRect();
      const x = ~~(((e.clientX - rect.left) / rect.width) * e.target.width);
      const y = ~~(((e.clientY - rect.top) / rect.height) * e.target.height);
      e.preventDefault();
      if (e.buttons === 0) return;
      self._drawPixel(x, y, self.selectedColor);
    };
    this.drawCanvas.onmousedown = this.drawCanvas.onmousemove;
    this.drawCanvas.oncontextmenu = () => false;

    this.paletteCanvas.onmousedown = function (e) {
      const rect = e.target.getBoundingClientRect();
      const x = ~~((((e.clientX - rect.left) / rect.width) * e.target.width) / 16);
      const y = ~~((((e.clientY - rect.top) / rect.height) * e.target.height) / 16);
      e.preventDefault();
      self.selectedColor = y;
      self._updatePalette();
    };

    this.tileCanvas.onmousedown = function (e) {
      const rect = e.target.getBoundingClientRect();
      const x = ~~((((e.clientX - rect.left) / rect.width) * e.target.width) / 8);
      const y = ~~((((e.clientY - rect.top) / rect.height) * e.target.height) / 8);
      e.preventDefault();
      self.setTileIndex(x + y * 16);
    };
  }

  // ---- 文件载入 ----

  setCurrentFile(filename) {
    this.currentFile = filename;
    this.setTileIndex(0);

    const data = this.storage.getFiles()[filename];
    const tileCount = ~~(data.length / 16);
    const rowCount = ~~((tileCount + 15) / 16);
    this.tileCanvas.width = 16 * 8;
    this.tileCanvas.height = rowCount * 8;
    this.tileCanvas.style.width = this.tileCanvas.width * 4 + 'px';

    const ctx = this.tileCanvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, this.tileCanvas.width, this.tileCanvas.height);
    const pixels = new Uint32Array(imageData.data.buffer);
    const pitch = this.tileCanvas.width;

    for (let n = 0; n < tileCount; n++) {
      const col = n % 16;
      const row = ~~(n / 16);
      const pixelIndex = col * 8 + row * 8 * pitch;
      _decodeTile(new Uint8Array(data.buffer, n * 16, 16), pixels, pixelIndex, pitch);
    }
    ctx.putImageData(imageData, 0, 0);
  }

  // ---- 选中瓦片 ----

  setTileIndex(index) {
    const data = this.storage.getFiles()[this.currentFile];
    const maxIndex = data.length / 16 - 1;
    if (index > maxIndex) index = maxIndex;
    this.currentTileIndex = index;

    const ctx = this.drawCanvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, this.drawCanvas.width, this.drawCanvas.height);
    const pixels = new Uint32Array(imageData.data.buffer);
    _decodeTile(new Uint8Array(data.buffer, index * 16, 16), pixels, 0, 8);
    ctx.putImageData(imageData, 0, 0);
  }

  // ---- 显隐 ----

  hide() {
    this.mainDiv.style.display = 'none';
  }

  show() {
    this.mainDiv.style.display = '';
  }

  // ---- 内部方法 ----

  _drawPixel(x, y, color) {
    const data = this.storage.getFiles()[this.currentFile];
    const offset = this.currentTileIndex * 16;

    if (color & 1) data[offset + y * 2 + 0] |= 0x80 >> x;
    else           data[offset + y * 2 + 0] &= ~(0x80 >> x);
    if (color & 2) data[offset + y * 2 + 1] |= 0x80 >> x;
    else           data[offset + y * 2 + 1] &= ~(0x80 >> x);

    this.setTileIndex(this.currentTileIndex);
    this.storage.update(this.currentFile, data);
    this.onFileChange();

    // 同步更新瓦片列表
    const ctx = this.tileCanvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, this.tileCanvas.width, this.tileCanvas.height);
    const pixels = new Uint32Array(imageData.data.buffer);
    const pitch = this.tileCanvas.width;
    const col = this.currentTileIndex % 16;
    const row = ~~(this.currentTileIndex / 16);
    const pixelIndex = col * 8 + row * 8 * pitch;
    _decodeTile(new Uint8Array(data.buffer, offset, 16), pixels, pixelIndex, pitch);
    ctx.putImageData(imageData, 0, 0);
  }

  _updatePalette() {
    const ctx = this.paletteCanvas.getContext('2d');
    for (let n = 0; n < 4; n++) {
      const c = COLORS[n];
      ctx.fillStyle = `rgb(${c & 0xff}, ${(c >> 8) & 0xff}, ${(c >> 16) & 0xff})`;
      ctx.fillRect(0, n * 16, 16, 16);
    }
    ctx.strokeStyle = '#FFF';
    ctx.beginPath();
    ctx.rect(2.5, this.selectedColor * 16 + 2.5, 11, 11);
    ctx.stroke();
    ctx.strokeStyle = '#000';
    ctx.beginPath();
    ctx.rect(1.5, this.selectedColor * 16 + 1.5, 13, 13);
    ctx.stroke();
  }
}

// ---- 静态工具函数 ----

function _decodeTile(data, pixels, pixelIndex, pitch) {
  for (let y = 0; y < 8; y++) {
    const a = data[y * 2];
    const b = data[y * 2 + 1];
    for (let x = 0; x < 8; x++) {
      let c = 0;
      if (a & (0x80 >> x)) c |= 1;
      if (b & (0x80 >> x)) c |= 2;
      pixels[pixelIndex + x + y * pitch] = COLORS[c];
    }
  }
}

// ---------------------------------------------------------------------------
// 向后兼容：模块级导出（代理到默认单例）
// ---------------------------------------------------------------------------

let _defaultInstance = null;

export function setDefaultInstance(inst) { _defaultInstance = inst; }
export function setCurrentFile(fn)    { if (_defaultInstance) _defaultInstance.setCurrentFile(fn); }
export function setTileIndex(idx)     { if (_defaultInstance) _defaultInstance.setTileIndex(idx); }
export function hide()                { if (_defaultInstance) _defaultInstance.hide(); }
export function show()                { if (_defaultInstance) _defaultInstance.show(); }
export function getInstance()         { return _defaultInstance; }