export const executorCheckpoints = Object.freeze([
  "before-submit", "after-submit", "after-effect",
]);

export function createCheckpointController() {
  const points = new Map(executorCheckpoints.map((name) => [name, {
    name, mode: "pass", reached: false, passed: false, waiter: null,
    releaseOnCancel: true, releaseOnClose: true, failure: null,
  }]));

  const find = (name) => {
    const point = points.get(name);
    if (!point) throw fixtureError("INVALID_CHECKPOINT", `Unknown checkpoint '${String(name)}'.`);
    return point;
  };

  const release = (point, reason) => {
    if (point.waiter === null) return false;
    const waiter = point.waiter;
    point.waiter = null;
    point.mode = "pass";
    waiter.cleanup();
    waiter.resolve(reason);
    return true;
  };

  return Object.freeze({
    pause(name, options = {}) {
      const point = find(name);
      if (point.passed) throw fixtureError("CHECKPOINT_PASSED", `Checkpoint '${name}' already passed.`, 409);
      point.mode = "pause";
      point.releaseOnCancel = options.releaseOnCancel !== false;
      point.releaseOnClose = options.releaseOnClose !== false;
      return snapshot(point);
    },
    fail(name, message = `Injected failure at ${name}.`) {
      const point = find(name);
      if (point.passed) throw fixtureError("CHECKPOINT_PASSED", `Checkpoint '${name}' already passed.`, 409);
      const error = fixtureError("CHECKPOINT_FAILURE", String(message), 500);
      point.failure = error;
      if (point.waiter !== null) {
        const waiter = point.waiter;
        point.waiter = null;
        waiter.cleanup();
        waiter.reject(error);
      }
      return snapshot(point);
    },
    resume(name) {
      const point = find(name);
      release(point, "resumed");
      point.mode = "pass";
      return snapshot(point);
    },
    arrive(name, signal) {
      const point = find(name);
      point.reached = true;
      if (point.failure !== null) {
        point.passed = true;
        throw point.failure;
      }
      if (point.mode !== "pause") {
        point.passed = true;
        return undefined;
      }
      if (point.waiter !== null) return point.waiter.promise;
      let resolve;
      let reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      const onAbort = () => {
        if (point.releaseOnCancel) release(point, "cancelled");
      };
      signal.addEventListener("abort", onAbort, { once: true });
      point.waiter = {
        promise, resolve, reject,
        cleanup: () => signal.removeEventListener("abort", onAbort),
      };
      if (signal.aborted && point.releaseOnCancel) release(point, "cancelled");
      return promise.then((reason) => {
        point.passed = true;
        return reason;
      });
    },
    releaseForClose() {
      for (const point of points.values()) {
        if (point.releaseOnClose) release(point, "closed");
      }
    },
    snapshot(name) {
      return snapshot(find(name));
    },
  });
}

function snapshot(point) {
  return Object.freeze({
    checkpoint: point.name,
    mode: point.mode,
    reached: point.reached,
    waiting: point.waiter !== null,
    passed: point.passed,
    releaseOnCancel: point.releaseOnCancel,
    releaseOnClose: point.releaseOnClose,
  });
}

function fixtureError(code, message, status = 400) {
  const error = new Error(message);
  error.name = "FixtureError";
  error.code = code;
  error.status = status;
  return error;
}
