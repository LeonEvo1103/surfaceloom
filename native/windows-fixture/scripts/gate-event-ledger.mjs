export function recordGateEvent(events, type, monotonicNs = process.hrtime.bigint()) {
  events.push({ sequence: events.length + 1, type, at: new Date().toISOString(),
    monotonicNs: monotonicNs.toString() });
}

export async function observeSuccessorAcquisition(child, events, releaseState, deadlineMs) {
  const observed = await child.nextObserved(deadlineMs);
  if (typeof observed.value !== "object" || observed.value === null
      || observed.value.type !== "acquired") {
    throw new Error("Contender protocol expected acquired.");
  }
  recordGateEvent(events, "successorAcquired", observed.monotonicNs);
  return Object.freeze({ frame: observed.value, enteredBeforeRelease: !releaseState.started });
}

export async function guardAgainstOwnerOverlap(observationPromise) {
  const observation = await observationPromise;
  if (observation.enteredBeforeRelease) {
    throw new Error("Contender acquired while the live GUI owner was still active.");
  }
  return new Promise(() => undefined);
}

export function deriveGateConcurrency(events) {
  const ordered = [...events].sort((left, right) => {
    const comparison = BigInt(left.monotonicNs) - BigInt(right.monotonicNs);
    return comparison < 0n ? -1 : comparison > 0n ? 1 : left.sequence - right.sequence;
  });
  let active = 0;
  let maximum = 0;
  for (const event of ordered) {
    if (event.type === "ownerAcquired" || event.type === "successorAcquired") active += 1;
    if (event.type === "ownerReleased" || event.type === "successorReleased") active -= 1;
    if (active < 0) throw new Error("GUI gate event ledger underflowed.");
    maximum = Math.max(maximum, active);
  }
  const index = (type) => ordered.findIndex((event) => event.type === type);
  return { maxConcurrentGuiOwners: maximum,
    successorEnteredOnlyAfterCleanupAndRelease: index("cleanupConfirmed") >= 0
      && index("ownerReleased") > index("cleanupConfirmed")
      && index("successorAcquired") > index("ownerReleased") };
}
