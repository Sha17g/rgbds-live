// ---------------------------------------------------------------------------
// main.js — Application entry + Tab manager
//
// Architecture:
//   - A shared set of DOM editors (Ace, GfxEditor) created by the first Panel
//   - Each Tab = one Panel (independent Storage/Compiler/Emulator)
//   - Tab switch: Save old Panel editor state → swap editor refs → restore new Panel state
// ---------------------------------------------------------------------------

import * as compilerMod from './compiler.js';
import * as emulatorMod from './emulator.js';
import * as storageMod from './storage.js';
import * as editorsMod from './editors.js';
import * as textEditorMod from './text-editor.js';
import * as gfxEditorMod from './gfx-editor.js';

import { Panel, panelManager } from './panel.js';

// Preserve debug entry for DEV mode
globalThis.emulator = emulatorMod;
if (import.meta.env.DEV) {
  globalThis._rgbdsDebug = {
    compiler: compilerMod,
    emulator: emulatorMod,
    storage: storageMod,
    editors: editorsMod,
    textEditor: textEditorMod,
    gfxEditor: gfxEditorMod,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Tab Manager
// ═══════════════════════════════════════════════════════════════════════════

/** Shared editor instances (extracted after first Panel creation) */
let sharedEditors = null;

/** @type {Panel[]} */
const tabPanels = [];

/** @type {number} Current active tab index */
let activeTabIndex = -1;

/** Auto-increment Tab ID */
let tabIdCounter = 1;

/**
 * Build the options object for Panel construction,
 * providing all DOM element IDs the Panel needs.
 */
function createPanelOpts() {
  return {
    containerId: 'container',
    aceDivId: 'textEditorDiv',
    gfxParentDivId: 'gfxEditorDiv',
    gfxTilesCanvasId: 'gfxEditorTilesCanvas',
    gfxDrawCanvasId: 'gfxEditorDrawCanvas',
    gfxPaletteCanvasId: 'gfxEditorPalette',
    emulatorCanvasId: 'emulator_screen_canvas',
    fileListId: 'filelist',
    outputLogId: 'output',
    statusBarId: 'statusbar',
    cpuDom: {
      pc: document.getElementById('cpu_pc'),
      sp: document.getElementById('cpu_sp'),
      a: document.getElementById('cpu_a'),
      bc: document.getElementById('cpu_bc'),
      de: document.getElementById('cpu_de'),
      hl: document.getElementById('cpu_hl'),
      flags: document.getElementById('cpu_flags'),
    },
  };
}

/**
 * Create a new Panel instance.
 * The first Panel creates editors; subsequent Panels reuse shared editors.
 * @returns {Panel}
 */
function createNewPanel() {
  const opts = createPanelOpts();

  if (!sharedEditors) {
    // First tab: let Panel create its own editors (_ownsEditors = true)
    const panel = new Panel(opts);
    sharedEditors = {
      textEditor: panel.textEditor,
      gfxEditor: panel.gfxEditor,
      editorManager: panel.editorManager,
    };
    return panel;
  }

  // Subsequent tabs: skip editor creation, use bindEditors later
  opts._sharedEditors = sharedEditors;
  const panel = new Panel(opts);
  panel.bindEditors(sharedEditors);
  return panel;
}

/** Save current Panel's editor state, then switch to target Panel */
function switchToTab(index, force = false) {
  if (!force && (index === activeTabIndex || index < 0 || index >= tabPanels.length)) return;
  if (index < 0 || index >= tabPanels.length) return;
  if (activeTabIndex >= 0 && tabPanels[activeTabIndex]) {
    tabPanels[activeTabIndex].saveEditorState();
  }

  // Stop current emulator
  if (activeTabIndex >= 0 && tabPanels[activeTabIndex]) {
    tabPanels[activeTabIndex].destroyEmulator();
  }

  activeTabIndex = index;
  const newPanel = tabPanels[index];

  // Bind shared editor refs to new Panel's Storage / Compiler
  if (sharedEditors && !newPanel._ownsEditors) {
    newPanel.bindEditors(sharedEditors);
  }

  // Restore new Panel's editor state
  newPanel.restoreEditorState();

  // Update UI
  updateTabBar();
  updateAllUI();
  refreshCompilerLog(newPanel);

  // Switch default instance references
  setDefaultInstances(newPanel);

  // Re-bind compiler log callback (new Panel's logCallback)
  newPanel.compiler.setLogCallback((str, kind) => {
    appendLog(str, kind);
  });

  // Re-bind emulator serial callback
  newPanel.emulator.setSerialCallback((value) => {
    const formatted = toHex2(value);
    document.getElementById('serial_log').innerText = '$' + formatted;
  });

  // Auto-open first file and compile
  const files = Object.keys(newPanel.storage.getFiles());
  if (files.length > 0) {
    const currentFile = newPanel._savedCurrentFile || files[0];
    newPanel.editorManager.setCurrentFile(currentFile);
  }

  // Deferred compile
  setTimeout(() => {
    compileCurrentPanel();
  }, 50);
}

/**
 * Add a new tab via user prompt.
 * Optionally copy files from the current tab or start from the template project.
 * @returns {number} The index of the newly created tab, or -1 if cancelled.
 */
function addNewTab() {
  const name = prompt('New tab name (leave empty for auto):', '');
  if (name === null) return -1; // User cancelled
  const copyFromCurrent = getActivePanel()
    ? confirm('Copy files from current tab?')
    : false;
  const panel = createNewPanel();
  if (name && name.trim()) {
    panel.customName = name.trim();
  }
  tabPanels.push(panel);
  panelManager.addPanel(panel);

  if (copyFromCurrent && getActivePanel()) {
    // Copy all files from current tab
    const srcFiles = getActivePanel().storage.getFiles();
    for (const [filename, content] of Object.entries(srcFiles)) {
      panel.storage.update(filename, content);
    }
  } else {
    // Initialize new tab with starting_project
    panel.storage.reset();
    panel.storage.autoLoad();
  }

  const idx = tabPanels.length - 1;
  switchToTab(idx);
  return idx;
}

/**
 * Close the tab at the given index.
 * Destroys its emulator and Panel, removes it from the tab list and PanelManager.
 * If the closed tab was active, switches to the nearest remaining tab.
 * @param {number} index
 */
function closeTab(index) {
  if (tabPanels.length <= 1) return; // Keep at least one
  const panel = tabPanels[index];
  const wasActive = (index === activeTabIndex);

  panel.destroyEmulator();
  panel.destroy();

  // Remove from PanelManager
  panelManager.removePanel(panel);

  tabPanels.splice(index, 1);

  // Fix up activeTabIndex
  if (activeTabIndex > index) {
    activeTabIndex--;
  } else if (activeTabIndex >= tabPanels.length) {
    activeTabIndex = tabPanels.length - 1;
  }

  // Refresh tab bar
  updateTabBar();

  // If closing the active tab, the same position now holds a different Panel after splice → force switch
  if (wasActive) {
    switchToTab(activeTabIndex, true);
  }
}

/**
 * Determine the display label for a tab.
 * Uses the custom name if set, otherwise the first file's basename, or fallback "Tab N".
 * @param {Panel} panel
 * @param {number} index
 * @returns {string}
 */
function getTabLabel(panel, index) {
  if (panel.customName) return panel.customName;
  const files = Object.keys(panel.storage.getFiles());
  if (files.length > 0) return files[0].replace(/\.(asm|inc)$/, '');
  return 'Tab ' + (index + 1);
}

/**
 * Re-render the tab bar UI from the current tabPanels array.
 * Highlights the active tab, wires up rename (dblclick) and close (×) interactions.
 */
function updateTabBar() {
  const tabList = document.getElementById('tab-list');
  if (!tabList) return;
  tabList.innerHTML = '';

  for (let i = 0; i < tabPanels.length; i++) {
    const panel = tabPanels[i];
    const div = document.createElement('div');
    div.className = 'tab-item' + (i === activeTabIndex ? ' active' : '');

    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = getTabLabel(panel, i);
    const files = Object.keys(panel.storage.getFiles());
    name.title = files.join(', ') || 'Double-click to rename';
    // Double-click to rename tab
    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const newName = prompt('Rename tab:', panel.customName || getTabLabel(panel, i));
      if (newName !== null) {
        panel.customName = newName.trim() || null;
        updateTabBar();
      }
    });
    div.appendChild(name);

    const closeBtn = document.createElement('span');
    closeBtn.className = 'tab-close';
    closeBtn.textContent = '×';
    closeBtn.title = 'Close tab';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(i);
    });
    div.appendChild(closeBtn);

    div.addEventListener('click', () => switchToTab(i));
    tabList.appendChild(div);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Current Panel convenience reference
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get the currently active Panel.
 * @returns {Panel|undefined}
 */
function getActivePanel() {
  return tabPanels[activeTabIndex];
}

function setDefaultInstances(panel) {
  compilerMod.setDefaultInstance(panel.compiler);
  emulatorMod.setDefaultInstance(panel.emulator);
  storageMod.setDefaultInstance(panel.storage);
  editorsMod.setDefaultInstance(panel.editorManager);
  textEditorMod.setDefaultInstance(panel.textEditor);
  gfxEditorMod.setDefaultInstance(panel.gfxEditor);
}

// ═══════════════════════════════════════════════════════════════════════════
// Global State
// ═══════════════════════════════════════════════════════════════════════════

let emu_view = '';
let rom = undefined;
let serial_log_buffer = [];
const serial_log_buffer_size = 256;

export function isDarkMode() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * Safely escape HTML special characters by rendering through a temporary DOM element.
 * @param {string} str
 * @returns {string}
 */
function escapeHTML(str) {
  const d = document.createElement('div');
  d.innerText = str;
  return d.innerHTML;
}

// ═══════════════════════════════════════════════════════════════════════════
// Compiler Log Output
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Append a line to the compiler output log element.
 * Passing (null, null) clears the log.
 * @param {string|null} str
 * @param {string|null} kind - CSS class name for styling
 */
function appendLog(str, kind) {
  const output = document.getElementById('output');
  if (str == null && kind == null) {
    output.innerHTML = '';
    return;
  }
  output.innerHTML += '<span class="' + kind + '">' + escapeHTML(str) + '</span>\n';
  output.scrollTop = output.scrollHeight;
}

function refreshCompilerLog(panel) {
  // Clear and re-bind log (handled in switchToTab)
}

// ═══════════════════════════════════════════════════════════════════════════
// Compilation Entry — compile the active Panel
// ═══════════════════════════════════════════════════════════════════════════

export function compileCurrentPanel() {
  const panel = getActivePanel();
  if (!panel) return;
  const compiler = panel.compiler;
  const textEditor = panel.textEditor;

  compiler.setLogCallback((str, kind) => {
    appendLog(str, kind);
  });

  compiler.compile((_rom_file, _start_address, _addr_to_line) => {
    if (textEditor) textEditor.updateErrors();
    updateFileList();

    destroyEmulator();
    rom = _rom_file;

    if (typeof _rom_file === 'undefined') return;

    panel.startAddress = _start_address;
    panel.addrToLine = _addr_to_line;
    panel._bootEmulator(rom, _start_address);
    updateBreakpoints();

    // Build line_to_addr reverse lookup table
    const line_to_addr = {};
    for (const addrStr in _addr_to_line) {
      const addr = parseInt(addrStr);
      const [filename, line] = _addr_to_line[addrStr];
      if (!line_to_addr[filename]) line_to_addr[filename] = {};
      if (!line_to_addr[filename][line]) line_to_addr[filename][line] = [];
      line_to_addr[filename][line].push(addr);
    }
    window._line_to_addr = line_to_addr;

    updateTextView();
  });
}

// Backward compatibility
export function compileCode() {
  compileCurrentPanel();
}

// ═══════════════════════════════════════════════════════════════════════════
// Emulator Management
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Destroy the current panel's emulator instance and clear ROM state.
 */
function destroyEmulator() {
  const panel = getActivePanel();
  if (panel) panel.destroyEmulator();
  rom = undefined;
  window._line_to_addr = {};
  if (sharedEditors && sharedEditors.textEditor) {
    sharedEditors.textEditor.setCpuLine(null, null);
  }
}

/**
 * Boot (or re-boot) the emulator for the active Panel.
 * @param {boolean} jump_to_pc - Whether to jump the editor cursor to the current PC address.
 */
function initEmulator(jump_to_pc) {
  const panel = getActivePanel();
  if (typeof rom === 'undefined' || !panel) return;
  panel._bootEmulator(rom, panel.startAddress);
  updateCpuState(jump_to_pc);
  updateBreakpoints();
}

/**
 * Advance the emulator by one unit (single step, frame, or continuous run).
 * If the emulator is not available, initialises it first.
 * @param {'single'|'frame'|'run'} step_type
 * @returns {boolean} Whether the emulator is still running after stepping.
 */
function stepEmulator(step_type) {
  const panel = getActivePanel();
  const emulator = panel ? panel.emulator : null;
  if (!emulator || !emulator.isAvailable()) {
    initEmulator(step_type === 'single' || step_type === 'frame');
    return false;
  }
  const result = emulator.step(step_type);
  updateCpuState(step_type === 'single' || step_type === 'frame');
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// Breakpoints
// ═══════════════════════════════════════════════════════════════════════════

export function updateBreakpoints() {
  const panel = getActivePanel();
  const emulator = panel ? panel.emulator : null;
  const textEditor = sharedEditors ? sharedEditors.textEditor : null;
  if (!emulator || !textEditor) return;

  emulator.clearBreakpoints();
  const breakpoints = textEditor.getBreakpoints();
  const line_to_addr = window._line_to_addr || {};
  for (const data of breakpoints) {
    const [filename, line_nr] = data;
    data[2] = false;
    if (!line_to_addr[filename] || !line_to_addr[filename][line_nr]) continue;
    data[2] = true;
    for (const addr of line_to_addr[filename][line_nr]) emulator.setBreakpoint(addr);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Keyboard Input
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Forward a keyboard event to the active Panel's Game Boy key handler.
 * The Escape key also stops auto-run.
 * @param {string} code - KeyboardEvent.code value
 * @param {boolean} down - true = keydown, false = keyup
 */
function handleGBKey(code, down) {
  const panel = getActivePanel();
  if (panel) {
    if (down) panel.handleKeyDown(code);
    else panel.handleKeyUp(code);
  }
  if (code === 'Escape') {
    document.getElementById('cpu_run_check').checked = false;
    document.getElementById('cpu_run_check').onclick();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Hex Utilities
// ═══════════════════════════════════════════════════════════════════════════

const hexTable = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
const toHex2 = (num) => hexTable[num & 0xff];
const toHex4 = (num) => hexTable[(num >> 8) & 0xff] + hexTable[num & 0xff];

/**
 * Format a number as a hex string with a `$` prefix.
 * @param {number} num
 * @param {number} digits - 2 or 4 hex digits
 * @returns {string}
 */
function toHex(num, digits) {
  if (digits === 2) return '$' + toHex2(num);
  return '$' + toHex4(num);
}

// ═══════════════════════════════════════════════════════════════════════════
// CPU State Update
// ═══════════════════════════════════════════════════════════════════════════

const cpuDom = {
  pc: document.getElementById('cpu_pc'),
  sp: document.getElementById('cpu_sp'),
  a: document.getElementById('cpu_a'),
  bc: document.getElementById('cpu_bc'),
  de: document.getElementById('cpu_de'),
  hl: document.getElementById('cpu_hl'),
  flags: document.getElementById('cpu_flags'),
};

/**
 * Refresh CPU register display, render the emulator screen,
 * update VRAM / text views, and highlight the current source line.
 * @param {boolean} afterSingleStep - If true, scroll the editor to the PC line.
 */
function updateCpuState(afterSingleStep) {
  const panel = getActivePanel();
  const emulator = panel ? panel.emulator : null;
  if (!emulator || !emulator.isAvailable()) return;

  emulator.renderScreen();

  const pc = emulator.getPC();
  cpuDom.pc.innerText = toHex(pc, 4);
  cpuDom.sp.innerText = toHex(emulator.getSP(), 4);
  cpuDom.a.innerText = toHex(emulator.getA(), 2);
  cpuDom.bc.innerText = toHex(emulator.getBC(), 4);
  cpuDom.de.innerText = toHex(emulator.getDE(), 4);
  cpuDom.hl.innerText = toHex(emulator.getHL(), 4);
  cpuDom.flags.innerText = emulator.getFlags();

  const addr_to_line = panel.addrToLine || {};
  let file_line_nr = addr_to_line[pc];
  if (!file_line_nr) file_line_nr = addr_to_line[pc - 1];
  const te = sharedEditors ? sharedEditors.textEditor : null;
  if (te) {
    if (file_line_nr) te.setCpuLine(file_line_nr[0], file_line_nr[1], afterSingleStep);
    else te.setCpuLine(null, null);
  }

  updateVRamCanvas();
  updateTextView();
}

/**
 * Redraw the VRAM canvas based on the current emu_view mode
 * (vram, bg0, or bg1). Skipped when the canvas is hidden.
 */
function updateVRamCanvas() {
  const canvas = document.getElementById('emulator_vram_canvas');
  if (!canvas || canvas.style.display === 'none') return;

  const panel = getActivePanel();
  const emulator = panel ? panel.emulator : null;
  if (!emulator) return;

  if (emu_view === 'vram') emulator.renderVRam(canvas);
  if (emu_view === 'bg0')  emulator.renderBackground(canvas, 0);
  if (emu_view === 'bg1')  emulator.renderBackground(canvas, 1);
}

/**
 * Render the text-based memory viewer (ROM, WRAM, HRAM, IO registers, serial log)
 * into the emulator_display_text element, depending on emu_view.
 */
function updateTextView() {
  const display_text = document.getElementById('emulator_display_text');
  if (!display_text || display_text.style.display === 'none') return;

  const panel = getActivePanel();
  const emulator = panel ? panel.emulator : null;
  const compiler = panel ? panel.compiler : null;
  if (!emulator) return;

  let data = rom;
  let bank_size = 0x4000;
  let offset = 0x0000;
  let symbols = compiler ? compiler.getRomSymbols() : [];

  if (emu_view === 'wram') {
    data = emulator.getWRam();
    bank_size = 0x1000;
    offset = 0xc000;
    symbols = compiler ? compiler.getRamSymbols() : [];
  }
  if (emu_view === 'hram') {
    data = emulator.getHRam();
    bank_size = 0x1000;
    offset = 0xff80;
    symbols = compiler ? compiler.getRamSymbols() : [];
  }
  if (emu_view === 'io') {
    let text = '';
    const registers = [
      'P1 0xff00', 'SB 0xff01', 'SC 0xff02', 'DIV 0xff04', 'TIMA 0xff05',
      'TMA 0xff06', 'TAC 0xff07', 'IF 0xff0f', 'LCDC 0xff40', 'STAT 0xff41',
      'SCY 0xff42', 'SCX 0xff43', 'LY 0xff44', 'LYC 0xff45', 'DMA 0xff46',
      'BGP 0xff47', 'OBP0 0xff48', 'OBP1 0xff49', 'WY 0xff4a', 'WX 0xff4b',
      'KEY1 0xff4d', 'VBK 0xff4f', 'RP 0xff56', 'BCPS 0xff68', 'BCPD 0xff69',
      'OCPS 0xff6a', 'OCPD 0xff6b', 'SVBK 0xff70', 'IE 0xffff',
    ];
    for (const regDef of registers) {
      const [name, addrStr] = regDef.split(' ');
      const addr = parseInt(addrStr);
      text += '<span style="float: left; width: 50px">' + name + ':</span>' +
        toHex2(emulator.readMem(addr)) + '<br/>';
    }
    display_text.innerHTML = text;
    return;
  }
  if (emu_view === 'serial') {
    let text = '';
    for (let n = 0; n < serial_log_buffer.length; n += 16) {
      text += serial_log_buffer.slice(n, n + 16).join(' ') + '\n';
    }
    display_text.textContent = text;
    return;
  }
  if (typeof data === 'undefined') return;

  let text = '<div class="emulator_display_header">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; 0&nbsp; 1&nbsp; 2&nbsp; 3&nbsp; 4&nbsp; 5&nbsp; 6&nbsp; 7&nbsp; 8&nbsp; 9&nbsp; a&nbsp; b&nbsp; c&nbsp; d&nbsp; e&nbsp; f</div>';
  let symbol = null;
  let span = false;
  let span_color = 0;

  for (let n = 0; n < data.length; n += 16) {
    const hex = Array.prototype.map.call(data.slice(n, n + 16), (x) => toHex2(x));
    const bank = ~~(n / bank_size);
    let addr = n & (bank_size - 1);
    if (bank > 0) addr += bank_size;
    text += toHex2(bank) + ':' + toHex4(addr + offset);

    for (let idx = 0; idx < hex.length; idx++) {
      text += ' ';
      const new_symbol = symbols[n + idx + offset];
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
        text += '<span title="' + symbol + '" style="background-color: hsl(' + span_color +
          (isDarkMode() ? ', 30%, 30%)">' : ', 50%, 50%)">');
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

// ═══════════════════════════════════════════════════════════════════════════
// File List
// ═══════════════════════════════════════════════════════════════════════════

export function updateFileList() {
  const panel = getActivePanel();
  if (!panel) return;
  const filelist = document.getElementById('filelist');
  if (!filelist) return;
  filelist.textContent = '';

  const storage = panel.storage;
  const editors = panel.editorManager;
  const compiler = panel.compiler;

  for (const name of Object.keys(storage.getFiles()).sort()) {
    const entry = document.createElement('li');
    entry.textContent = name;
    filelist.appendChild(entry);

    if (name === editors.getCurrentFilename()) entry.classList.add('active');
    if (compiler) {
      for (const [type, filename] of compiler.getErrors()) {
        if (filename !== name) continue;
        entry.classList.add(type);
        if (type === 'error') {
          entry.classList.remove('warning');
          break;
        }
      }
    }
  }
}

function updateAllUI() {
  updateFileList();
  updateCpuState();
}

/**
 * Delete a file from the active Panel's storage.
 * If it was the current file, switch to the first remaining file.
 * Prevents deletion when only one file remains.
 * @param {string} name
 */
function deleteFile(name) {
  const panel = getActivePanel();
  if (!panel) return;
  const storage = panel.storage;
  const editors = panel.editorManager;
  if (Object.keys(storage.getFiles()).length < 2) return;
  storage.update(name, null);
  if (editors.getCurrentFilename() === name) {
    editors.setCurrentFile(Object.keys(storage.getFiles()).sort()[0]);
  }
  updateFileList();
}

/**
 * Show one emulator display tab (screen canvas / VRAM canvas / text display)
 * and hide the others.
 * @param {string} type - Element ID of the tab to show
 */
function showTabType(type) {
  const tabTypes = ['emulator_screen_canvas', 'emulator_vram_canvas', 'emulator_display_text'];
  tabTypes.forEach((tabType) => {
    document.getElementById(tabType).style.display = type === tabType ? '' : 'none';
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Initialization
// ═══════════════════════════════════════════════════════════════════════════

export function init() {
  // ── Create default Tab (index 0) ──
  const defaultPanel = createNewPanel();
  tabPanels.push(defaultPanel);
  panelManager.addPanel(defaultPanel);
  activeTabIndex = 0;

  // Bind shared editor refs to local scope
  if (!sharedEditors && defaultPanel.textEditor) {
    sharedEditors = {
      textEditor: defaultPanel.textEditor,
      gfxEditor: defaultPanel.gfxEditor,
      editorManager: defaultPanel.editorManager,
    };
  }

  // Set default instances
  setDefaultInstances(defaultPanel);

  // Bind module-level proxies
  textEditorMod.setDefaultInstance(defaultPanel.textEditor);
  gfxEditorMod.setDefaultInstance(defaultPanel.gfxEditor);

  // ── Tab bar events ──
  document.getElementById('tab-new-btn').addEventListener('click', addNewTab);
  updateTabBar();

  // ── Storage UI update callback (handled internally by Panel) ──
  const storage = defaultPanel.storage;
  const editors = defaultPanel.editorManager;

  storage.setOnUIUpdate(() => {
    editors.setCurrentFile(Object.keys(storage.getFiles()).sort()[0]);
  });

  // URL params: compiler options
  const urlParams = new URLSearchParams(window.location.search);
  applyCompilerOptions(urlParams);

  // Auto-load project
  storage.autoLoad();
  editors.setCurrentFile(Object.keys(storage.getFiles()).pop());
  updateFileList();

  // ── File list click ──
  document.getElementById('filelist').onclick = function (e) {
    const text = e.target.childNodes[0] && e.target.childNodes[0].wholeText;
    if (!text) return;
    const panel = getActivePanel();
    if (panel && panel.editorManager) {
      panel.editorManager.setCurrentFile(text);
    }
    updateFileList();
    updateCpuState();
  };

  // ── Sidebar hamburger button ──
  document.getElementById('hamburger-container').onclick = function () {
    document.querySelector('body .container:first-child').classList.toggle('filelist-open');
  };

  // ── New file dialog ──
  document.getElementById('newfile').onclick = function () {
    document.getElementById('newfiledialog').style.display = 'block';
  };
  document.getElementById('newfiledialog').onclick = function (e) {
    if (e.target === document.getElementById('newfiledialog'))
      document.getElementById('newfiledialog').style.display = 'none';
  };
  document.getElementById('newfiledialogclose').onclick = function () {
    document.getElementById('newfiledialog').style.display = 'none';
  };
  document.getElementById('newfile_empty_create').onclick = function () {
    const panel = getActivePanel();
    if (!panel) return;
    let result = document.getElementById('newfile_name').value;
    if (!result) return;
    if (result.indexOf('.') < 0) result += '.asm';
    if (result in panel.storage.getFiles()) return;
    if (panel.editorManager.getFileType(result) === 'text') panel.storage.update(result, '');
    else panel.storage.update(result, new Uint8Array(16));
    panel.editorManager.setCurrentFile(result);
    updateFileList();
    document.getElementById('newfiledialog').style.display = 'none';
  };
  document.getElementById('newfile_upload').onchange = function (e) {
    const panel = getActivePanel();
    if (!panel) return;
    const files = e.target.files;
    if (files.length === 0) return;
    const loadPromises = [];
    for (let i = 0; i < files.length; i++) {
      (function (file) {
        const p = panel.editorManager.getFileType(file.name) === 'text' ? file.text() : file.arrayBuffer();
        loadPromises.push(p.then(function (data) {
          panel.storage.update(file.name, data);
        }));
      })(files[i]);
    }
    Promise.all(loadPromises).then(function () {
      panel.editorManager.setCurrentFile(files[files.length - 1].name);
      updateFileList();
    });
    e.target.value = '';
    document.getElementById('newfiledialog').style.display = 'none';
  };

  // ── Delete file ──
  document.getElementById('delfile').onclick = function () {
    const panel = getActivePanel();
    if (!panel) return;
    if (confirm('Are you sure you want to delete: ' + panel.editorManager.getCurrentFilename() + '?')) {
      deleteFile(panel.editorManager.getCurrentFilename());
    }
  };

  // ── New project ──
  document.getElementById('newproject').onclick = function () {
    const panel = getActivePanel();
    if (!panel) return;
    if (!confirm('Are you sure to clear the current project?')) return;
    panel.storage.reset();
    panel.editorManager.setCurrentFile('main.asm');
    updateFileList();
  };

  // ── Compiler log ──
  defaultPanel.compiler.setLogCallback((str, kind) => {
    appendLog(str, kind);
  });

  // ── Emulator serial ──
  defaultPanel.emulator.setSerialCallback((value) => {
    const formatted = toHex2(value);
    document.getElementById('serial_log').innerText = '$' + formatted;
    serial_log_buffer.unshift(formatted);
    if (serial_log_buffer.length > serial_log_buffer_size) {
      serial_log_buffer.length = serial_log_buffer_size;
    }
  });

  compileCode();

  // ── Emulator control buttons ──
  document.getElementById('cpu_single_step').onclick = () => stepEmulator('single');
  document.getElementById('cpu_frame_step').onclick  = () => stepEmulator('frame');
  document.getElementById('cpu_reset').onclick       = () => initEmulator(true);
  document.getElementById('cpu_run_check').onclick   = function () {
    if (document.getElementById('cpu_run_check').checked) {
      requestAnimationFrame(function runFn() {
        if (!document.hidden) {
          if (stepEmulator('run')) document.getElementById('cpu_run_check').checked = false;
        }
        if (document.getElementById('cpu_run_check').checked) requestAnimationFrame(runFn);
      });
    }
  };

  // ── Keyboard ──
  const kbInput = document.getElementById('emulator_screen_container');
  kbInput.tabIndex = -1;
  kbInput.onkeydown = function (e) { handleGBKey(e.code, true);  e.preventDefault(); };
  kbInput.onkeyup   = function (e) { handleGBKey(e.code, false); e.preventDefault(); };

  document.onkeydown = function (e) {
    if (e.code === 'F8') { stepEmulator('single'); e.preventDefault(); }
    if (e.code === 'F9') { stepEmulator('frame'); e.preventDefault(); }
    if (e.ctrlKey && e.code === 'KeyT') { addNewTab(); e.preventDefault(); }
    if (e.ctrlKey && e.code === 'KeyW') {
      if (tabPanels.length > 1) closeTab(activeTabIndex);
      e.preventDefault();
    }
  };

  // ── Emulator view tabs ──
  document.getElementById('emulator_display_screen').onclick = () => { showTabType('emulator_screen_canvas'); emu_view = 'display'; };
  document.getElementById('emulator_display_vram').onclick   = () => { showTabType('emulator_vram_canvas'); emu_view = 'vram'; updateVRamCanvas(); };
  document.getElementById('emulator_display_bg0').onclick    = () => { showTabType('emulator_vram_canvas'); emu_view = 'bg0'; updateVRamCanvas(); };
  document.getElementById('emulator_display_bg1').onclick    = () => { showTabType('emulator_vram_canvas'); emu_view = 'bg1'; updateVRamCanvas(); };
  document.getElementById('emulator_display_rom').onclick    = () => { showTabType('emulator_display_text'); emu_view = 'rom'; updateTextView(); };
  document.getElementById('emulator_display_wram').onclick   = () => { showTabType('emulator_display_text'); emu_view = 'wram'; updateTextView(); };
  document.getElementById('emulator_display_hram').onclick   = () => { showTabType('emulator_display_text'); emu_view = 'hram'; updateTextView(); };
  document.getElementById('emulator_display_io').onclick     = () => { showTabType('emulator_display_text'); emu_view = 'io'; updateTextView(); };
  document.getElementById('emulator_display_serial').onclick = () => { showTabType('emulator_display_text'); emu_view = 'serial'; updateTextView(); };

  // ── Download ROM ──
  document.getElementById('download_rom').onclick = function () {
    if (typeof rom === 'undefined') return;
    const element = document.createElement('a');
    const url = window.URL.createObjectURL(new Blob([rom.buffer], { type: 'application/octet-stream' }));
    element.setAttribute('href', url);
    element.setAttribute('download', 'rom.gb');
    element.style.display = 'none';
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
    window.URL.revokeObjectURL(url);
  };

  // ── Import dialog ──
  document.getElementById('importmenu').onclick = () => { document.getElementById('importdialog').style.display = 'block'; };
  document.getElementById('importdialog').onclick = function (e) {
    if (e.target === document.getElementById('importdialog')) document.getElementById('importdialog').style.display = 'none';
  };
  document.getElementById('importdialogclose').onclick = () => { document.getElementById('importdialog').style.display = 'none'; };
  document.getElementById('import_gist').onclick = () => {
    const panel = getActivePanel();
    if (panel) panel.storage.loadGithubGist(document.getElementById('import_gist_url').value);
    document.getElementById('importdialog').style.display = 'none';
  };
  document.getElementById('import_zipfile').onchange = function (e) {
    if (e.target.files.length > 0) {
      const panel = getActivePanel();
      if (panel) panel.storage.loadZip(e.target.files[0]);
      e.target.value = '';
      document.getElementById('importdialog').style.display = 'none';
    }
  };

  // ── Export dialog ──
  document.getElementById('exportmenu').onclick = () => {
    const panel = getActivePanel();
    if (!panel) return;
    document.getElementById('exportdialog').style.display = 'block';
    document.getElementById('export_hash_url').value = panel.storage.getHashUrl();
  };
  document.getElementById('exportdialog').onclick = function (e) {
    if (e.target === document.getElementById('exportdialog')) document.getElementById('exportdialog').style.display = 'none';
  };
  document.getElementById('exportdialogclose').onclick = () => { document.getElementById('exportdialog').style.display = 'none'; };
  document.getElementById('export_gist').onclick = () => {
    const panel = getActivePanel();
    if (!panel) return;
    const url = document.getElementById('export_gist_url').value;
    const username = document.getElementById('export_gist_username').value;
    const token = document.getElementById('export_gist_token').value;
    const resultUrl = panel.storage.saveGithubGist(username, token, url);
    if (resultUrl == null) {
      document.getElementById('export_gist_import_url').value = 'Gist create/update failed. Incorrect token?';
    } else {
      document.getElementById('export_gist_url').value = resultUrl;
      const autoImportUrl = new URL(document.location);
      autoImportUrl.hash = resultUrl;
      document.getElementById('export_gist_import_url').value = autoImportUrl.toString();
    }
  };
  document.getElementById('export_zip').onclick = () => {
    const panel = getActivePanel();
    if (panel) panel.storage.downloadZip();
  };

  // ── Info dialog ──
  document.getElementById('infomenu').onclick = () => { document.getElementById('infodialog').style.display = 'block'; };
  document.getElementById('infodialog').onclick = function (e) {
    if (e.target === document.getElementById('infodialog')) document.getElementById('infodialog').style.display = 'none';
  };
  document.getElementById('infodialogclose').onclick = () => { document.getElementById('infodialog').style.display = 'none'; };

  // ── Settings ──
  const { config } = storageMod;
  document.getElementById('auto_url_update').checked = config.autoUrl;
  document.getElementById('auto_url_update').onclick = function () {
    config.autoUrl = document.getElementById('auto_url_update').checked;
    const panel = getActivePanel();
    if (config.autoUrl && panel) panel.storage.update();
    else document.location.hash = '';
  };
  document.getElementById('auto_local_storage_update').checked = config.autoLocalStorage;
  document.getElementById('auto_local_storage_update').onclick = function () {
    config.autoLocalStorage = document.getElementById('auto_local_storage_update').checked;
    const panel = getActivePanel();
    if (panel) panel.storage.update();
  };

  document.getElementById('settingsmenu').onclick = () => { document.getElementById('settingsdialog').style.display = 'block'; };
  document.getElementById('settingsdialog').onclick = function (e) {
    if (e.target === document.getElementById('settingsdialog')) document.getElementById('settingsdialog').style.display = 'none';
  };
  document.getElementById('settingsdialogclose').onclick = () => { document.getElementById('settingsdialog').style.display = 'none'; };
  document.getElementById('compiler_settings_set').onclick = () => {
    const panel = getActivePanel();
    if (!panel) return;
    const params = new URLSearchParams(window.location.search);
    const asmOptions = document.getElementById('compiler_settings_asm').value.trim();
    if (asmOptions) { params.set('asm', asmOptions); panel.compiler.setAsmOptions(asmOptions.split(' ')); }
    else { panel.compiler.setAsmOptions([]); params.delete('asm'); }
    const linkOptions = document.getElementById('compiler_settings_link').value.trim();
    if (linkOptions) { params.set('link', linkOptions); panel.compiler.setLinkOptions(linkOptions.split(' ')); }
    else { panel.compiler.setLinkOptions([]); params.delete('link'); }
    const fixOptions = document.getElementById('compiler_settings_fix').value.trim();
    if (fixOptions) { params.set('fix', fixOptions); panel.compiler.setFixOptions(fixOptions.split(' ')); }
    else { panel.compiler.setFixOptions([]); params.delete('fix'); }
    const url = new URL(window.location);
    url.search = params.toString();
    window.history.replaceState({}, '', url);
    document.getElementById('settingsdialog').style.display = 'none';
    compileCode();
  };

  if (urlParams.has('autorun')) {
    document.getElementById('cpu_run_check').checked = true;
    document.getElementById('cpu_run_check').onclick();
  }
}

// ── Helpers ──

function applyCompilerOptions(urlParams) {
  const panel = getActivePanel();
  if (!panel) return;
  const compiler = panel.compiler;
  const asmOptions = (urlParams.get('asm') ?? '').trim();
  if (asmOptions) {
    document.getElementById('compiler_settings_asm').value = asmOptions;
    compiler.setAsmOptions(asmOptions.split(' '));
  }
  const linkOptions = (urlParams.get('link') ?? '').trim();
  if (linkOptions) {
    document.getElementById('compiler_settings_link').value = linkOptions;
    compiler.setLinkOptions(linkOptions.split(' '));
  }
  const fixOptions = (urlParams.get('fix') ?? '').trim();
  if (fixOptions) {
    document.getElementById('compiler_settings_fix').value = fixOptions;
    compiler.setFixOptions(fixOptions.split(' '));
  }
}