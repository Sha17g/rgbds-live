import * as storage from './storage.js';

import createRgbAsm from '../rgbds/rgbasm';
import createRgbLink from '../rgbds/rgblink';
import createRgbFix from '../rgbds/rgbfix';

// ---------------------------------------------------------------------------
// Regex: Parse file name and line number from compiler error/warning messages.
// E.g. extract "main.asm" and 42 from "main.asm(42): error: ..."
// ---------------------------------------------------------------------------
const LINE_NR_REGEX = /([\w\.]+)[\w\.\:~]*\(([0-9]+)\)/gi;

// ---------------------------------------------------------------------------
// Regex patterns for parsing map files (symbol addresses, sections, slack space)
// ---------------------------------------------------------------------------
const SYM_RE = /^\s*\$([0-9a-f]+) = ([\w\.]+)/;
const SECTION_TYPE_BANK_RE = /^\s*(\w+) bank #(\d+)/;
const SECTION_RE = /^\s*SECTION: \$([0-9a-f]+)-\$([0-9a-f]+)/;
const SLACK_RE = /^\s*SLACK: \$([0-9a-f]+) bytes/;
const SEC_PREFIX = '__SEC_';
const EMU_START_NAMES = ['emustart', 'emuStart', 'emu_start'];

/**
 * Compiler class — wraps the RGBDS toolchain (rgbasm, rgblink, rgbfix).
 * Each Panel owns its own Compiler instance for full isolation.
 */
export class Compiler {
  // -----------------------------------------------------------------------
  // Instance properties — each Compiler instance holds its own state
  // -----------------------------------------------------------------------

  /** @type {import('./storage.js').Storage} Associated file storage */
  storage;

  /** @type {boolean} Whether compilation is in progress (prevents re-entry) */
  busy = false;

  /** @type {boolean} A new compilation was requested while busy; will recompile */
  repeat = false;

  /** @type {number|undefined} Timer ID for delayed compilation (debounce) */
  startDelayTimer;

  /** @type {Function|null} Callback invoked when compilation completes */
  doneCallback = null;

  /** @type {Function|null} Log callback for UI output panel */
  logCallback = null;

  /** @type {Array<[string, string, number, string]>} Error list [type, filename, line, message] */
  errorList = [];

  /** @type {Array} Symbol table for ROM address space (sparse array) */
  romSymbols = [];

  /** @type {Array} Symbol table for RAM address space (sparse array) */
  ramSymbols = [];

  /** @type {string[]} Additional rgbasm options */
  asmOptions = [];

  /** @type {string[]} Additional rgblink options */
  linkOptions = [];

  /** @type {string[]} Additional rgbfix options */
  fixOptions = [];

  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------

  /**
   * @param {object} [opts]
   * @param {import('./storage.js').Storage} [opts.storage] Associated Storage instance; defaults to global singleton
   */
  constructor(opts = {}) {
    this.storage = opts.storage || storage.getInstance();
  }

  // -----------------------------------------------------------------------
  // Logging
  // -----------------------------------------------------------------------

  /**
   * Internal log handler: notifies external callback and parses error/warning lines.
   */
  logFunction(str, kind) {
    if (this.logCallback) this.logCallback(str, kind);

    if (kind === 'stderr' && (str.startsWith('error: ') || str.startsWith('ERROR: ') || str.startsWith('warning: '))) {
      let type = 'error';
      if (str.startsWith('warning: ')) type = 'warning';

      for (const m of str.matchAll(LINE_NR_REGEX)) {
        this.errorList.push([type, m[1], parseInt(m[2]), str]);
      }
    }
  }

  infoFunction(str) { this.logFunction(str, 'info'); }
  outFunction(str)  { this.logFunction(str, 'stdout'); }
  errFunction(str)  { this.logFunction(str, 'stderr'); }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  setLogCallback(callback) { this.logCallback = callback; }
  getErrors()             { return this.errorList; }
  getRomSymbols()         { return this.romSymbols; }
  getRamSymbols()         { return this.ramSymbols; }
  setAsmOptions(options)  { this.asmOptions = options; }
  setLinkOptions(options) { this.linkOptions = options; }
  setFixOptions(options)  { this.fixOptions = options; }

  /**
   * Trigger compilation.
   * @param {Function} callback  Completion callback (rom, startAddress, addrToLine)
   * @param {string}   [entryAsm] Specific entry .asm file; if omitted, compiles all .asm files
   */
  compile(callback, entryAsm) {
    this.doneCallback = callback;
    if (this.busy) {
      this.repeat = true;
    } else {
      this.busy = true;
      this.trigger(entryAsm);
    }
  }

  // -----------------------------------------------------------------------
  // Compilation pipeline (private methods)
  // -----------------------------------------------------------------------

  /** Delayed trigger with 500ms debounce */
  trigger(entryAsm) {
    if (typeof this.startDelayTimer !== 'undefined') clearTimeout(this.startDelayTimer);
    this.startDelayTimer = setTimeout(() => this.startCompile(entryAsm), 500);
  }

  /** Start compilation: collect .asm target files */
  startCompile(entryAsm) {
    if (this.logCallback) this.logCallback(null, null);
    this.errorList = [];
    this.romSymbols = [];
    this.ramSymbols = [];

    const files = this.storage.getFiles();
    let targets = [];

    if (entryAsm) {
      // Multi-panel mode: only compile the specified entry .asm + its include deps.
      // rgbasm will handle INCLUDE directives automatically, so only the entry file
      // is needed, but the WASM virtual filesystem must contain all includable files.
      targets = [entryAsm];
    } else {
      // Legacy mode: compile all .asm files
      for (const name of Object.keys(files)) {
        if (name.endsWith('.asm')) targets.push(name);
      }
    }

    this.runRgbAsm(targets, {});
  }

  /** Assemble each .asm file one by one (Step 1: RGBASM) */
  runRgbAsm(targets, objFiles) {
    const target = targets.pop();
    const args = ['-Wall', ...this.asmOptions, '--color', 'never', '-o', 'output.o', '--', target];
    this.infoFunction('Running: rgbasm ' + args.join(' '));

    createRgbAsm({
      arguments: args,
      preRun: (m) => {
        const FS = m.FS;
        for (const [key, value] of Object.entries(this.storage.getFiles())) {
          FS.writeFile(key, value);
        }
      },
      print: (s) => this.outFunction(s),
      printErr: (s) => this.errFunction(s),
    }).then((m) => {
      if (this.repeat) {
        this.buildFailed();
        return;
      }
      try {
        objFiles[target] = m.FS.readFile('output.o');
      } catch {
        this.buildFailed();
        return;
      }
      if (targets.length > 0) this.runRgbAsm(targets, objFiles);
      else this.runRgbLink(objFiles);
    });
  }

  /** Link all .o files (Step 2: RGBLINK) */
  runRgbLink(objFiles) {
    const args = ['--color', 'never', '-o', 'output.gb', ...this.linkOptions, '-m', 'output.map', '--'];
    for (const name in objFiles) {
      args.push(name + '.o');
    }
    this.infoFunction('Running: rgblink ' + args.join(' '));

    createRgbLink({
      arguments: args,
      preRun: (m) => {
        const FS = m.FS;
        for (const name in objFiles) FS.writeFile(name + '.o', objFiles[name]);
      },
      print: (s) => this.outFunction(s),
      printErr: (s) => this.errFunction(s),
    }).then((m) => {
      if (this.repeat) {
        this.buildFailed();
        return;
      }
      try {
        var romFile = m.FS.readFile('output.gb');
      } catch {
        this.buildFailed();
        return;
      }
      try {
        var mapFile = m.FS.readFile('output.map', { encoding: 'utf8' });
      } catch {
        this.buildFailed();
        return;
      }
      this.runRgbFix(romFile, mapFile);
    });
  }

  /** Fix ROM header (Step 3: RGBFIX) */
  runRgbFix(inputRom, mapFile) {
    const args = ['--color', 'never', '-p', '0xff', '-v', ...this.fixOptions, '--', 'output.gb'];
    this.infoFunction('Running: rgbfix ' + args.join(' '));

    createRgbFix({
      arguments: args,
      preRun: (m) => { m.FS.writeFile('output.gb', inputRom); },
      print: (s) => this.outFunction(s),
      printErr: (s) => this.errFunction(s),
    }).then((m) => {
      try {
        var romFile = m.FS.readFile('output.gb');
      } catch {
        this.buildFailed();
        return;
      }
      this.buildDone(romFile, mapFile);
    });
  }

  /** Handle build failure: reset state and optionally retry */
  buildFailed() {
    this.infoFunction('Build failed');
    if (this.repeat) {
      this.repeat = false;
      this.trigger();
    } else {
      this.busy = false;
      this.doneCallback();
    }
  }

  /** Handle build success: parse map file, extract symbols and address-to-line mappings */
  buildDone(romFile, mapFile) {
    if (this.repeat) {
      this.repeat = false;
      this.trigger();
    } else {
      this.busy = false;

      let startAddress = 0x100;
      const addrToLine = {};
      let sectionType = '';
      let bankNr = 0;

      for (const line of mapFile.split('\n')) {
        let m;

        if ((m = SYM_RE.exec(line))) {
          let addr = parseInt(m[1], 16);
          let sym = m[2];

          if (sym.startsWith(SEC_PREFIX)) {
            // __SEC_<lineHex>_<filename> — maps address to source line
            sym = sym.substr(6);
            const file = sym.substr(sym.indexOf('_') + 1).substr(sym.substr(sym.indexOf('_') + 1).indexOf('_') + 1);
            const lineNr = parseInt(sym.split('_')[1], 16);
            addr = (addr & 0x3fff) | (bankNr << 14);
            addrToLine[addr] = [file, lineNr];
          } else if (EMU_START_NAMES.includes(sym)) {
            startAddress = addr;
          } else if (addr < 0x8000) {
            addr = (addr & 0x3fff) | (bankNr << 14);
            this.romSymbols[addr] = sym;
          } else {
            this.ramSymbols[addr] = sym;
          }
        } else if ((m = SECTION_RE.exec(line))) {
          let startAddr = parseInt(m[1], 16);
          let endAddr = parseInt(m[2], 16) + 1;
          if (startAddr < 0x8000) {
            startAddr = (startAddr & 0x3fff) | (bankNr << 14);
            endAddr = (endAddr & 0x3fff) | (bankNr << 14);
            this.romSymbols[startAddr] = null;
            this.romSymbols[endAddr] = null;
          } else {
            this.ramSymbols[startAddr] = null;
            this.ramSymbols[endAddr] = null;
          }
        } else if ((m = SECTION_TYPE_BANK_RE.exec(line))) {
          sectionType = m[1];
          bankNr = parseInt(m[2]);
        } else if ((m = SLACK_RE.exec(line))) {
          const space = parseInt(m[1], 16);
          let total = 0x4000;
          if (sectionType.startsWith('WRAM')) total = 0x1000;
          else if (sectionType.startsWith('HRAM')) total = 127;
          this.infoFunction(
            'Space left: ' + sectionType + '[' + bankNr + ']: ' + space +
            '  (' + ((space / total) * 100).toFixed(1) + '%)'
          );
        }
      }

      this.infoFunction('Build done');
      this.doneCallback(romFile, startAddress, addrToLine);
    }
  }
}

// ---------------------------------------------------------------------------
// Backward compatibility: Module-level exports (proxying to default singleton)
// ---------------------------------------------------------------------------

const defaultInstance = new Compiler();
let _defaultInstance = null;

function _inst() { return _defaultInstance || defaultInstance; }

export function setDefaultInstance(inst) { _defaultInstance = inst; }

export const setLogCallback  = (cb)    => _inst().setLogCallback(cb);
export const compile         = (cb, ea) => _inst().compile(cb, ea);
export const getErrors       = ()      => _inst().getErrors();
export const getRomSymbols   = ()      => _inst().getRomSymbols();
export const getRamSymbols   = ()      => _inst().getRamSymbols();
export const setAsmOptions   = (o)     => _inst().setAsmOptions(o);
export const setLinkOptions  = (o)     => _inst().setLinkOptions(o);
export const setFixOptions   = (o)     => _inst().setFixOptions(o);
export const getInstance     = ()      => _inst();