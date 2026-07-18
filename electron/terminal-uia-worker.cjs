'use strict';

const crypto = require('node:crypto');
const { isMainThread, parentPort } = require('node:worker_threads');
const {
  CONSTANTS,
  UIAError,
  UIAutomationBindings,
  unionRectangles,
} = require('./uia-bindings.cjs');

const POLL_INTERVAL_MS = 80;
const NULL_FOREGROUND_GRACE_MS = 160;
const ALLOWED_EXECUTABLES = new Set([
  'windowsterminal.exe',
  'openconsole.exe',
  'conhost.exe',
]);
const VALID_STATUSES = new Set([
  'initializing',
  'tracking',
  'no-terminal',
  'unsupported-terminal',
  'elevated-terminal',
  'backend-error',
  'paused',
]);

function finitePositiveRect(rect) {
  return Boolean(rect) &&
    Number.isFinite(rect.x) && Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) && Number.isFinite(rect.height) &&
    rect.width > 0 && rect.height > 0;
}

function sanitizeRect(rect) {
  if (!finitePositiveRect(rect)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function textRunGeometry(trimmedText, rect) {
  if (!trimmedText || !finitePositiveRect(rect)) return [];
  const runs = [];
  for (const match of trimmedText.matchAll(/\S+/gu)) {
    const start = match.index;
    const length = match[0].length;
    runs.push({
      start,
      length,
      rect: {
        x: rect.x + rect.width * (start / trimmedText.length),
        y: rect.y,
        width: rect.width * (length / trimmedText.length),
        height: rect.height,
      },
    });
  }
  return runs;
}

function statusForError(error) {
  if (error instanceof UIAError) {
    if (error.kind === 'access-denied') {
      return { type: 'status', status: 'elevated-terminal', reason: 'access-denied' };
    }
    if (error.kind === 'not-supported') {
      return { type: 'status', status: 'unsupported-terminal', reason: 'text-pattern-unavailable' };
    }
    if (error.kind === 'transient') {
      return { type: 'status', status: 'unsupported-terminal', reason: 'provider-unavailable' };
    }
  }
  return { type: 'status', status: 'backend-error', reason: 'uia-failure' };
}

function isStatusMessage(value) {
  return value && value.type === 'status' && VALID_STATUSES.has(value.status) &&
    (value.reason === undefined || typeof value.reason === 'string');
}

class TerminalUIAWorker {
  constructor(emit) {
    this.emit = emit;
    this.bindings = null;
    this.sessionKey = crypto.randomBytes(32);
    this.timer = null;
    this.polling = false;
    this.paused = false;
    this.disposed = false;
    this.lastStatusKey = '';
    this.lastTarget = null;
  }

  initialize() {
    if (this.bindings) return;
    this.bindings = new UIAutomationBindings();
    this.bindings.initialize();
  }

  start() {
    this.emitStatus('initializing');
    try {
      this.initialize();
    } catch (error) {
      const message = statusForError(error);
      this.emitStatus(message.status, message.reason);
      return;
    }
    this.pollOnce();
    this.timer = setInterval(() => this.pollOnce(), POLL_INTERVAL_MS);
  }

  setPaused(paused) {
    const next = Boolean(paused);
    if (next === this.paused) return;
    this.paused = next;
    if (next) {
      this.emitStatus('paused');
    } else {
      this.lastStatusKey = '';
      this.emitStatus('initializing');
      this.pollOnce();
    }
  }

  emitStatus(status, reason) {
    const message = reason === undefined
      ? { type: 'status', status }
      : { type: 'status', status, reason };
    if (!isStatusMessage(message)) return;
    const key = `${status}:${reason ?? ''}`;
    if (key === this.lastStatusKey) return;
    this.lastStatusKey = key;
    this.emit(message);
  }

  pollOnce() {
    if (this.polling || this.paused || this.disposed || !this.bindings) return;
    this.polling = true;
    try {
      const message = this.sampleForeground();
      if (message.type === 'status') {
        this.emitStatus(message.status, message.reason);
      } else {
        this.emitStatus('tracking');
        this.emit(message);
      }
    } catch (error) {
      const message = statusForError(error);
      this.emitStatus(message.status, message.reason);
    } finally {
      this.polling = false;
    }
  }

  resolveForeground() {
    const now = Date.now();
    let hwnd = this.bindings.getForegroundWindow();
    if (!hwnd) {
      if (this.lastTarget && now - this.lastTarget.seenAt <= NULL_FOREGROUND_GRACE_MS) {
        return this.lastTarget;
      }
      return null;
    }

    const processId = this.bindings.getWindowProcessId(hwnd);
    if (processId === process.pid) {
      if (this.lastTarget) return this.lastTarget;
      return null;
    }

    const executable = this.bindings.getProcessImageName(processId).toLowerCase();
    if (!ALLOWED_EXECUTABLES.has(executable)) {
      this.lastTarget = null;
      return { unsupportedProcess: true };
    }

    return { hwnd, processId, executable, seenAt: now };
  }

  sampleForeground() {
    const target = this.resolveForeground();
    if (!target) return { type: 'status', status: 'no-terminal', reason: 'no-foreground-terminal' };
    if (target.unsupportedProcess) {
      return { type: 'status', status: 'no-terminal', reason: 'foreground-not-terminal' };
    }

    let peer = null;
    try {
      peer = this.bindings.acquireTextPeer(target.hwnd);
      if (!peer) {
        if (this.lastTarget && this.lastTarget.hwnd === target.hwnd) this.lastTarget = null;
        return {
          type: 'status',
          status: 'unsupported-terminal',
          reason: 'text-pattern-geometry-unavailable',
        };
      }

      const enumerated = this.enumerateRows(peer.pattern);
      if (!enumerated.viewportRectPx || enumerated.rows.length === 0) {
        return {
          type: 'status',
          status: 'unsupported-terminal',
          reason: 'visible-row-geometry-unavailable',
        };
      }

      const targetId = `${target.processId}:${this.bindings.hwndHex(target.hwnd)}`;
      this.lastTarget = { ...target, seenAt: Date.now(), targetId };
      return {
        type: 'snapshot',
        targetId,
        sampledAt: Date.now(),
        viewportRectPx: enumerated.viewportRectPx,
        rows: enumerated.rows,
      };
    } finally {
      if (peer?.pattern) this.bindings.release(peer.pattern);
      if (peer?.element) this.bindings.release(peer.element);
    }
  }

  hashRow(completeRowText) {
    return crypto.createHmac('sha256', this.sessionKey)
      .update(completeRowText, 'utf8')
      .digest('hex')
      .slice(0, 16);
  }

  hashSegment(segmentText, segmentIndex) {
    return crypto.createHmac('sha256', this.sessionKey)
      .update(String(segmentIndex), 'utf8')
      .update('\0', 'utf8')
      .update(segmentText, 'utf8')
      .digest('hex')
      .slice(0, 16);
  }

  enumerateRows(pattern) {
    let rangeArray = null;
    const candidates = [];
    let ordinal = 0;
    try {
      rangeArray = this.bindings.getVisibleRanges(pattern);
      if (!rangeArray) return { rows: [], viewportRectPx: null };
      const rangeCount = this.bindings.rangeArrayLength(rangeArray);
      for (let rangeIndex = 0; rangeIndex < rangeCount; rangeIndex += 1) {
        let visibleRange = null;
        let cursor = null;
        let limit = null;
        try {
          visibleRange = this.bindings.rangeArrayElement(rangeArray, rangeIndex);
          if (!visibleRange) continue;
          cursor = this.bindings.cloneRange(visibleRange);
          limit = this.bindings.cloneRange(visibleRange);
          if (!cursor || !limit) continue;
          this.bindings.collapseEndToStart(cursor);
          this.bindings.expandToLine(cursor);

          for (let guard = 0; guard < 10000; guard += 1) {
            if (this.bindings.compareEndpoints(
              cursor,
              CONSTANTS.TextPatternRangeEndpoint_Start,
              limit,
              CONSTANTS.TextPatternRangeEndpoint_End,
            ) >= 0) break;

            this.captureRow(cursor, candidates, ordinal);
            ordinal += 1;
            if (this.bindings.moveLine(cursor) === 0) break;
          }
        } finally {
          if (limit) this.bindings.release(limit);
          if (cursor) this.bindings.release(cursor);
          if (visibleRange) this.bindings.release(visibleRange);
        }
      }
    } finally {
      if (rangeArray) this.bindings.release(rangeArray);
    }

    candidates.sort((left, right) => {
      const leftValid = finitePositiveRect(left.fullRect);
      const rightValid = finitePositiveRect(right.fullRect);
      if (leftValid !== rightValid) return leftValid ? -1 : 1;
      if (leftValid) {
        const vertical = left.fullRect.y - right.fullRect.y;
        if (Math.abs(vertical) > 0.5) return vertical;
        const horizontal = left.fullRect.x - right.fullRect.x;
        if (Math.abs(horizontal) > 0.5) return horizontal;
      }
      return left.ordinal - right.ordinal;
    });

    const viewportRectPx = unionRectangles(
      candidates.map((row) => row.fullRect).filter(Boolean),
    );
    const rows = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (candidate.segments.length === 0) {
        rows.push({
          index,
          segmentIndex: 0,
          signature: candidate.signature,
          attachable: false,
          rectPx: sanitizeRect(candidate.fullRect),
        });
        continue;
      }
      for (
        let segmentIndex = 0;
        segmentIndex < candidate.segments.length;
        segmentIndex += 1
      ) {
        const segment = candidate.segments[segmentIndex];
        rows.push({
          index,
          segmentIndex,
          signature: segment.signature,
          attachable: finitePositiveRect(segment.rect),
          rectPx: sanitizeRect(segment.rect),
        });
      }
    }
    return { rows, viewportRectPx };
  }

  captureRow(cursor, candidates, ordinal) {
    let completeRowText = null;
    let trimmedText = null;
    let segmentText = null;
    let trimmedRange = null;
    try {
      completeRowText = this.bindings.getText(cursor);
      const signature = this.hashRow(completeRowText);
      trimmedText = completeRowText.trim();
      let fullRect = null;
      let hasTrimmedGeometry = false;
      try {
        fullRect = unionRectangles(this.bindings.getBoundingRectangles(cursor));
      } catch (error) {
        if (!(error instanceof UIAError) ||
            (error.kind !== 'not-supported' && error.kind !== 'transient')) throw error;
      }
      let rect = fullRect;
      if (trimmedText.length > 0) {
        try {
          trimmedRange = this.bindings.findText(cursor, trimmedText);
          if (trimmedRange) {
            const trimmedRect = unionRectangles(
              this.bindings.getBoundingRectangles(trimmedRange),
            );
            if (trimmedRect) {
              rect = trimmedRect;
              hasTrimmedGeometry = true;
            }
          }
        } catch (error) {
          if (!(error instanceof UIAError) ||
              (error.kind !== 'not-supported' && error.kind !== 'transient')) throw error;
          rect = fullRect;
        }
      }
      const segments = [];
      if (trimmedText.length > 0 && finitePositiveRect(rect)) {
        const geometry = hasTrimmedGeometry
          ? textRunGeometry(trimmedText, rect)
          : [{ start: 0, length: trimmedText.length, rect }];
        for (let segmentIndex = 0; segmentIndex < geometry.length; segmentIndex += 1) {
          const run = geometry[segmentIndex];
          segmentText = trimmedText.slice(run.start, run.start + run.length);
          segments.push({
            signature: this.hashSegment(segmentText, segmentIndex),
            rect: run.rect,
          });
        }
      }
      candidates.push({
        ordinal,
        signature,
        segments,
        fullRect,
      });
    } finally {
      if (trimmedRange) this.bindings.release(trimmedRange);
      // Drop all text references before another native call. No text crosses
      // the worker boundary, and none is logged or persisted.
      trimmedText = null;
      segmentText = null;
      completeRowText = null;
    }
  }

  destroy() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.lastTarget = null;
    this.sessionKey.fill(0);
    this.bindings?.dispose();
    this.bindings = null;
  }
}

function runWorkerThread() {
  const backend = new TerminalUIAWorker((message) => parentPort.postMessage(message));
  parentPort.on('message', (message) => {
    if (message?.type === 'pause') backend.setPaused(message.paused);
    if (message?.type === 'shutdown') {
      backend.destroy();
      parentPort.close();
    }
  });
  parentPort.on('close', () => backend.destroy());
  backend.start();
}

function smokeWorker() {
  const messages = [];
  const backend = new TerminalUIAWorker((message) => messages.push(message));
  try {
    backend.initialize();
    const sampled = backend.sampleForeground();
    if (sampled.type === 'snapshot') {
      return {
        type: 'status',
        status: 'tracking',
        reason: sampled.rows.some((row) => row.attachable)
          ? 'sanitized-snapshot-ready'
          : 'sanitized-snapshot-empty',
      };
    }
    return sampled;
  } catch (error) {
    return statusForError(error);
  } finally {
    backend.destroy();
  }
}

module.exports = {
  ALLOWED_EXECUTABLES,
  POLL_INTERVAL_MS,
  TerminalUIAWorker,
  finitePositiveRect,
  isStatusMessage,
  textRunGeometry,
  smokeWorker,
  statusForError,
};

if (!isMainThread && parentPort) {
  runWorkerThread();
} else if (require.main === module) {
  const message = smokeWorker();
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
