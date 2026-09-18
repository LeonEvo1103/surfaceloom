export async function settleProbeReads(reads) {
  const settled = await Promise.allSettled(reads);
  const failures = settled.filter((item) => item.status === "rejected")
    .map((item) => item.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Multiple evidence probes failed.");
  return settled.map((item) => item.value);
}
