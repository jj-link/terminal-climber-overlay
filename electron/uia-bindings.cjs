'use strict';

// This module is intentionally loaded only by terminal-uia-worker.cjs. It is the
// sole native boundary for terminal inspection; callers must never log values
// returned by getText().
const koffi = require('koffi');
const path = require('node:path');

const HRESULT = Object.freeze({
  E_ACCESSDENIED: 0x80070005 | 0,
  RPC_E_CHANGED_MODE: 0x80010106 | 0,
  RPC_E_CALL_REJECTED: 0x80010001 | 0,
  RPC_E_SERVERFAULT: 0x80010105 | 0,
  RPC_E_DISCONNECTED: 0x80010108 | 0,
  UIA_E_ELEMENTNOTAVAILABLE: 0x80040201 | 0,
  UIA_E_NOTSUPPORTED: 0x80040204 | 0,
  UIA_E_TIMEOUT: 0x80131505 | 0,
});

const CONSTANTS = Object.freeze({
  COINIT_MULTITHREADED: 0,
  CLSCTX_INPROC_SERVER: 1,
  PROCESS_QUERY_LIMITED_INFORMATION: 0x1000,
  UIA_TextPatternId: 10014,
  UIA_IsTextPatternAvailablePropertyId: 30040,
  TextUnit_Line: 3,
  TextPatternRangeEndpoint_Start: 0,
  TextPatternRangeEndpoint_End: 1,
});

// Official UIAutomationClient.idl order. Unused entries are retained so no
// called slot is inferred from a compact list of methods.
const VTABLES = Object.freeze({
  IUIAutomation: Object.freeze([
    'QueryInterface', 'AddRef', 'Release',
    'CompareElements', 'CompareRuntimeIds', 'GetRootElement',
    'ElementFromHandle', 'ElementFromPoint', 'GetFocusedElement',
    'GetRootElementBuildCache', 'ElementFromHandleBuildCache',
    'ElementFromPointBuildCache', 'GetFocusedElementBuildCache',
    'CreateTreeWalker', 'get_ControlViewWalker', 'get_ContentViewWalker',
    'get_RawViewWalker',
  ]),
  IUIAutomationElement: Object.freeze([
    'QueryInterface', 'AddRef', 'Release', 'SetFocus', 'GetRuntimeId',
    'FindFirst', 'FindAll', 'FindFirstBuildCache', 'FindAllBuildCache',
    'BuildUpdatedCache', 'GetCurrentPropertyValue',
    'GetCurrentPropertyValueEx', 'GetCachedPropertyValue',
    'GetCachedPropertyValueEx', 'GetCurrentPatternAs',
  ]),
  IUIAutomationTreeWalker: Object.freeze([
    'QueryInterface', 'AddRef', 'Release', 'GetParentElement',
    'GetFirstChildElement', 'GetLastChildElement', 'GetNextSiblingElement',
    'GetPreviousSiblingElement', 'NormalizeElement',
    'GetParentElementBuildCache', 'GetFirstChildElementBuildCache',
    'GetLastChildElementBuildCache', 'GetNextSiblingElementBuildCache',
    'GetPreviousSiblingElementBuildCache', 'NormalizeElementBuildCache',
    'get_Condition',
  ]),
  IUIAutomationTextPattern: Object.freeze([
    'QueryInterface', 'AddRef', 'Release', 'RangeFromPoint',
    'RangeFromChild', 'GetSelection', 'GetVisibleRanges',
    'get_DocumentRange', 'get_SupportedTextSelection',
  ]),
  IUIAutomationTextRangeArray: Object.freeze([
    'QueryInterface', 'AddRef', 'Release', 'get_Length', 'GetElement',
  ]),
  IUIAutomationTextRange: Object.freeze([
    'QueryInterface', 'AddRef', 'Release', 'Clone', 'Compare',
    'CompareEndpoints', 'ExpandToEnclosingUnit', 'FindAttribute', 'FindText',
    'GetAttributeValue', 'GetBoundingRectangles', 'GetEnclosingElement',
    'GetText', 'Move', 'MoveEndpointByUnit', 'MoveEndpointByRange', 'Select',
    'AddToSelection', 'RemoveFromSelection', 'ScrollIntoView', 'GetChildren',
  ]),
});

function guid(text) {
  const normalized = text.replace(/[{}-]/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(normalized)) throw new TypeError('Invalid GUID');
  return {
    Data1: Number.parseInt(normalized.slice(0, 8), 16),
    Data2: Number.parseInt(normalized.slice(8, 12), 16),
    Data3: Number.parseInt(normalized.slice(12, 16), 16),
    Data4: Array.from({ length: 8 }, (_, index) =>
      Number.parseInt(normalized.slice(16 + index * 2, 18 + index * 2), 16)),
  };
}

const GUIDS = Object.freeze({
  CLSID_CUIAutomation: Object.freeze(guid('FF48DBA4-60EF-4201-AA87-54103EEF594E')),
  IID_IUIAutomation: Object.freeze(guid('30CBE57D-D9D0-452A-AB13-7AC5AC4825EE')),
  IID_IUIAutomationElement: Object.freeze(guid('D22108AA-8AC5-49A5-837B-37BBB3D7591E')),
  IID_IUIAutomationTextPattern: Object.freeze(guid('32EBA289-3583-42C9-9C59-3B6D9A1E9B6A')),
  IID_IUIAutomationTextRange: Object.freeze(guid('A543CC6A-F4AE-494B-8239-C814481187A8')),
  IID_IUIAutomationTextRangeArray: Object.freeze(guid('CE4AE76A-E717-4C98-81EA-47371D028EB6')),
});

class UIAError extends Error {
  constructor(operation, hresult, kind = classifyHresult(hresult)) {
    super(`${operation} failed (${formatHresult(hresult)})`);
    this.name = 'UIAError';
    this.operation = operation;
    this.hresult = hresult | 0;
    this.kind = kind;
  }
}

function formatHresult(value) {
  return `0x${(value >>> 0).toString(16).padStart(8, '0')}`;
}

function classifyHresult(value) {
  const hr = value | 0;
  if (hr === HRESULT.E_ACCESSDENIED) return 'access-denied';
  if (hr === HRESULT.UIA_E_NOTSUPPORTED) return 'not-supported';
  if (hr === HRESULT.UIA_E_ELEMENTNOTAVAILABLE || hr === HRESULT.UIA_E_TIMEOUT ||
      hr === HRESULT.RPC_E_CALL_REJECTED || hr === HRESULT.RPC_E_SERVERFAULT ||
      hr === HRESULT.RPC_E_DISCONNECTED) return 'transient';
  return 'failure';
}

function checkHresult(operation, value, allowed = null) {
  const hr = value | 0;
  if (hr < 0 && !(allowed && allowed.has(hr))) throw new UIAError(operation, hr);
  return hr;
}

function isNullPointer(pointer) {
  return pointer == null || koffi.address(pointer) === 0n;
}

function unionRectangles(rectangles) {
  const valid = rectangles.filter((rect) =>
    Number.isFinite(rect.x) && Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) && Number.isFinite(rect.height) &&
    rect.width > 0 && rect.height > 0);
  if (valid.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const rect of valid) {
    left = Math.min(left, rect.x);
    top = Math.min(top, rect.y);
    right = Math.max(right, rect.x + rect.width);
    bottom = Math.max(bottom, rect.y + rect.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

class UIAutomationBindings {
  constructor() {
    if (process.platform !== 'win32') throw new Error('Windows UI Automation requires Windows');

    this.GUID = koffi.struct('TC_GUID', {
      Data1: 'uint32_t',
      Data2: 'uint16_t',
      Data3: 'uint16_t',
      Data4: koffi.array('uint8_t', 8),
    });
    this.POINTER_SIZE = koffi.sizeof('void *');

    this.user32 = koffi.load('user32.dll');
    this.kernel32 = koffi.load('kernel32.dll');
    this.ole32 = koffi.load('ole32.dll');
    this.oleaut32 = koffi.load('oleaut32.dll');

    this.native = Object.freeze({
      GetForegroundWindow: this.user32.func('void * __stdcall GetForegroundWindow(void)'),
      GetWindowThreadProcessId: this.user32.func(
        'uint32_t __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *processId)'),
      OpenProcess: this.kernel32.func(
        'void * __stdcall OpenProcess(uint32_t desiredAccess, int inheritHandle, uint32_t processId)'),
      QueryFullProcessImageNameW: this.kernel32.func(
        'int __stdcall QueryFullProcessImageNameW(void *process, uint32_t flags, _Out_ char16_t *name, _Inout_ uint32_t *size)'),
      CloseHandle: this.kernel32.func('int __stdcall CloseHandle(void *handle)'),
      GetLastError: this.kernel32.func('uint32_t __stdcall GetLastError(void)'),
      CoInitializeEx: this.ole32.func(
        'int32_t __stdcall CoInitializeEx(void *reserved, uint32_t coInit)'),
      CoUninitialize: this.ole32.func('void __stdcall CoUninitialize(void)'),
      CoCreateInstance: this.ole32.func(
        'int32_t __stdcall CoCreateInstance(const TC_GUID *classId, void *outer, uint32_t context, const TC_GUID *interfaceId, _Out_ void **object)'),
      SysAllocStringLen: this.oleaut32.func(
        'void * __stdcall SysAllocStringLen(const char16_t *source, uint32_t length)'),
      SysStringLen: this.oleaut32.func('uint32_t __stdcall SysStringLen(void *bstr)'),
      SysFreeString: this.oleaut32.func('void __stdcall SysFreeString(void *bstr)'),
      SafeArrayGetDim: this.oleaut32.func('uint32_t __stdcall SafeArrayGetDim(void *array)'),
      SafeArrayGetLBound: this.oleaut32.func(
        'int32_t __stdcall SafeArrayGetLBound(void *array, uint32_t dimension, _Out_ int32_t *bound)'),
      SafeArrayGetUBound: this.oleaut32.func(
        'int32_t __stdcall SafeArrayGetUBound(void *array, uint32_t dimension, _Out_ int32_t *bound)'),
      SafeArrayAccessData: this.oleaut32.func(
        'int32_t __stdcall SafeArrayAccessData(void *array, _Out_ void **data)'),
      SafeArrayUnaccessData: this.oleaut32.func(
        'int32_t __stdcall SafeArrayUnaccessData(void *array)'),
      SafeArrayDestroy: this.oleaut32.func('int32_t __stdcall SafeArrayDestroy(void *array)'),
    });

    this.proto = Object.freeze({
      release: koffi.proto('uint32_t __stdcall TC_Release(void *self)'),
      onePointerOut: koffi.proto('int32_t __stdcall TC_OnePointerOut(void *self, _Out_ void **out)'),
      elementFromHandle: koffi.proto(
        'int32_t __stdcall TC_ElementFromHandle(void *self, void *hwnd, _Out_ void **element)'),
      compareElements: koffi.proto(
        'int32_t __stdcall TC_CompareElements(void *self, void *left, void *right, _Out_ int *same)'),
      elementPatternAs: koffi.proto(
        'int32_t __stdcall TC_GetCurrentPatternAs(void *self, int patternId, const TC_GUID *interfaceId, _Out_ void **pattern)'),
      walkerElement: koffi.proto(
        'int32_t __stdcall TC_WalkerElement(void *self, void *element, _Out_ void **result)'),
      arrayLength: koffi.proto(
        'int32_t __stdcall TC_ArrayLength(void *self, _Out_ int *length)'),
      arrayElement: koffi.proto(
        'int32_t __stdcall TC_ArrayElement(void *self, int index, _Out_ void **element)'),
      compareEndpoints: koffi.proto(
        'int32_t __stdcall TC_CompareEndpoints(void *self, int sourceEndpoint, void *range, int targetEndpoint, _Out_ int *comparison)'),
      expand: koffi.proto(
        'int32_t __stdcall TC_Expand(void *self, int textUnit)'),
      findText: koffi.proto(
        'int32_t __stdcall TC_FindText(void *self, void *text, int backward, int ignoreCase, _Out_ void **found)'),
      getText: koffi.proto(
        'int32_t __stdcall TC_GetText(void *self, int maxLength, _Out_ void **text)'),
      move: koffi.proto(
        'int32_t __stdcall TC_Move(void *self, int unit, int count, _Out_ int *moved)'),
      moveEndpointByRange: koffi.proto(
        'int32_t __stdcall TC_MoveEndpointByRange(void *self, int sourceEndpoint, void *range, int targetEndpoint)'),
    });

    this.automation = null;
    this.comInitialized = false;
  }

  initialize() {
    if (this.automation) return;
    const initResult = this.native.CoInitializeEx(null, CONSTANTS.COINIT_MULTITHREADED);
    checkHresult('CoInitializeEx', initResult);
    this.comInitialized = true;
    try {
      const out = [null];
      checkHresult('CoCreateInstance', this.native.CoCreateInstance(
        GUIDS.CLSID_CUIAutomation,
        null,
        CONSTANTS.CLSCTX_INPROC_SERVER,
        GUIDS.IID_IUIAutomation,
        out,
      ));
      if (isNullPointer(out[0])) throw new UIAError('CoCreateInstance', 0x80004005 | 0);
      this.automation = out[0];
    } catch (error) {
      this.native.CoUninitialize();
      this.comInitialized = false;
      throw error;
    }
  }

  dispose() {
    if (this.automation) {
      this.release(this.automation);
      this.automation = null;
    }
    if (this.comInitialized) {
      this.native.CoUninitialize();
      this.comInitialized = false;
    }
  }

  method(interfaceName, methodName, prototype) {
    const table = VTABLES[interfaceName];
    const slot = table?.indexOf(methodName) ?? -1;
    if (slot < 0) throw new Error(`Unknown ${interfaceName}.${methodName}`);
    return (object, ...args) => {
      if (isNullPointer(object)) throw new UIAError(methodName, 0x80004003 | 0);
      const vtable = koffi.decode(object, 'void *');
      const pointer = koffi.decode(vtable, slot * this.POINTER_SIZE, 'void *');
      if (isNullPointer(pointer)) throw new UIAError(methodName, 0x80004003 | 0);
      return koffi.call(pointer, prototype, object, ...args);
    };
  }

  invoke(interfaceName, methodName, prototype, object, ...args) {
    return this.method(interfaceName, methodName, prototype)(object, ...args);
  }

  release(object) {
    if (isNullPointer(object)) return;
    try {
      this.invoke('IUIAutomationElement', 'Release', this.proto.release, object);
    } catch {
      // Release is best effort only after a provider has invalidated a proxy.
    }
  }

  getForegroundWindow() {
    const hwnd = this.native.GetForegroundWindow();
    return isNullPointer(hwnd) ? null : hwnd;
  }

  hwndHex(hwnd) {
    return koffi.address(hwnd).toString(16);
  }

  getWindowProcessId(hwnd) {
    const processId = [0];
    if (this.native.GetWindowThreadProcessId(hwnd, processId) === 0 || processId[0] === 0) {
      throw new UIAError('GetWindowThreadProcessId', 0x80004005 | 0, 'transient');
    }
    return processId[0] >>> 0;
  }

  getProcessImageName(processId) {
    const processHandle = this.native.OpenProcess(
      CONSTANTS.PROCESS_QUERY_LIMITED_INFORMATION, 0, processId);
    if (isNullPointer(processHandle)) {
      const error = this.native.GetLastError();
      if (error === 5) throw new UIAError('OpenProcess', HRESULT.E_ACCESSDENIED);
      throw new UIAError('OpenProcess', 0x80004005 | 0, 'transient');
    }
    try {
      const capacity = 32768;
      const buffer = Buffer.alloc(capacity * 2);
      const size = [capacity];
      if (!this.native.QueryFullProcessImageNameW(processHandle, 0, buffer, size)) {
        const error = this.native.GetLastError();
        if (error === 5) throw new UIAError('QueryFullProcessImageNameW', HRESULT.E_ACCESSDENIED);
        throw new UIAError('QueryFullProcessImageNameW', 0x80004005 | 0, 'transient');
      }
      return path.win32.basename(buffer.toString('utf16le', 0, size[0] * 2));
    } finally {
      this.native.CloseHandle(processHandle);
    }
  }

  elementFromHandle(hwnd) {
    const out = [null];
    checkHresult('ElementFromHandle', this.invoke(
      'IUIAutomation', 'ElementFromHandle', this.proto.elementFromHandle,
      this.automation, hwnd, out));
    return isNullPointer(out[0]) ? null : out[0];
  }

  getFocusedElement() {
    const out = [null];
    checkHresult('GetFocusedElement', this.invoke(
      'IUIAutomation', 'GetFocusedElement', this.proto.onePointerOut,
      this.automation, out));
    return isNullPointer(out[0]) ? null : out[0];
  }

  getRawViewWalker() {
    const out = [null];
    checkHresult('get_RawViewWalker', this.invoke(
      'IUIAutomation', 'get_RawViewWalker', this.proto.onePointerOut,
      this.automation, out));
    return isNullPointer(out[0]) ? null : out[0];
  }

  compareElements(left, right) {
    const same = [0];
    checkHresult('CompareElements', this.invoke(
      'IUIAutomation', 'CompareElements', this.proto.compareElements,
      this.automation, left, right, same));
    return same[0] !== 0;
  }

  walkerGet(walker, methodName, element) {
    const out = [null];
    checkHresult(methodName, this.invoke(
      'IUIAutomationTreeWalker', methodName, this.proto.walkerElement,
      walker, element, out));
    return isNullPointer(out[0]) ? null : out[0];
  }

  elementBelongsToRoot(element, root, walker) {
    let current = element;
    let ownsCurrent = false;
    try {
      for (let depth = 0; depth < 256 && current; depth += 1) {
        if (this.compareElements(current, root)) return true;
        const parent = this.walkerGet(walker, 'GetParentElement', current);
        if (ownsCurrent) this.release(current);
        current = parent;
        ownsCurrent = true;
      }
      return false;
    } finally {
      if (ownsCurrent && current) this.release(current);
    }
  }

  getTextPattern(element) {
    const out = [null];
    const result = this.invoke(
      'IUIAutomationElement', 'GetCurrentPatternAs', this.proto.elementPatternAs,
      element, CONSTANTS.UIA_TextPatternId, GUIDS.IID_IUIAutomationTextPattern, out);
    if ((result | 0) === HRESULT.UIA_E_NOTSUPPORTED) return null;
    checkHresult('GetCurrentPatternAs', result);
    return isNullPointer(out[0]) ? null : out[0];
  }

  getVisibleRanges(pattern) {
    const out = [null];
    checkHresult('GetVisibleRanges', this.invoke(
      'IUIAutomationTextPattern', 'GetVisibleRanges', this.proto.onePointerOut,
      pattern, out));
    return isNullPointer(out[0]) ? null : out[0];
  }

  rangeArrayLength(array) {
    const length = [0];
    checkHresult('IUIAutomationTextRangeArray.get_Length', this.invoke(
      'IUIAutomationTextRangeArray', 'get_Length', this.proto.arrayLength,
      array, length));
    return Math.max(0, length[0] | 0);
  }

  rangeArrayElement(array, index) {
    const out = [null];
    checkHresult('IUIAutomationTextRangeArray.GetElement', this.invoke(
      'IUIAutomationTextRangeArray', 'GetElement', this.proto.arrayElement,
      array, index, out));
    return isNullPointer(out[0]) ? null : out[0];
  }

  cloneRange(range) {
    const out = [null];
    checkHresult('IUIAutomationTextRange.Clone', this.invoke(
      'IUIAutomationTextRange', 'Clone', this.proto.onePointerOut, range, out));
    return isNullPointer(out[0]) ? null : out[0];
  }

  compareEndpoints(range, sourceEndpoint, otherRange, targetEndpoint) {
    const comparison = [0];
    checkHresult('IUIAutomationTextRange.CompareEndpoints', this.invoke(
      'IUIAutomationTextRange', 'CompareEndpoints', this.proto.compareEndpoints,
      range, sourceEndpoint, otherRange, targetEndpoint, comparison));
    return comparison[0] | 0;
  }

  expandToLine(range) {
    checkHresult('IUIAutomationTextRange.ExpandToEnclosingUnit', this.invoke(
      'IUIAutomationTextRange', 'ExpandToEnclosingUnit', this.proto.expand,
      range, CONSTANTS.TextUnit_Line));
  }

  moveLine(range) {
    const moved = [0];
    checkHresult('IUIAutomationTextRange.Move', this.invoke(
      'IUIAutomationTextRange', 'Move', this.proto.move,
      range, CONSTANTS.TextUnit_Line, 1, moved));
    return moved[0] | 0;
  }

  collapseEndToStart(range) {
    checkHresult('IUIAutomationTextRange.MoveEndpointByRange', this.invoke(
      'IUIAutomationTextRange', 'MoveEndpointByRange', this.proto.moveEndpointByRange,
      range,
      CONSTANTS.TextPatternRangeEndpoint_End,
      range,
      CONSTANTS.TextPatternRangeEndpoint_Start));
  }

  getText(range) {
    const out = [null];
    checkHresult('IUIAutomationTextRange.GetText', this.invoke(
      'IUIAutomationTextRange', 'GetText', this.proto.getText, range, -1, out));
    const bstr = out[0];
    if (isNullPointer(bstr)) return '';
    try {
      const length = this.native.SysStringLen(bstr);
      if (length === 0) return '';
      return koffi.decode(bstr, 'char16_t', length);
    } finally {
      this.native.SysFreeString(bstr);
    }
  }

  findText(range, text) {
    if (text.length === 0) return null;
    const bstr = this.native.SysAllocStringLen(text, text.length);
    if (isNullPointer(bstr)) throw new UIAError('SysAllocStringLen', 0x8007000e | 0);
    try {
      const out = [null];
      checkHresult('IUIAutomationTextRange.FindText', this.invoke(
        'IUIAutomationTextRange', 'FindText', this.proto.findText,
        range, bstr, 0, 0, out));
      return isNullPointer(out[0]) ? null : out[0];
    } finally {
      this.native.SysFreeString(bstr);
    }
  }

  getBoundingRectangles(range) {
    const out = [null];
    checkHresult('IUIAutomationTextRange.GetBoundingRectangles', this.invoke(
      'IUIAutomationTextRange', 'GetBoundingRectangles', this.proto.onePointerOut,
      range, out));
    const array = out[0];
    if (isNullPointer(array)) return [];
    let accessed = false;
    try {
      if (this.native.SafeArrayGetDim(array) !== 1) return [];
      const lower = [0];
      const upper = [-1];
      checkHresult('SafeArrayGetLBound', this.native.SafeArrayGetLBound(array, 1, lower));
      checkHresult('SafeArrayGetUBound', this.native.SafeArrayGetUBound(array, 1, upper));
      const count = upper[0] - lower[0] + 1;
      if (count <= 0) return [];
      const data = [null];
      checkHresult('SafeArrayAccessData', this.native.SafeArrayAccessData(array, data));
      accessed = true;
      if (isNullPointer(data[0])) return [];
      const values = koffi.decode(data[0], 'double', count);
      const rectangles = [];
      for (let index = 0; index + 3 < values.length; index += 4) {
        rectangles.push({
          x: values[index],
          y: values[index + 1],
          width: values[index + 2],
          height: values[index + 3],
        });
      }
      return rectangles;
    } finally {
      let cleanupError = null;
      if (accessed) {
        try {
          checkHresult('SafeArrayUnaccessData', this.native.SafeArrayUnaccessData(array));
        } catch (error) {
          cleanupError = error;
        }
      }
      try {
        checkHresult('SafeArrayDestroy', this.native.SafeArrayDestroy(array));
      } catch (error) {
        cleanupError ??= error;
      }
      if (cleanupError) throw cleanupError;
    }
  }

  probePattern(pattern) {
    let ranges = null;
    try {
      ranges = this.getVisibleRanges(pattern);
      if (!ranges) return null;
      const rectangles = [];
      const length = this.rangeArrayLength(ranges);
      for (let index = 0; index < length; index += 1) {
        let range = null;
        try {
          range = this.rangeArrayElement(ranges, index);
          if (range) rectangles.push(...this.getBoundingRectangles(range));
        } finally {
          if (range) this.release(range);
        }
      }
      const bounds = unionRectangles(rectangles);
      if (!bounds) return null;
      const validRectangleCount = rectangles.filter((rect) =>
        Number.isFinite(rect.x) && Number.isFinite(rect.y) &&
        Number.isFinite(rect.width) && Number.isFinite(rect.height) &&
        rect.width > 0 && rect.height > 0).length;
      const terminalScale =
        (validRectangleCount >= 3 && bounds.width >= 160 && bounds.height >= 40) ||
        (bounds.width >= 320 && bounds.height >= 120);
      return {
        bounds,
        validRectangleCount,
        terminalScale,
        score: bounds.width * bounds.height + validRectangleCount * 10000,
      };
    } finally {
      if (ranges) this.release(ranges);
    }
  }

  probeElement(element) {
    let pattern = null;
    try {
      pattern = this.getTextPattern(element);
      if (!pattern) return null;
      const metrics = this.probePattern(pattern);
      if (!metrics) {
        this.release(pattern);
        pattern = null;
        return null;
      }
      const result = { pattern, metrics };
      pattern = null;
      return result;
    } catch (error) {
      if (error instanceof UIAError && (error.kind === 'not-supported' || error.kind === 'transient')) {
        return null;
      }
      throw error;
    } finally {
      if (pattern) this.release(pattern);
    }
  }

  acquireTextPeer(hwnd) {
    let root = this.elementFromHandle(hwnd);
    if (!root) return null;
    let walker = null;
    let focused = null;
    const queue = [];
    let best = null;
    try {
      walker = this.getRawViewWalker();
      if (!walker) return null;

      try {
        focused = this.getFocusedElement();
        if (focused && this.elementBelongsToRoot(focused, root, walker)) {
          const focusedCandidate = this.probeElement(focused);
          if (focusedCandidate?.metrics.terminalScale) {
            const result = {
              element: focused,
              pattern: focusedCandidate.pattern,
              metrics: focusedCandidate.metrics,
            };
            focused = null;
            return result;
          }
          if (focusedCandidate) this.release(focusedCandidate.pattern);
        }
      } catch (error) {
        if (!(error instanceof UIAError) || error.kind === 'access-denied' || error.kind === 'failure') {
          throw error;
        }
      } finally {
        if (focused) {
          this.release(focused);
          focused = null;
        }
      }

      queue.push(root);
      root = null;
      let visited = 0;
      while (queue.length > 0 && visited < 4096) {
        const element = queue.shift();
        visited += 1;
        let retainElement = false;
        try {
          const candidate = this.probeElement(element);
          if (candidate) {
            if (candidate.metrics.terminalScale &&
                (!best || candidate.metrics.score > best.metrics.score)) {
              if (best) {
                this.release(best.pattern);
                this.release(best.element);
              }
              best = { element, pattern: candidate.pattern, metrics: candidate.metrics };
              retainElement = true;
            } else {
              this.release(candidate.pattern);
            }
          }

          let child = this.walkerGet(walker, 'GetFirstChildElement', element);
          while (child && queue.length + visited < 4096) {
            queue.push(child);
            child = this.walkerGet(walker, 'GetNextSiblingElement', child);
          }
          if (child) this.release(child);
        } catch (error) {
          if (!(error instanceof UIAError) || error.kind === 'access-denied' || error.kind === 'failure') {
            throw error;
          }
        } finally {
          if (!retainElement) this.release(element);
        }
      }
      for (const queued of queue) this.release(queued);
      queue.length = 0;
      const result = best;
      best = null;
      return result;
    } finally {
      for (const queued of queue) this.release(queued);
      if (best) {
        this.release(best.pattern);
        this.release(best.element);
      }
      if (focused) this.release(focused);
      if (walker) this.release(walker);
      if (root) this.release(root);
    }
  }
}

async function smokeBindings() {
  let bindings;
  try {
    bindings = new UIAutomationBindings();
    bindings.initialize();
    return { type: 'status', status: 'initializing', reason: 'bindings-ready' };
  } catch (error) {
    const status = error instanceof UIAError && error.kind === 'access-denied'
      ? 'elevated-terminal'
      : 'backend-error';
    return { type: 'status', status, reason: 'binding-initialization' };
  } finally {
    bindings?.dispose();
  }
}

module.exports = {
  CONSTANTS,
  GUIDS,
  HRESULT,
  UIAError,
  UIAutomationBindings,
  VTABLES,
  checkHresult,
  classifyHresult,
  smokeBindings,
  unionRectangles,
};

if (require.main === module) {
  smokeBindings().then((message) => process.stdout.write(`${JSON.stringify(message)}\n`));
}
