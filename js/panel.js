// ---------------------------------------------------------------------------
// Panel class — a complete micro IDE unit
//
//   Panel = Storage + Compiler + Emulator + EditorManager + DOM
//
// Each Panel owns independent: file storage, compiler, emulator,
// editor manager, and UI. Multiple panels can run side by side with
// full isolation.
// ---------------------------------------------------------------------------

import { Storage } from './storage.js';
import { Compiler } from './compiler.js';
import { Emulator } from './emulator.js';
import { TextEditor } from './text-editor.js';
import { GfxEditor } from './gfx-editor.js';
import { EditorManager } from './editors.js';

export class Panel {
  /**
   * @param {object} opts
   * @param {string} opts.id                  Unique panel ID
   * @param {string} opts.containerId         DOM container ID for this panel
   * @param {string} opts.aceDivId            Ace editor div ID
   * @param {string} opts.gfxParentDivId      Tile editor parent container ID
   * @param {string} opts.gfxTilesCanvasId    Tile list canvas ID
   * @param {string} opts.gfxDrawCanvasId     Tile draw canvas ID
   * @param {string} opts.gfxPaletteCanvasId  Palette canvas ID
   * @param {string} opts.emulatorCanvasId    Emulator canvas ID
   * @param {string} opts.fileListId          File list element ID
   * @param {string} opts.outputLogId         Output log element ID
   * @param {string} opts.statusBarId         Status bar element ID
   * @param {object} opts.cpuDom              CPU register DOM reference collection
   * @param {Function} opts.onActivate        Callback when panel is activated
   */
  constructor(opts = {}) {
    this.id = opts.id || 'panel_default';
    /** User-defined tab label (null = auto-generated) */
    this.customName = null;
    this.onActivate = opts.onActivate || (() => {});

    // ── Core modules (each Panel has its own) ──
    this.storage  = new Storage();
    this.compiler = new Compiler({ storage: this.storage });
    this.emulator = new Emulator();

    // ── Editors — can be injected from outside or created internally ──
    this._ownsEditors = false; // Whether this panel created its own editor instances
    this.gfxEditor = null;
    this.textEditor = null;
    this.editorManager = null;

    /** Editor creation params (cleared after shared editors are injected) */
    this._editorOpts = opts;

    // Create private editor instances if no shared editors are provided
    if (!opts._sharedEditors) {
      this._createEditors(opts);
    } else {
      // Use shared editors (injected by PanelManager)
      this._sharedEditors = opts._sharedEditors;
      this._ownsEditors = false;
    }

    // ── Compiler log output ──
    this.compiler.setLogCallback((str, kind) => {
      this._appendLog(str, kind);
    });

    // ── Emulator serial output ──
    this.emulator.setSerialCallback((value) => {
      this._appendLog(String.fromCharCode(value), 'serial');
    });

    // ── Emulator startup state ──
    /** @type {number|null} ROM entry address */
    this.startAddress = null;

    /** @type {Object<number, [string, number]>} Address-to-line mapping */
    this.addrToLine = {};

    // ── DOM references ──
    this.containerEl = document.getElementById(opts.containerId);
    this.fileListEl  = document.getElementById(opts.fileListId);
    this.outputLogEl = document.getElementById(opts.outputLogId);
    this.statusBarEl = document.getElementById(opts.statusBarId);
    this.emuCanvasEl = document.getElementById(opts.emulatorCanvasId ?? 'emulator_screen_canvas');

    /** @type {object} CPU register DOM elements */
    this.cpuDom = opts.cpuDom || {};

    /** Editor state snapshot (saved/restored on tab switch) */
    this._savedCurrentFile = '';
    this._savedCursorPos = {};
    this._savedBreakpoints = [];
    this._savedCpuLine = [null, null];
  }

  /** Create editor instances (only called for the first Panel) */
  _createEditors(opts) {
    this._ownsEditors = true;

    this.gfxEditor = new GfxEditor({
      parentDivId: opts.gfxParentDivId,
      tilesCanvasId: opts.gfxTilesCanvasId,
      drawCanvasId: opts.gfxDrawCanvasId,
      paletteCanvasId: opts.gfxPaletteCanvasId,
      storage: this.storage,
      onFileChange: () => {
        this.compiler.compile(() => {});
      },
    });

    this.textEditor = new TextEditor({
      divId: opts.aceDivId,
      storage: this.storage,
      compiler: this.compiler,
      compileCallback: () => {
        this.compiler.compile((rom, startAddr, addrToLine) => {
          if (rom) this._bootEmulator(rom, startAddr);
        });
      },
      onBreakpointChange: () => {
        this._updateBreakpoints();
      },
    });

    this.editorManager = new EditorManager({
      textEditor: this.textEditor,
      gfxEditor: this.gfxEditor,
      storage: this.storage,
    });
  }

  /**
   * Bind shared editor instances (called on tab switch).
   * @param {object} editors { textEditor, gfxEditor, editorManager }
   */
  bindEditors(editors) {
    this.textEditor = editors.textEditor;
    this.gfxEditor = editors.gfxEditor;
    this.editorManager = editors.editorManager;

    // Update editor storage/compiler references to this panel's instances
    this.textEditor.storage = this.storage;
    this.textEditor.compiler = this.compiler;
    this.gfxEditor.storage = this.storage;
    this.editorManager.storage = this.storage;
    this.editorManager.textEditor = this.textEditor;
    this.editorManager.gfxEditor = this.gfxEditor;

    // Re-bind compile callback (previous panel's callback is stale)
    const origCallback = this.textEditor.compileCallback;
    this.textEditor.compileCallback = () => {
      this.compiler.compile((rom, startAddr, addrToLine) => {
        if (rom) this._bootEmulator(rom, startAddr);
      });
    };

    // Re-bind breakpoint change callback
    this.textEditor.onBreakpointChange = () => {
      this._updateBreakpoints();
    };
  }

  /** Save current editor state into this Panel */
  saveEditorState() {
    if (!this.textEditor) return;
    this._savedCurrentFile = this.textEditor.currentFile;
    if (this.textEditor.currentFile != null) {
      this._savedCursorPos = { ...this.textEditor.cursorPositionPerFile };
    }
    this._savedBreakpoints = this.textEditor.breakpoints.map(b => [...b]);
    this._savedCpuLine = [this.textEditor.cpuLineFilename, this.textEditor.cpuLineNr];
  }

  /** Restore editor state from this Panel */
  restoreEditorState() {
    if (!this.textEditor) return;
    this.textEditor.breakpoints = this._savedBreakpoints.map(b => [...b]);
    this.textEditor.cursorPositionPerFile = { ...this._savedCursorPos };
    this.textEditor.cpuLineFilename = this._savedCpuLine[0];
    this.textEditor.cpuLineNr = this._savedCpuLine[1];
    this.textEditor._renderBreakpoints();
  }

  // =======================================================================
  // File management
  // =======================================================================

  addFile(name, content, base) {
    this.storage.add(name, content, base);
    this.refreshFileList();
  }

  removeFile(name) {
    this.storage.remove(name);
    this.refreshFileList();
  }

  renameFile(oldName, newName) {
    this.storage.rename(oldName, newName);
    this.refreshFileList();
  }

  getFileCount() {
    return Object.keys(this.storage.files).length;
  }

  refreshFileList() {
    if (!this.fileListEl) return;
    this.fileListEl.innerHTML = '';
    const names = Object.keys(this.storage.files);
    names.sort();
    const self = this;
    for (const name of names) {
      const btn = document.createElement('button');
      btn.textContent = name;
      const type = this.editorManager.getFileType(name);
      btn.className = 'fileListItem';
      if (type !== 'text') btn.className += ' binary';
      btn.addEventListener('click', () => {
        self.editorManager.setCurrentFile(name);
        self._markActiveFileListItem(btn);
      });
      this.fileListEl.appendChild(btn);
    }
  }

  _markActiveFileListItem(btn) {
    if (!this.fileListEl) return;
    const prev = this.fileListEl.querySelector('.fileListItem.active');
    if (prev) prev.classList.remove('active');
    if (btn) btn.classList.add('active');
  }

  // =======================================================================
  // Compilation
  // =======================================================================

  /**
   * Compile assembly source code.
   * @param {string} [entryAsm] Specific entry .asm file to compile
   */
  compile(entryAsm) {
    this.compiler.compile((rom, startAddr, addrToLine) => {
      if (rom) {
        this.startAddress = startAddr;
        this.addrToLine  = addrToLine;
        this._bootEmulator(rom, startAddr);
      }
      this.textEditor.updateErrors();
    }, entryAsm);
  }

  // =======================================================================
  // Emulator
  // =======================================================================

  _bootEmulator(rom, startAddr) {
    this.emulator.init(this.emuCanvasEl, rom);
    this.emulator.setPC(startAddr ?? 0x100);
    this._updateBreakpoints();
  }

  destroyEmulator() {
    this.emulator.destroy();
  }

  stepEmulator(stepType) {
    if (!this.emulator.isAvailable()) {
      this.compile();
      return;
    }
    const hit = this.emulator.step(stepType);
    this._updateCpuState(stepType === 'single' || stepType === 'frame');
    return hit;
  }

  _updateBreakpoints() {
    if (!this.emulator.isAvailable()) return;
    this.emulator.clearBreakpoints();
    for (const [filename, lineNr] of this.textEditor.getBreakpoints()) {
      const entry = this.addrToLine;
      for (const addrStr in entry) {
        const addr = parseInt(addrStr);
        const [fn, ln] = entry[addrStr];
        if (fn === filename && ln === lineNr) {
          this.emulator.setBreakpoint(addr);
        }
      }
    }
  }

  /**
   * Update CPU register display and highlight current source line.
   * @param {boolean} afterSingleStep Whether to highlight the current PC line in the editor
   */
  _updateCpuState(afterSingleStep) {
    this.emulator.renderScreen();
    const pc = this.emulator.getPC();

    if (this.cpuDom.pc)        this.cpuDom.pc.innerText      = this._toHex(pc, 4);
    if (this.cpuDom.sp)        this.cpuDom.sp.innerText       = this._toHex(this.emulator.getSP(), 4);
    if (this.cpuDom.a)         this.cpuDom.a.innerText        = this._toHex(this.emulator.getA(), 2);
    if (this.cpuDom.bc)        this.cpuDom.bc.innerText       = this._toHex(this.emulator.getBC(), 4);
    if (this.cpuDom.de)        this.cpuDom.de.innerText       = this._toHex(this.emulator.getDE(), 4);
    if (this.cpuDom.hl)        this.cpuDom.hl.innerText       = this._toHex(this.emulator.getHL(), 4);
    if (this.cpuDom.flags)     this.cpuDom.flags.innerText    = this.emulator.getFlags();

    if (afterSingleStep) {
      const info = this.addrToLine[pc];
      if (info) {
        this.textEditor.setCpuLine(info[0], info[1], true);
      }
    }
  }

  // =======================================================================
  // Keyboard input routing (each Panel handles independently)
  // =======================================================================

  handleKeyDown(code) {
    if (!this.emulator.isAvailable()) return false;
    let consumed = true;
    if (code === 'ArrowRight')  this.emulator.setKeyPad('right', true);
    else if (code === 'ArrowLeft')   this.emulator.setKeyPad('left', true);
    else if (code === 'ArrowUp')     this.emulator.setKeyPad('up', true);
    else if (code === 'ArrowDown')   this.emulator.setKeyPad('down', true);
    else if (code === 'KeyS')        this.emulator.setKeyPad('a', true);
    else if (code === 'KeyA')        this.emulator.setKeyPad('b', true);
    else if (code === 'ShiftRight')  this.emulator.setKeyPad('select', true);
    else if (code === 'Enter')       this.emulator.setKeyPad('start', true);
    else consumed = false;
    return consumed;
  }

  handleKeyUp(code) {
    if (!this.emulator.isAvailable()) return false;
    let consumed = true;
    if (code === 'ArrowRight')  this.emulator.setKeyPad('right', false);
    else if (code === 'ArrowLeft')   this.emulator.setKeyPad('left', false);
    else if (code === 'ArrowUp')     this.emulator.setKeyPad('up', false);
    else if (code === 'ArrowDown')   this.emulator.setKeyPad('down', false);
    else if (code === 'KeyS')        this.emulator.setKeyPad('a', false);
    else if (code === 'KeyA')        this.emulator.setKeyPad('b', false);
    else if (code === 'ShiftRight')  this.emulator.setKeyPad('select', false);
    else if (code === 'Enter')       this.emulator.setKeyPad('start', false);
    else consumed = false;
    return consumed;
  }

  // =======================================================================
  // Logging
  // =======================================================================

  _appendLog(str, kind) {
    if (!this.outputLogEl) return;

    // null = clear log
    if (str == null) {
      this.outputLogEl.innerHTML = '';
      return;
    }

    const max = 256;
    while (this.outputLogEl.childElementCount >= max) {
      this.outputLogEl.removeChild(this.outputLogEl.firstChild);
    }

    // ANSI colorization (stdout only)
    if (kind === 'stdout') str = this._ansiColors(str);

    const node = (kind === 'stderr' || kind === 'serial')
      ? document.createElement('span')
      : document.createTextNode(str);

    if (kind === 'stderr') {
      node.style.color = '#f77';
      node.innerText = str;
    } else if (kind === 'serial') {
      node.style.color = '#afa';
      node.innerText = str;
    }
    this.outputLogEl.appendChild(node);
    this.outputLogEl.scrollTop = this.outputLogEl.scrollHeight;
  }

  _ansiColors(text) {
    return text
      .replace(/\x1B\[31m/g, '<span style="color:red">')
      .replace(/\x1B\[32m/g, '<span style="color:green">')
      .replace(/\x1B\[33m/g, '<span style="color:yellow">')
      .replace(/\x1B\[0m/g, '</span>');
  }

  // ---- Utility methods ----

  _toHex(v, d) {
    return v.toString(16).toUpperCase().padStart(d, '0');
  }

  // =======================================================================
  // Lifecycle
  // =======================================================================

  activate() {
    this.onActivate();
  }

  destroy() {
    this.emulator.destroy();
    // Additional cleanup...
  }
}

// ---------------------------------------------------------------------------
// PanelManager — manages all Panel instances
// ---------------------------------------------------------------------------

export class PanelManager {
  constructor() {
    /** @type {Panel[]} */
    this.panels = [];
    /** @type {Panel|null} */
    this.activePanel = null;
  }

  addPanel(panel) {
    this.panels.push(panel);
    if (!this.activePanel) this.activePanel = panel;
  }

  removePanel(panel) {
    const idx = this.panels.indexOf(panel);
    if (idx > -1) {
      panel.destroy();
      this.panels.splice(idx, 1);
    }
    if (this.activePanel === panel) {
      this.activePanel = this.panels[0] || null;
    }
  }

  getActivePanel() {
    return this.activePanel;
  }

  setActivePanel(panel) {
    this.activePanel = panel;
    panel.activate();
  }
}

// Global singleton PanelManager
export const panelManager = new PanelManager();