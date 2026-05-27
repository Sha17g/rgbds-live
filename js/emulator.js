import Binjgb from '../binjgb/out/binjgb.js';

// WASM module is read-only and shared across all Emulator instances
const Module = await Binjgb();

// ---------------------------------------------------------------------------
// Module-level serial callback — WASM calls this function by name directly.
// Forwards to the current active instance's onSerial callback.
// ---------------------------------------------------------------------------
let _serialRelay = null;

export function serialCallback(value) {
  if (_serialRelay) _serialRelay(value);
}

export class Emulator {
  // -----------------------------------------------------------------------
  // Instance properties
  // -----------------------------------------------------------------------

  /** @type {number|undefined} WASM emulator pointer */
  e;

  /** @type {number} Allocated ROM size */
  romSize = 0;

  /** @type {CanvasRenderingContext2D|null} Main screen canvas 2D context */
  canvasCtx = null;

  /** @type {ImageData|null} Main screen image data */
  canvasImageData = null;

  /** @type {AudioContext|null} Web Audio context */
  audioCtx = null;

  /** @type {number} Audio time base */
  audioTime = 0;

  /** @type {Function|null} Serial output callback */
  onSerial = null;

  /** @type {number} Audio buffer size */
  audioBufferSize = 2048;

  // -----------------------------------------------------------------------
  // Initialization / Destruction
  // -----------------------------------------------------------------------

  /**
   * Initialize the emulator
   * @param {HTMLCanvasElement|null} canvas Render target canvas
   * @param {Uint8Array} romData ROM data
   */
  init(canvas, romData) {
    if (this.isAvailable()) this.destroy();

    if (!this.audioCtx) this.audioCtx = new AudioContext();

    const requiredSize = ((romData.length - 1) | 0x3fff) + 1;
    const size = requiredSize < 0x8000 ? 0x8000 : requiredSize;
    const romPtr = Module._malloc(size);
    this.romSize = size;

    const romView = Module.HEAP8.subarray(romPtr, romPtr + size);
    romView.fill(0);
    romView.set(romData);

    this.e = Module._emulator_new_simple(romPtr, size, this.audioCtx.sampleRate, this.audioBufferSize);
    Module._emulator_set_bw_palette_simple(this.e, 0, 0xffc2f0c4, 0xffa8b95a, 0xff6e601e, 0xff001b2d);
    Module._emulator_set_bw_palette_simple(this.e, 1, 0xffc2f0c4, 0xffa8b95a, 0xff6e601e, 0xff001b2d);
    Module._emulator_set_bw_palette_simple(this.e, 2, 0xffc2f0c4, 0xffa8b95a, 0xff6e601e, 0xff001b2d);
    Module._emulator_set_default_joypad_callback(this.e, 0);

    if (canvas) {
      this.canvasCtx = canvas.getContext('2d');
      this.canvasImageData = this.canvasCtx.createImageData(canvas.width, canvas.height);
    }

    this.audioCtx.resume();
    this.audioTime = this.audioCtx.currentTime;
  }

  destroy() {
    if (!this.isAvailable()) return;
    Module._emulator_delete(this.e);
    this.e = undefined;
    this.canvasCtx = null;
    this.canvasImageData = null;
    this.romSize = 0;
  }

  isAvailable() {
    return typeof this.e !== 'undefined';
  }

  // -----------------------------------------------------------------------
  // Execution control
  // -----------------------------------------------------------------------

  /**
   * Run the emulator for a specified step type.
   * @param {string} stepType 'single' | 'frame' | 'run'
   * @returns {boolean} Whether a breakpoint or illegal instruction was hit
   */
  step(stepType) {
    if (!this.isAvailable()) return;
    let ticks = Module._emulator_get_ticks_f64(this.e);
    if (stepType === 'single') ticks += 1;
    else if (stepType === 'frame') ticks += 70224;

    // Route serial callback to the current instance
    _serialRelay = (value) => { if (this.onSerial) this.onSerial(value); };

    while (true) {
      const result = Module._emulator_run_until_f64(this.e, ticks);
      if (result & 2) this._processAudioBuffer();
      if (result & 8) { _serialRelay = null; return true; }  // breakpoint
      if (result & 16) { _serialRelay = null; return true; } // illegal instruction
      if (result !== 2 && stepType !== 'run') { _serialRelay = null; return false; }
      if (stepType === 'run') {
        if (result & 4) {
          if (this.audioTime < this.audioCtx.currentTime + 0.1) ticks += 70224;
          else { _serialRelay = null; return false; }
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Rendering
  // -----------------------------------------------------------------------

  renderScreen() {
    if (!this.isAvailable()) return;
    const buffer = new Uint8Array(
      Module.HEAP8.buffer,
      Module._get_frame_buffer_ptr(this.e),
      Module._get_frame_buffer_size(this.e),
    );
    this.canvasImageData.data.set(buffer);
    this.canvasCtx.putImageData(this.canvasImageData, 0, 0);
  }

  renderVRam(canvas) {
    if (!this.isAvailable()) return;
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(256, 256);
    const ptr = Module._malloc(4 * 256 * 256);
    Module._emulator_render_vram(this.e, ptr);
    const buffer = new Uint8Array(Module.HEAP8.buffer, ptr, 4 * 256 * 256);
    imageData.data.set(buffer);
    ctx.putImageData(imageData, 0, 0);
    Module._free(ptr);
  }

  renderBackground(canvas, type) {
    if (!this.isAvailable()) return;
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(256, 256);
    const ptr = Module._malloc(4 * 256 * 256);
    Module._emulator_render_background(this.e, ptr, type);
    const buffer = new Uint8Array(Module.HEAP8.buffer, ptr, 4 * 256 * 256);
    imageData.data.set(buffer);
    ctx.putImageData(imageData, 0, 0);
    Module._free(ptr);
  }

  // -----------------------------------------------------------------------
  // Memory access
  // -----------------------------------------------------------------------

  getWRam() {
    if (!this.isAvailable()) return;
    const ptr = Module._emulator_get_wram_ptr(this.e);
    return new Uint8Array(Module.HEAP8.buffer, ptr, 0x8000);
  }

  getHRam() {
    if (!this.isAvailable()) return;
    const ptr = Module._emulator_get_hram_ptr(this.e);
    return new Uint8Array(Module.HEAP8.buffer, ptr, 0x7f);
  }

  readMem(addr) {
    if (!this.isAvailable()) return 0xff;
    return Module._emulator_read_mem(this.e, addr);
  }

  writeMem(addr, data) {
    if (!this.isAvailable()) return;
    Module._emulator_write_mem(this.e, addr, data);
  }

  // -----------------------------------------------------------------------
  // CPU registers
  // -----------------------------------------------------------------------

  getPC()  { return Module._emulator_get_PC(this.e); }
  setPC(v) { Module._emulator_set_PC(this.e, v); }
  getSP()  { return Module._emulator_get_SP(this.e); }
  getA()   { return Module._emulator_get_A(this.e); }
  getBC()  { return Module._emulator_get_BC(this.e); }
  getDE()  { return Module._emulator_get_DE(this.e); }
  getHL()  { return Module._emulator_get_HL(this.e); }

  getFlags() {
    const flags = Module._emulator_get_F(this.e);
    let result = '';
    if (flags & 0x80) result += 'Z ';
    if (flags & 0x10) result += 'C ';
    if (flags & 0x20) result += 'H ';
    if (flags & 0x40) result += 'N ';
    return result;
  }

  // -----------------------------------------------------------------------
  // Breakpoints
  // -----------------------------------------------------------------------

  setBreakpoint(pc) {
    if (!this.isAvailable()) return;
    Module._emulator_set_breakpoint(this.e, pc);
  }

  clearBreakpoints() {
    if (!this.isAvailable()) return;
    Module._emulator_clear_breakpoints(this.e);
  }

  // -----------------------------------------------------------------------
  // Joypad input
  // -----------------------------------------------------------------------

  setKeyPad(key, down) {
    if (!this.isAvailable()) return;
    if (key === 'right')  Module._set_joyp_right(this.e, down);
    if (key === 'left')   Module._set_joyp_left(this.e, down);
    if (key === 'up')     Module._set_joyp_up(this.e, down);
    if (key === 'down')   Module._set_joyp_down(this.e, down);
    if (key === 'a')      Module._set_joyp_A(this.e, down);
    if (key === 'b')      Module._set_joyp_B(this.e, down);
    if (key === 'select') Module._set_joyp_select(this.e, down);
    if (key === 'start')  Module._set_joyp_start(this.e, down);
  }

  // -----------------------------------------------------------------------
  // Serial output
  // -----------------------------------------------------------------------

  /**
   * Set the serial output callback.
   * @param {Function} callback Callback function (value) => void
   */
  setSerialCallback(callback) {
    this.onSerial = callback;
  }

  // -----------------------------------------------------------------------
  // Internal: Audio processing
  // -----------------------------------------------------------------------

  _processAudioBuffer() {
    if (this.audioTime < this.audioCtx.currentTime) this.audioTime = this.audioCtx.currentTime;

    const inputBuffer = new Uint8Array(
      Module.HEAP8.buffer,
      Module._get_audio_buffer_ptr(this.e),
      Module._get_audio_buffer_capacity(this.e),
    );
    const volume = 0.5;
    const buffer = this.audioCtx.createBuffer(2, this.audioBufferSize, this.audioCtx.sampleRate);
    const channel0 = buffer.getChannelData(0);
    const channel1 = buffer.getChannelData(1);

    for (let i = 0; i < this.audioBufferSize; i++) {
      channel0[i] = (inputBuffer[2 * i] * volume) / 255;
      channel1[i] = (inputBuffer[2 * i + 1] * volume) / 255;
    }
    const bufferSource = this.audioCtx.createBufferSource();
    bufferSource.buffer = buffer;
    bufferSource.connect(this.audioCtx.destination);
    bufferSource.start(this.audioTime);
    this.audioTime += this.audioBufferSize / this.audioCtx.sampleRate;
  }
}

// ---------------------------------------------------------------------------
// Backward compatibility: Module-level exports (proxying to default singleton)
// ---------------------------------------------------------------------------

const defaultInstance = new Emulator();
let _defaultInstance = null;

function _inst() { return _defaultInstance || defaultInstance; }

export function setDefaultInstance(inst) { _defaultInstance = inst; }

export const init               = (c, r) => _inst().init(c, r);
export const destroy            = ()     => _inst().destroy();
export const isAvailable        = ()     => _inst().isAvailable();
export const step               = (t)    => _inst().step(t);
export const renderScreen       = ()     => _inst().renderScreen();
export const renderVRam         = (c)    => _inst().renderVRam(c);
export const renderBackground   = (c, t) => _inst().renderBackground(c, t);
export const getWRam            = ()     => _inst().getWRam();
export const getHRam            = ()     => _inst().getHRam();
export const getPC              = ()     => _inst().getPC();
export const setPC              = (v)    => _inst().setPC(v);
export const getSP              = ()     => _inst().getSP();
export const getA               = ()     => _inst().getA();
export const getBC              = ()     => _inst().getBC();
export const getDE              = ()     => _inst().getDE();
export const getHL              = ()     => _inst().getHL();
export const getFlags           = ()     => _inst().getFlags();
export const readMem            = (a)    => _inst().readMem(a);
export const writeMem           = (a, d) => _inst().writeMem(a, d);
export const setBreakpoint      = (p)    => _inst().setBreakpoint(p);
export const clearBreakpoints   = ()     => _inst().clearBreakpoints();
export const setKeyPad          = (k, d) => _inst().setKeyPad(k, d);
export const setSerialCallback  = (cb)   => _inst().setSerialCallback(cb);
export const getInstance        = ()     => _inst();
