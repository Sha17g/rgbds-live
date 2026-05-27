import * as storage from './storage.js';

import createRgbAsm from '../rgbds/rgbasm';
import createRgbLink from '../rgbds/rgblink';
import createRgbFix from '../rgbds/rgbfix';

// ---------------------------------------------------------------------------
// 正则表达式：解析编译错误/警告中的文件名和行号
// 例如 "main.asm(42): error: ..." 中提取 main.asm 和 42
// ---------------------------------------------------------------------------
const LINE_NR_REGEX = /([\w\.]+)[\w\.\:~]*\(([0-9]+)\)/gi;

// ---------------------------------------------------------------------------
// 解析 map 文件用的正则（提取符号地址、段信息、空闲空间）
// ---------------------------------------------------------------------------
const SYM_RE = /^\s*\$([0-9a-f]+) = ([\w\.]+)/;
const SECTION_TYPE_BANK_RE = /^\s*(\w+) bank #(\d+)/;
const SECTION_RE = /^\s*SECTION: \$([0-9a-f]+)-\$([0-9a-f]+)/;
const SLACK_RE = /^\s*SLACK: \$([0-9a-f]+) bytes/;
const SEC_PREFIX = '__SEC_';
const EMU_START_NAMES = ['emustart', 'emuStart', 'emu_start'];

export class Compiler {
  // -----------------------------------------------------------------------
  // 实例属性 — 每个 Compiler 实例独立持有
  // -----------------------------------------------------------------------

  /** @type {import('./storage.js').Storage} 关联的文件仓库 */
  storage;

  /** @type {boolean} 是否正在编译中（防重入） */
  busy = false;

  /** @type {boolean} 编译期间又有新请求，标记需要重新编译 */
  repeat = false;

  /** @type {number|undefined} 延迟编译的定时器 id */
  startDelayTimer;

  /** @type {Function|null} 编译完成回调 */
  doneCallback = null;

  /** @type {Function|null} 日志回调（用于输出到 UI 面板） */
  logCallback = null;

  /** @type {Array<[string, string, number, string]>} 错误列表 [type, filename, line, message] */
  errorList = [];

  /** @type {Array} ROM 地址空间的符号表（稀疏数组） */
  romSymbols = [];

  /** @type {Array} RAM 地址空间的符号表（稀疏数组） */
  ramSymbols = [];

  /** @type {string[]} rgbasm 额外选项 */
  asmOptions = [];

  /** @type {string[]} rgblink 额外选项 */
  linkOptions = [];

  /** @type {string[]} rgbfix 额外选项 */
  fixOptions = [];

  // -----------------------------------------------------------------------
  // 构造函数
  // -----------------------------------------------------------------------

  /**
   * @param {object} [opts]
   * @param {import('./storage.js').Storage} [opts.storage] 关联的 Storage 实例，默认全局单例
   */
  constructor(opts = {}) {
    this.storage = opts.storage || storage.getInstance();
  }

  // -----------------------------------------------------------------------
  // 日志
  // -----------------------------------------------------------------------

  /**
   * 内部日志处理：通知外部回调，同时解析错误/警告行
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
  // 公开 API
  // -----------------------------------------------------------------------

  setLogCallback(callback) { this.logCallback = callback; }
  getErrors()             { return this.errorList; }
  getRomSymbols()         { return this.romSymbols; }
  getRamSymbols()         { return this.ramSymbols; }
  setAsmOptions(options)  { this.asmOptions = options; }
  setLinkOptions(options) { this.linkOptions = options; }
  setFixOptions(options)  { this.fixOptions = options; }

  /**
   * 触发编译
   * @param {Function} callback  编译完成回调 (rom, startAddress, addrToLine)
   * @param {string}   [entryAsm] 指定入口 .asm 文件名；不传则编译所有 .asm
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
  // 编译流程（私有方法）
  // -----------------------------------------------------------------------

  /** 延迟触发（500ms 防抖） */
  trigger(entryAsm) {
    if (typeof this.startDelayTimer !== 'undefined') clearTimeout(this.startDelayTimer);
    this.startDelayTimer = setTimeout(() => this.startCompile(entryAsm), 500);
  }

  /** 开始编译：收集 .asm 目标文件 */
  startCompile(entryAsm) {
    if (this.logCallback) this.logCallback(null, null);
    this.errorList = [];
    this.romSymbols = [];
    this.ramSymbols = [];

    const files = this.storage.getFiles();
    let targets = [];

    if (entryAsm) {
      // 多面板模式：只编译指定的入口 .asm + 其 include 依赖
      // rgbasm 会自动处理 INCLUDE 指令，所以只需要传入口文件
      // 但 WASM 的虚拟文件系统需要包含所有可能被 include 的文件
      targets = [entryAsm];
    } else {
      // 兼容模式：编译所有 .asm
      for (const name of Object.keys(files)) {
        if (name.endsWith('.asm')) targets.push(name);
      }
    }

    this.runRgbAsm(targets, {});
  }

  /** 依次汇编每个 .asm 文件 */
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

  /** 链接所有 .o 文件 */
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

  /** 修复 ROM 头 */
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

  /** 编译失败 */
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

  /** 编译成功：解析 map 文件，提取符号和地址映射 */
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
            // __SEC_<lineHex>_<filename> — 行号到地址的映射
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
// 向后兼容：模块级导出（代理到默认单例）
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
