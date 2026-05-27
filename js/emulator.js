import Binjgb from '../binjgb/out/binjgb.js';

const Module = await Binjgb();

// Module-level shared resources (audio context shared across instances)
var audio_ctx;
var audio_time;

export class Emulator {
  constructor() {
    this.e = undefined;
    this.rom_size = 0;
    this.canvas_ctx = undefined;
    this.canvas_image_data = undefined;
    this.serial_callback = null;
    this.audio_buffer_size = 2048;
  }

  init(canvas, rom_data) {
    if (this.isAvailable()) this.destroy();

    if (typeof audio_ctx == 'undefined') audio_ctx = new AudioContext();

    var required_size = ((rom_data.length - 1) | 0x3fff) + 1;
    if (required_size < 0x8000) required_size = 0x8000;
    var rom_ptr = Module._malloc(required_size);
    this.rom_size = required_size;

    const romView = Module.HEAP8.subarray(rom_ptr, rom_ptr + this.rom_size);
    romView.fill(0);
    romView.set(rom_data);

    this.e = Module._emulator_new_simple(rom_ptr, this.rom_size, audio_ctx.sampleRate, this.audio_buffer_size);
    Module._emulator_set_bw_palette_simple(this.e, 0, 0xffc2f0c4, 0xffa8b95a, 0xff6e601e, 0xff001b2d);
    Module._emulator_set_bw_palette_simple(this.e, 1, 0xffc2f0c4, 0xffa8b95a, 0xff6e601e, 0xff001b2d);
    Module._emulator_set_bw_palette_simple(this.e, 2, 0xffc2f0c4, 0xffa8b95a, 0xff6e601e, 0xff001b2d);
    Module._emulator_set_default_joypad_callback(this.e, 0);

    if (canvas) {
      this.canvas_ctx = canvas.getContext('2d');
      this.canvas_image_data = this.canvas_ctx.createImageData(canvas.width, canvas.height);
    }

    audio_ctx.resume();
    audio_time = audio_ctx.currentTime;
  }

  destroy() {
    if (!this.isAvailable()) return;
    Module._emulator_delete(this.e);
    this.e = undefined;
  }

  isAvailable() {
    return typeof this.e != 'undefined';
  }

  step(step_type) {
    if (!this.isAvailable()) return false;
    var ticks = Module._emulator_get_ticks_f64(this.e);
    if (step_type == 'single') ticks += 1;
    else if (step_type == 'frame') ticks += 70224;
    while (true) {
      var result = Module._emulator_run_until_f64(this.e, ticks);
      if (result & 2) this._processAudioBuffer();
      if (result & 8)
        // Breakpoint hit
        return true;
      if (result & 16)
        // Illegal instruction
        return true;
      if (result != 2 && step_type != 'run') return false;
      if (step_type == 'run') {
        if (result & 4) {
          // Sync to the audio buffer, make sure we have 100ms of audio data buffered.
          if (audio_time < audio_ctx.currentTime + 0.1) ticks += 70224;
          else return false;
        }
      }
    }
  }

  renderScreen() {
    if (!this.isAvailable()) return;
    var buffer = new Uint8Array(Module.HEAP8.buffer, Module._get_frame_buffer_ptr(this.e), Module._get_frame_buffer_size(this.e));
    this.canvas_image_data.data.set(buffer);
    this.canvas_ctx.putImageData(this.canvas_image_data, 0, 0);
  }

  renderVRam(canvas) {
    if (!this.isAvailable()) return;
    var ctx = canvas.getContext('2d');
    var image_data = ctx.createImageData(256, 256);
    var ptr = Module._malloc(4 * 256 * 256);
    Module._emulator_render_vram(this.e, ptr);
    var buffer = new Uint8Array(Module.HEAP8.buffer, ptr, 4 * 256 * 256);
    image_data.data.set(buffer);
    ctx.putImageData(image_data, 0, 0);
    Module._free(ptr);
  }

  renderBackground(canvas, type) {
    if (!this.isAvailable()) return;
    var ctx = canvas.getContext('2d');
    var image_data = ctx.createImageData(256, 256);
    var ptr = Module._malloc(4 * 256 * 256);
    Module._emulator_render_background(this.e, ptr, type);
    var buffer = new Uint8Array(Module.HEAP8.buffer, ptr, 4 * 256 * 256);
    image_data.data.set(buffer);
    ctx.putImageData(image_data, 0, 0);
    Module._free(ptr);
  }

  getWRam() {
    if (!this.isAvailable()) return;
    var ptr = Module._emulator_get_wram_ptr(this.e);
    return new Uint8Array(Module.HEAP8.buffer, ptr, 0x8000);
  }

  getHRam() {
    if (!this.isAvailable()) return;
    var ptr = Module._emulator_get_hram_ptr(this.e);
    return new Uint8Array(Module.HEAP8.buffer, ptr, 0x7f);
  }

  getPC() {
    return Module._emulator_get_PC(this.e);
  }
  setPC(pc) {
    Module._emulator_set_PC(this.e, pc);
  }
  getSP() {
    return Module._emulator_get_SP(this.e);
  }
  getA() {
    return Module._emulator_get_A(this.e);
  }
  getBC() {
    return Module._emulator_get_BC(this.e);
  }
  getDE() {
    return Module._emulator_get_DE(this.e);
  }
  getHL() {
    return Module._emulator_get_HL(this.e);
  }
  getFlags() {
    var flags = Module._emulator_get_F(this.e);
    var result = '';
    if (flags & 0x80) result += 'Z ';
    if (flags & 0x10) result += 'C ';
    if (flags & 0x20) result += 'H ';
    if (flags & 0x40) result += 'N ';
    return result;
  }
  readMem(addr) {
    if (!this.isAvailable()) return 0xff;
    return Module._emulator_read_mem(this.e, addr);
  }
  writeMem(addr, data) {
    if (!this.isAvailable()) return;
    return Module._emulator_write_mem(this.e, addr, data);
  }

  setBreakpoint(pc) {
    if (!this.isAvailable()) return;
    Module._emulator_set_breakpoint(this.e, pc);
  }
  clearBreakpoints() {
    if (!this.isAvailable()) return;
    Module._emulator_clear_breakpoints(this.e);
  }

  setKeyPad(key, down) {
    if (!this.isAvailable()) return;
    if (key == 'right') Module._set_joyp_right(this.e, down);
    if (key == 'left') Module._set_joyp_left(this.e, down);
    if (key == 'up') Module._set_joyp_up(this.e, down);
    if (key == 'down') Module._set_joyp_down(this.e, down);
    if (key == 'a') Module._set_joyp_A(this.e, down);
    if (key == 'b') Module._set_joyp_B(this.e, down);
    if (key == 'select') Module._set_joyp_select(this.e, down);
    if (key == 'start') Module._set_joyp_start(this.e, down);
  }

  setSerialCallback(callback) {
    this.serial_callback = callback;
  }

  serialCallback(value) {
    if (this.serial_callback) this.serial_callback(value);
  }

  _processAudioBuffer() {
    if (audio_time < audio_ctx.currentTime) audio_time = audio_ctx.currentTime;

    var input_buffer = new Uint8Array(
      Module.HEAP8.buffer,
      Module._get_audio_buffer_ptr(this.e),
      Module._get_audio_buffer_capacity(this.e),
    );
    const volume = 0.5;
    const buffer = audio_ctx.createBuffer(2, this.audio_buffer_size, audio_ctx.sampleRate);
    const channel0 = buffer.getChannelData(0);
    const channel1 = buffer.getChannelData(1);

    for (let i = 0; i < this.audio_buffer_size; i++) {
      channel0[i] = (input_buffer[2 * i] * volume) / 255;
      channel1[i] = (input_buffer[2 * i + 1] * volume) / 255;
    }
    const bufferSource = audio_ctx.createBufferSource();
    bufferSource.buffer = buffer;
    bufferSource.connect(audio_ctx.destination);
    bufferSource.start(audio_time);
    const buffer_sec = this.audio_buffer_size / audio_ctx.sampleRate;
    audio_time += buffer_sec;
  }
}

// ====================================================================
// Backwards-compatible exports for existing code that uses the old API
// ====================================================================
var _defaultEmulator = null;

function _getDefault() {
  if (!_defaultEmulator) _defaultEmulator = new Emulator();
  return _defaultEmulator;
}

export function init(canvas, rom_data) {
  _getDefault().init(canvas, rom_data);
}
export function destroy() {
  if (_defaultEmulator) _defaultEmulator.destroy();
}
export function isAvailable() {
  return _defaultEmulator ? _defaultEmulator.isAvailable() : false;
}
export function step(step_type) {
  return _getDefault().step(step_type);
}
export function renderScreen() {
  _getDefault().renderScreen();
}
export function renderVRam(canvas) {
  _getDefault().renderVRam(canvas);
}
export function renderBackground(canvas, type) {
  _getDefault().renderBackground(canvas, type);
}
export function getWRam() {
  return _getDefault().getWRam();
}
export function getHRam() {
  return _getDefault().getHRam();
}
export function getPC() {
  return _getDefault().getPC();
}
export function setPC(pc) {
  _getDefault().setPC(pc);
}
export function getSP() {
  return _getDefault().getSP();
}
export function getA() {
  return _getDefault().getA();
}
export function getBC() {
  return _getDefault().getBC();
}
export function getDE() {
  return _getDefault().getDE();
}
export function getHL() {
  return _getDefault().getHL();
}
export function getFlags() {
  return _getDefault().getFlags();
}
export function readMem(addr) {
  return _getDefault().readMem(addr);
}
export function writeMem(addr, data) {
  _getDefault().writeMem(addr, data);
}
export function setBreakpoint(pc) {
  _getDefault().setBreakpoint(pc);
}
export function clearBreakpoints() {
  _getDefault().clearBreakpoints();
}
export function setKeyPad(key, down) {
  _getDefault().setKeyPad(key, down);
}
export function setSerialCallback(callback) {
  _getDefault().setSerialCallback(callback);
}
export function serialCallback(value) {
  _getDefault().serialCallback(value);
}