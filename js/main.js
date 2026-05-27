import * as compiler from './compiler.js';
import { Emulator } from './emulator.js';
import * as storage from './storage.js';
import * as editors from './editors.js';
import * as textEditor from './text-editor.js';
import * as gfxEditor from './gfx-editor.js';

if (import.meta.env.DEV) {
  globalThis._rgbdsDebug = {
    compiler,
    emulator: Emulator,
    storage,
    editors,
    textEditor,
    gfxEditor,
  };
}

const hexTable = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
const toHex2 = (num) => hexTable[num & 0xff];
const toHex4 = (num) => hexTable[(num >> 8) & 0xff] + hexTable[num & 0xff];

function toHex(num, digits) {
  if (digits === 2) return '$' + toHex2(num);
  return '$' + toHex4(num);
}

export function isDarkMode() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function escapeHTML(str) {
  var escapedHTML = document.createElement('div');
  escapedHTML.innerText = str;
  return escapedHTML.innerHTML;
}

// ============================================================
// Shared ROM data (compiled from all .asm files via "Compile All")
// ============================================================
var rom = undefined;
var shared_addr_to_line = {};
var shared_start_address = 0x100;

// ============================================================
// Per-emulator context
// ============================================================
function createEmuContext(idx) {
  return {
    idx: idx,
    emu: null,
    rom: undefined,
    start_address: 0x100,
    addr_to_line: {},
    line_to_addr: {},
    emu_view: 'display',
    selectedFile: '',
    serial_log_buffer: [],
    cpu_line_marker: undefined,
    cpu_step_interval_id: undefined,
  };
}

var emuCtxs = [createEmuContext(0), createEmuContext(1)];
var activeEmuIdx = 0;
const serial_log_buffer_size = 256;

// ============================================================
// DOM cache per emulator
// ============================================================
function emuEl(idx, suffix) {
  return document.getElementById(suffix + '_' + idx);
}

function eachEmu(fn) {
  for (var i = 0; i < 2; i++) fn(emuCtxs[i], i);
}

// ============================================================
// Compiler log callback
// ============================================================
compiler.setLogCallback(function (str, kind) {
  var output = document.getElementById('output');
  if (str == null && kind == null) {
    output.innerHTML = '';
    return;
  }
  output.innerHTML += '<span class="' + kind + '">' + escapeHTML(str) + '</span>\n';
  output.scrollTop = output.scrollHeight;
});

// ============================================================
// Compile & run (global: all .asm files, or per-emulator: single file)
// ============================================================
export function compileCode() {
  compiler.compile(function (_rom_file, _start_address, _addr_to_line) {
    textEditor.updateErrors();
    updateFileList();

    if (typeof _rom_file == 'undefined') {
      destroyAllEmulators();
      return;
    }

    rom = _rom_file;
    shared_start_address = _start_address;
    shared_addr_to_line = _addr_to_line;

    eachEmu(function (ctx) {
      populateAddrMapping(ctx, shared_addr_to_line, shared_start_address);
      ctx.rom = rom;
      destroyEmulator(ctx);
      initEmulator(ctx);
    });
  });
}

export function compileCodeForEmu(ctx) {
  if (!ctx.selectedFile) return;
  compiler.compileSingleFile(ctx.selectedFile, function (_rom_file, _start_address, _addr_to_line) {
    textEditor.updateErrors();
    updateFileList();

    if (typeof _rom_file == 'undefined') {
      destroyEmulator(ctx);
      return;
    }

    ctx.rom = _rom_file;
    populateAddrMapping(ctx, _addr_to_line, _start_address);
    destroyEmulator(ctx);
    initEmulator(ctx);
  });
}

function populateAddrMapping(ctx, _addr_to_line, _start_address) {
  ctx.addr_to_line = {};
  ctx.line_to_addr = {};
  for (var addr in _addr_to_line) {
    var entry = _addr_to_line[addr];
    var filename = entry[0];
    var line = entry[1];
    if (typeof ctx.line_to_addr[filename] == 'undefined') ctx.line_to_addr[filename] = {};
    if (typeof ctx.line_to_addr[filename][line] == 'undefined') ctx.line_to_addr[filename][line] = [];
    ctx.line_to_addr[filename][line].push(addr);
  }

  ctx.start_address = _start_address;
  if (ctx.selectedFile && ctx.line_to_addr[ctx.selectedFile]) {
    var lines = Object.keys(ctx.line_to_addr[ctx.selectedFile]).sort(function (a, b) { return parseInt(a) - parseInt(b); });
    if (lines.length > 0) {
      var addrs = ctx.line_to_addr[ctx.selectedFile][lines[0]];
      if (addrs.length > 0) ctx.start_address = parseInt(addrs[0]);
    }
  }
}

// ============================================================
// Emulator lifecycle per instance
// ============================================================
function destroyEmulator(ctx) {
  if (ctx.emu) ctx.emu.destroy();
  ctx.emu = null;
  ctx.addr_to_line = {};
  ctx.line_to_addr = {};
  ctx.cpu_line_marker = undefined;
  if (ctx.cpu_step_interval_id) {
    cancelAnimationFrame(ctx.cpu_step_interval_id);
    ctx.cpu_step_interval_id = undefined;
  }
}

function destroyAllEmulators() {
  eachEmu(function (ctx) { destroyEmulator(ctx); });
  rom = undefined;
  shared_addr_to_line = {};
  textEditor.setCpuLine(null, null);
}

function initEmulator(ctx, jump_to_pc) {
  if (typeof ctx.rom == 'undefined') return;
  if (!ctx.selectedFile) return;

  var canvas = emuEl(ctx.idx, 'emulator_screen_canvas');
  ctx.emu = new Emulator();
  ctx.emu.init(canvas, ctx.rom);
  ctx.emu.setPC(ctx.start_address);
  ctx.serial_log_buffer = [];
  ctx.emu.setSerialCallback(function (value) {
    var formatted_value = toHex2(value);
    var el = emuEl(ctx.idx, 'serial_log');
    if (el) el.innerText = '$' + formatted_value;
    ctx.serial_log_buffer.unshift(formatted_value);
    if (ctx.serial_log_buffer.length > serial_log_buffer_size) {
      ctx.serial_log_buffer.length = serial_log_buffer_size;
    }
  });
  updateCpuState(ctx, jump_to_pc);
  updateBreakpoints(ctx);
}

function stepEmulator(ctx, step_type) {
  if (!ctx.emu || !ctx.emu.isAvailable()) {
    initEmulator(ctx, step_type == 'single' || step_type == 'frame');
    return false;
  }
  var result = ctx.emu.step(step_type);
  updateCpuState(ctx, step_type == 'single' || step_type == 'frame');
  return result;
}

export function updateBreakpoints(ctx) {
  if (!ctx || !ctx.emu) return;
  if (typeof ctx === 'number') ctx = emuCtxs[ctx];
  if (!ctx.emu || !ctx.emu.isAvailable()) return;

  ctx.emu.clearBreakpoints();
  var breakpoints = textEditor.getBreakpoints();
  for (var data of breakpoints) {
    var filename = data[0], line_nr = data[1];
    data[2] = false;
    if (typeof ctx.line_to_addr[filename] == 'undefined' || typeof ctx.line_to_addr[filename][line_nr] == 'undefined') continue;
    data[2] = true;
    for (var addr of ctx.line_to_addr[filename][line_nr]) ctx.emu.setBreakpoint(addr);
  }
}

// ============================================================
// Keyboard input
// ============================================================
function handleGBKey(code, down) {
  var ctx = emuCtxs[activeEmuIdx];
  if (!ctx.emu || !ctx.emu.isAvailable()) {
    if (code == 'Escape') {
      var check = emuEl(activeEmuIdx, 'cpu_run_check');
      if (check) { check.checked = false; check.onclick(); }
    }
    return;
  }
  if (code == 'ArrowRight') ctx.emu.setKeyPad('right', down);
  if (code == 'ArrowLeft') ctx.emu.setKeyPad('left', down);
  if (code == 'ArrowUp') ctx.emu.setKeyPad('up', down);
  if (code == 'ArrowDown') ctx.emu.setKeyPad('down', down);
  if (code == 'KeyS') ctx.emu.setKeyPad('a', down);
  if (code == 'KeyA') ctx.emu.setKeyPad('b', down);
  if (code == 'ShiftRight') ctx.emu.setKeyPad('select', down);
  if (code == 'Enter') ctx.emu.setKeyPad('start', down);
  if (code == 'Escape') {
    var check = emuEl(activeEmuIdx, 'cpu_run_check');
    if (check) { check.checked = false; check.onclick(); }
  }
}

// ============================================================
// CPU state update per emulator
// ============================================================
function updateCpuState(ctx, afterSingleStep) {
  if (!ctx.emu || !ctx.emu.isAvailable()) return;
  ctx.emu.renderScreen();

  var pc = ctx.emu.getPC();
  var pcEl = emuEl(ctx.idx, 'cpu_pc');
  var spEl = emuEl(ctx.idx, 'cpu_sp');
  var aEl = emuEl(ctx.idx, 'cpu_a');
  var bcEl = emuEl(ctx.idx, 'cpu_bc');
  var deEl = emuEl(ctx.idx, 'cpu_de');
  var hlEl = emuEl(ctx.idx, 'cpu_hl');
  var flagsEl = emuEl(ctx.idx, 'cpu_flags');

  if (pcEl) pcEl.innerText = toHex(pc, 4);
  if (spEl) spEl.innerText = toHex(ctx.emu.getSP(), 4);
  if (aEl) aEl.innerText = toHex(ctx.emu.getA(), 2);
  if (bcEl) bcEl.innerText = toHex(ctx.emu.getBC(), 4);
  if (deEl) deEl.innerText = toHex(ctx.emu.getDE(), 4);
  if (hlEl) hlEl.innerText = toHex(ctx.emu.getHL(), 4);
  if (flagsEl) flagsEl.innerText = ctx.emu.getFlags();

  // Update line marker in shared editor (only for active emulator)
  if (ctx.idx === activeEmuIdx) {
    var file_line_nr = ctx.addr_to_line[pc];
    if (typeof file_line_nr == 'undefined') file_line_nr = ctx.addr_to_line[pc - 1];
    if (typeof file_line_nr != 'undefined') {
      textEditor.setCpuLine(file_line_nr[0], file_line_nr[1], afterSingleStep);
    } else {
      textEditor.setCpuLine(null, null);
    }
  }

  updateVRamCanvas(ctx);
  updateTextView(ctx);
}

function updateVRamCanvas(ctx) {
  if (!ctx.emu || !ctx.emu.isAvailable()) return;
  var canvas = emuEl(ctx.idx, 'emulator_vram_canvas');
  if (!canvas || canvas.style.display != '') return;

  if (ctx.emu_view == 'vram') ctx.emu.renderVRam(canvas);
  if (ctx.emu_view == 'bg0') ctx.emu.renderBackground(canvas, 0);
  if (ctx.emu_view == 'bg1') ctx.emu.renderBackground(canvas, 1);
}

function updateTextView(ctx) {
  if (!ctx.emu || !ctx.emu.isAvailable()) return;
  var display_text = emuEl(ctx.idx, 'emulator_display_text');
  if (!display_text || display_text.style.display != '') return;

  var data = ctx.rom;
  var bank_size = 0x4000;
  var offset = 0x0000;
  var symbols = compiler.getRomSymbols();
  if (ctx.emu_view == 'wram') {
    data = ctx.emu.getWRam();
    bank_size = 0x1000;
    offset = 0xc000;
    symbols = compiler.getRamSymbols();
  }
  if (ctx.emu_view == 'hram') {
    data = ctx.emu.getHRam();
    bank_size = 0x1000;
    offset = 0xff80;
    symbols = compiler.getRamSymbols();
  }
  if (ctx.emu_view == 'io') {
    var text = '';
    var registers = [
      { name: 'P1', value: 0xff00 }, { name: 'SB', value: 0xff01 }, { name: 'SC', value: 0xff02 },
      { name: 'DIV', value: 0xff04 }, { name: 'TIMA', value: 0xff05 }, { name: 'TMA', value: 0xff06 },
      { name: 'TAC', value: 0xff07 }, { name: 'IF', value: 0xff0f }, { name: 'LCDC', value: 0xff40 },
      { name: 'STAT', value: 0xff41 }, { name: 'SCY', value: 0xff42 }, { name: 'SCX', value: 0xff43 },
      { name: 'LY', value: 0xff44 }, { name: 'LYC', value: 0xff45 }, { name: 'DMA', value: 0xff46 },
      { name: 'BGP', value: 0xff47 }, { name: 'OBP0', value: 0xff48 }, { name: 'OBP1', value: 0xff49 },
      { name: 'WY', value: 0xff4a }, { name: 'WX', value: 0xff4b }, { name: 'KEY1', value: 0xff4d },
      { name: 'VBK', value: 0xff4f }, { name: 'RP', value: 0xff56 }, { name: 'BCPS', value: 0xff68 },
      { name: 'BCPD', value: 0xff69 }, { name: 'OCPS', value: 0xff6a }, { name: 'OCPD', value: 0xff6b },
      { name: 'SVBK', value: 0xff70 }, { name: 'IE', value: 0xffff },
    ];
    for (var ri = 0; ri < registers.length; ri++) {
      var reg_info = registers[ri];
      text += "<span style='float: left; width: 50px'>" + reg_info.name + ':</span>' + toHex2(ctx.emu.readMem(reg_info.value)) + '<br/>';
    }
    display_text.innerHTML = text;
    return;
  }
  if (ctx.emu_view == 'serial') {
    var text = '';
    for (var n = 0; n < ctx.serial_log_buffer.length; n += 16) {
      text += ctx.serial_log_buffer.slice(n, n + 16).join(' ') + '\n';
    }
    display_text.textContent = text;
    return;
  }
  if (typeof data == 'undefined') return;

  var text = "<div class='emulator_display_header'>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; 0&nbsp; 1&nbsp; 2&nbsp; 3&nbsp; 4&nbsp; 5&nbsp; 6&nbsp; 7&nbsp; 8&nbsp; 9&nbsp; a&nbsp; b&nbsp; c&nbsp; d&nbsp; e&nbsp; f</div>";
  var symbol = null;
  var span = false;
  var span_color = 0;
  for (var n = 0; n < data.length; n += 16) {
    var hex = Array.prototype.map.call(data.slice(n, n + 16), function (x) { return toHex2(x); });
    var bank = ~~(n / bank_size);
    var addr = n & (bank_size - 1);
    if (bank > 0) addr += bank_size;
    text += toHex2(bank) + ':' + toHex4(addr + offset);
    for (var idx = 0; idx < hex.length; idx++) {
      text += ' ';
      var new_symbol = symbols[n + idx + offset];
      if (new_symbol) {
        symbol = new_symbol;
        if (span) text += '</span>';
        span = false;
        span_color = (span_color + 71) % 360;
      } else if (new_symbol === null) {
        symbol = null;
        if (span) text += '</span>';
        span = false;
      }
      if (symbol && !span) {
        text += "<span title='" + symbol + "' style='background-color: hsl(" + span_color + (isDarkMode() ? ", 30%, 30%)'>" : ", 50%, 50%)'>");
        span = true;
      }
      text += hex[idx];
    }
    if (span) text += '</span>';
    span = false;
    text += '<br/>';
  }
  display_text.innerHTML = text;
}

// ============================================================
// Tab switching per emulator
// ============================================================
function showTabType(ctx, type) {
  var screenCanvas = emuEl(ctx.idx, 'emulator_screen_canvas');
  var vramCanvas = emuEl(ctx.idx, 'emulator_vram_canvas');
  var displayText = emuEl(ctx.idx, 'emulator_display_text');

  var tabTypes = {
    'emulator_screen_canvas': screenCanvas,
    'emulator_vram_canvas': vramCanvas,
    'emulator_display_text': displayText,
  };

  for (var key in tabTypes) {
    if (tabTypes[key]) tabTypes[key].style.display = (key == type) ? '' : 'none';
  }
}

// ============================================================
// File list
// ============================================================
export function updateFileList() {
  var filelist = document.getElementById('filelist');
  filelist.textContent = '';

  var files = Object.keys(storage.getFiles()).sort();
  for (var f = 0; f < files.length; f++) {
    var name = files[f];
    var entry = document.createElement('li');
    entry.textContent = name;
    filelist.appendChild(entry);

    if (name == editors.getCurrentFilename()) entry.classList.add('active');
    var errors = compiler.getErrors();
    for (var e = 0; e < errors.length; e++) {
      var err = errors[e];
      if (err[1] != name) continue;
      entry.classList.add(err[0]);
      if (err[0] == 'error') {
        entry.classList.remove('warning');
        break;
      }
    }
  }

  // Update file selectors for each emulator
  updateEmuFileSelectors();
}

function updateEmuFileSelectors() {
  var asmFiles = Object.keys(storage.getFiles()).filter(function (n) { return n.endsWith('.asm'); }).sort();

  eachEmu(function (ctx, idx) {
    var select = emuEl(idx, 'emu-file-select');
    if (!select) return;
    var currentVal = select.value;

    // Preserve selected option
    select.innerHTML = '<option value="">-- Choose a file --</option>';
    for (var i = 0; i < asmFiles.length; i++) {
      var opt = document.createElement('option');
      opt.value = asmFiles[i];
      opt.textContent = asmFiles[i];
      if (asmFiles[i] === currentVal) opt.selected = true;
      if (asmFiles[i] === ctx.selectedFile) opt.selected = true;
      select.appendChild(opt);
    }
  });
}

function deleteFile(name) {
  if (Object.keys(storage.getFiles()).length < 2) return;
  storage.update(name, null);
  if (editors.getCurrentFilename() == name) editors.setCurrentFile(Object.keys(storage.getFiles()).sort()[0]);
  updateFileList();
}

// ============================================================
// Init
// ============================================================
export function init(event) {
  textEditor.register('textEditorDiv', compileCode);
  gfxEditor.register('gfxEditorDiv');

  var urlParams = new URLSearchParams(window.location.search);
  const asmOptions = (urlParams.get('asm') ?? '').trim();
  if (asmOptions != '') {
    document.getElementById('compiler_settings_asm').value = asmOptions;
    compiler.setAsmOptions(asmOptions.split(' '));
  }
  const linkOptions = (urlParams.get('link') ?? '').trim();
  if (linkOptions != '') {
    document.getElementById('compiler_settings_link').value = linkOptions;
    compiler.setLinkOptions(linkOptions.split(' '));
  }
  const fixOptions = (urlParams.get('fix') ?? '').trim();
  if (fixOptions != '') {
    document.getElementById('compiler_settings_fix').value = fixOptions;
    compiler.setFixOptions(fixOptions.split(' '));
  }

  storage.autoLoad();
  editors.setCurrentFile(Object.keys(storage.getFiles()).pop());
  updateFileList();

  // File list click
  document.getElementById('filelist').onclick = function (e) {
    if (!e.target.childNodes[0].wholeText) return;
    editors.setCurrentFile(e.target.childNodes[0].wholeText);
    updateFileList();
    if (emuCtxs[activeEmuIdx].emu && emuCtxs[activeEmuIdx].emu.isAvailable()) {
      updateCpuState(emuCtxs[activeEmuIdx]);
    }
  };

  // Hamburger toggle
  document.getElementById('hamburger-container').onclick = function () {
    document.querySelector('body .container:first-child').classList.toggle('filelist-open');
  };

  // New file dialog
  document.getElementById('newfile').onclick = function () {
    document.getElementById('newfiledialog').style.display = 'block';
  };
  document.getElementById('newfiledialog').onclick = function (e) {
    if (e.target == document.getElementById('newfiledialog'))
      document.getElementById('newfiledialog').style.display = 'none';
  };
  document.getElementById('newfiledialogclose').onclick = function () {
    document.getElementById('newfiledialog').style.display = 'none';
  };
  document.getElementById('newfile_empty_create').onclick = function () {
    var result = document.getElementById('newfile_name').value;
    if (!result) return;
    if (result.indexOf('.') < 0) result += '.asm';
    if (result in storage.getFiles()) return;
    if (editors.getFileType(result) === 'text') storage.update(result, '');
    else storage.update(result, new Uint8Array(16));
    editors.setCurrentFile(result);
    updateFileList();
    document.getElementById('newfiledialog').style.display = 'none';
  };
  document.getElementById('newfile_upload').onchange = function (e) {
    var files = e.target.files;
    if (files.length === 0) return;
    var loadPromises = [];
    for (var i = 0; i < files.length; i++) {
      (function (file) {
        var p = editors.getFileType(file.name) == 'text' ? file.text() : file.arrayBuffer();
        loadPromises.push(p.then(function (data) {
          storage.update(file.name, data);
        }));
      })(files[i]);
    }
    Promise.all(loadPromises).then(function () {
      editors.setCurrentFile(files[files.length - 1].name);
      updateFileList();
    });
    e.target.value = '';
    document.getElementById('newfiledialog').style.display = 'none';
  };

  // Delete file
  document.getElementById('delfile').onclick = function () {
    if (confirm('Are you sure you want to delete: ' + editors.getCurrentFilename() + '?'))
      deleteFile(editors.getCurrentFilename());
  };

  // New project
  document.getElementById('newproject').onclick = function () {
    if (!confirm('Are you sure to clear the current project?')) return;
    storage.reset();
    editors.setCurrentFile('main.asm');
    updateFileList();
  };

  // ============================================================
  // Setup each emulator panel
  // ============================================================
  eachEmu(function (ctx, idx) {
    // Compile & Run button
    var compileBtn = emuEl(idx, 'emu-compile');
    if (compileBtn) compileBtn.onclick = function () {
      var select = emuEl(idx, 'emu-file-select');
      ctx.selectedFile = select ? select.value : '';
      if (!ctx.selectedFile) {
        alert('Please select a .asm file for Emulator ' + (idx + 1));
        return;
      }
      compileCodeForEmu(ctx);
    };

    // Download button
    var dlBtn = emuEl(idx, 'download_rom');
    if (dlBtn) dlBtn.onclick = function () {
      if (typeof ctx.rom == 'undefined') return;
      var element = document.createElement('a');
      var url = window.URL.createObjectURL(new Blob([ctx.rom.buffer], { type: 'application/octet-stream' }));
      element.setAttribute('href', url);
      element.setAttribute('download', 'rom_emu' + (idx + 1) + '.gb');
      element.style.display = 'none';
      document.body.appendChild(element);
      element.click();
      document.body.removeChild(element);
      window.URL.revokeObjectURL(url);
    };

    // Step button
    var stepBtn = emuEl(idx, 'cpu_single_step');
    if (stepBtn) stepBtn.onclick = function () {
      stepEmulator(ctx, 'single');
    };

    // Frame button
    var frameBtn = emuEl(idx, 'cpu_frame_step');
    if (frameBtn) frameBtn.onclick = function () {
      stepEmulator(ctx, 'frame');
    };

    // Reset button
    var resetBtn = emuEl(idx, 'cpu_reset');
    if (resetBtn) resetBtn.onclick = function () {
      initEmulator(ctx, true);
    };

    // Run checkbox
    var runCheck = emuEl(idx, 'cpu_run_check');
    if (runCheck) runCheck.onclick = function () {
      if (runCheck.checked) {
        function runFunction() {
          if (!document.hidden) {
            if (stepEmulator(ctx, 'run')) runCheck.checked = false;
          }
          if (runCheck.checked) ctx.cpu_step_interval_id = requestAnimationFrame(runFunction);
        }
        ctx.cpu_step_interval_id = requestAnimationFrame(runFunction);
      }
    };

    // Display mode tabs
    var displayModes = ['screen', 'vram', 'bg0', 'bg1', 'rom', 'wram', 'hram', 'io', 'serial'];
    for (var d = 0; d < displayModes.length; d++) {
      (function (mode) {
        var radio = emuEl(idx, 'emulator_display_' + mode);
        if (!radio) return;
        radio.onclick = function () {
          var canvasType = (mode == 'screen') ? 'emulator_screen_canvas' :
                           (mode == 'vram' || mode == 'bg0' || mode == 'bg1') ? 'emulator_vram_canvas' :
                           'emulator_display_text';
          showTabType(ctx, canvasType);
          ctx.emu_view = (mode == 'screen') ? 'display' : mode;
          if (mode == 'vram' || mode == 'bg0' || mode == 'bg1') updateVRamCanvas(ctx);
          if (mode == 'rom' || mode == 'wram' || mode == 'hram' || mode == 'io' || mode == 'serial') updateTextView(ctx);
        };
      })(displayModes[d]);
    }

    // Click on emulator panel to switch active focus
    var panel = document.getElementById('emu-panel-' + idx);
    if (panel) panel.onmousedown = function () {
      activeEmuIdx = idx;
      // Update breakpoints for the newly active emulator
      updateBreakpoints(ctx);
    };

    // File selector change
    var fileSelect = emuEl(idx, 'emu-file-select');
    if (fileSelect) fileSelect.onchange = function () {
      ctx.selectedFile = fileSelect.value;
    };

    // Keyboard input on screen containers
    var screenContainer = emuEl(idx, 'emulator_screen_container');
    if (screenContainer) {
      screenContainer.tabIndex = -1;
      screenContainer.onmousedown = function () {
        activeEmuIdx = idx;
        updateBreakpoints(ctx);
        screenContainer.focus();
      };
    }
  });

  // Global keyboard handler
  document.onkeydown = function (e) {
    if (e.code == 'F8') {
      stepEmulator(emuCtxs[activeEmuIdx], 'single');
      e.preventDefault();
    }
    if (e.code == 'F9') {
      stepEmulator(emuCtxs[activeEmuIdx], 'frame');
      e.preventDefault();
    }
  };

  // Per-emulator keyboard inputs
  eachEmu(function (ctx, idx) {
    var container = emuEl(idx, 'emulator_screen_container');
    if (!container) return;
    container.onkeydown = function (e) {
      activeEmuIdx = idx;
      handleGBKey(e.code, true);
      e.preventDefault();
    };
    container.onkeyup = function (e) {
      handleGBKey(e.code, false);
      e.preventDefault();
    };
  });

  // Import dialog
  document.getElementById('importmenu').onclick = function () {
    document.getElementById('importdialog').style.display = 'block';
  };
  document.getElementById('importdialog').onclick = function (e) {
    if (e.target == document.getElementById('importdialog'))
      document.getElementById('importdialog').style.display = 'none';
  };
  document.getElementById('importdialogclose').onclick = function () {
    document.getElementById('importdialog').style.display = 'none';
  };
  document.getElementById('import_gist').onclick = function () {
    storage.loadGithubGist(document.getElementById('import_gist_url').value);
    document.getElementById('importdialog').style.display = 'none';
  };
  document.getElementById('import_zipfile').onchange = function (e) {
    if (e.target.files.length > 0) {
      storage.loadZip(e.target.files[0]);
      e.target.value = '';
      document.getElementById('importdialog').style.display = 'none';
    }
  };

  // Export dialog
  document.getElementById('exportmenu').onclick = function () {
    document.getElementById('exportdialog').style.display = 'block';
    document.getElementById('export_hash_url').value = storage.getHashUrl();
  };
  document.getElementById('exportdialog').onclick = function (e) {
    if (e.target == document.getElementById('exportdialog'))
      document.getElementById('exportdialog').style.display = 'none';
  };
  document.getElementById('exportdialogclose').onclick = function () {
    document.getElementById('exportdialog').style.display = 'none';
  };
  document.getElementById('export_gist').onclick = function () {
    var url = document.getElementById('export_gist_url').value;
    var username = document.getElementById('export_gist_username').value;
    var token = document.getElementById('export_gist_token').value;
    url = storage.saveGithubGist(username, token, url);
    if (url == null) {
      document.getElementById('export_gist_import_url').value = 'Gist create/update failed. Incorrect token?';
    } else {
      document.getElementById('export_gist_url').value = url;
      var auto_import_url = new URL(document.location);
      auto_import_url.hash = url;
      document.getElementById('export_gist_import_url').value = auto_import_url.toString();
    }
  };
  document.getElementById('export_zip').onclick = function () {
    storage.downloadZip();
  };

  // Info dialog
  document.getElementById('infomenu').onclick = function () {
    document.getElementById('infodialog').style.display = 'block';
  };
  document.getElementById('infodialog').onclick = function (e) {
    if (e.target == document.getElementById('infodialog')) document.getElementById('infodialog').style.display = 'none';
  };
  document.getElementById('infodialogclose').onclick = function () {
    document.getElementById('infodialog').style.display = 'none';
  };

  // Auto URL/localStorage
  document.getElementById('auto_url_update').checked = storage.config.autoUrl;
  document.getElementById('auto_url_update').onclick = function () {
    storage.config.autoUrl = document.getElementById('auto_url_update').checked;
    if (storage.config.autoUrl) storage.update();
    else document.location.hash = '';
  };
  document.getElementById('auto_local_storage_update').checked = storage.config.autoLocalStorage;
  document.getElementById('auto_local_storage_update').onclick = function () {
    storage.config.autoLocalStorage = document.getElementById('auto_local_storage_update').checked;
    storage.update();
  };

  // Settings dialog
  document.getElementById('settingsmenu').onclick = function () {
    document.getElementById('settingsdialog').style.display = 'block';
  };
  document.getElementById('settingsdialog').onclick = function (e) {
    if (e.target == document.getElementById('settingsdialog'))
      document.getElementById('settingsdialog').style.display = 'none';
  };
  document.getElementById('settingsdialogclose').onclick = function () {
    document.getElementById('settingsdialog').style.display = 'none';
  };
  document.getElementById('compiler_settings_set').onclick = function () {
    urlParams = new URLSearchParams(window.location.search);
    var asmOptionsVal = document.getElementById('compiler_settings_asm').value.trim();
    if (asmOptionsVal != '') {
      urlParams.set('asm', asmOptionsVal);
      compiler.setAsmOptions(asmOptionsVal.split(' '));
    } else {
      compiler.setAsmOptions([]);
      urlParams.delete('asm');
    }
    var linkOptionsVal = document.getElementById('compiler_settings_link').value.trim();
    if (linkOptionsVal != '') {
      urlParams.set('link', linkOptionsVal);
      compiler.setLinkOptions(linkOptionsVal.split(' '));
    } else {
      compiler.setLinkOptions([]);
      urlParams.delete('link');
    }
    var fixOptionsVal = document.getElementById('compiler_settings_fix').value.trim();
    if (fixOptionsVal != '') {
      urlParams.set('fix', fixOptionsVal);
      compiler.setFixOptions(fixOptionsVal.split(' '));
    } else {
      urlParams.delete('fix');
      compiler.setFixOptions([]);
    }
    var url = new URL(window.location);
    url.search = urlParams.toString();
    window.history.replaceState({}, '', url);
    document.getElementById('settingsdialog').style.display = 'none';
    compileCode();
  };

  if (urlParams.has('autorun')) {
    var runCheck0 = emuEl(0, 'cpu_run_check');
    if (runCheck0) { runCheck0.checked = true; runCheck0.onclick(); }
  }

  // Init file selectors and compile
  compileCode();
}

// Export for DevTools
globalThis.emuCtxs = emuCtxs;
globalThis._compileCode = compileCode;