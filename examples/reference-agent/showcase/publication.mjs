import { access, rename, rm } from "node:fs/promises";

const defaultOperations = Object.freeze({ remove: rm, move: rename, assertMissing });

export async function publishAggregateAfterChildCleanup(
  { work, aggregateStaging, finalDirectory },
  operations = defaultOperations,
) {
  try {
    await operations.remove(work, { recursive: true, force: false });
    await operations.assertMissing(work);
    await operations.assertMissing(finalDirectory);
    await operations.move(aggregateStaging, finalDirectory);
  } catch (error) {
    try { await operations.remove(aggregateStaging, { recursive: true, force: true }); }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError],
        "Child cleanup failed and aggregate staging removal was not confirmed.");
    }
    throw error;
  }
}

async function assertMissing(candidate) {
  try { await access(candidate); }
  catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Expected an absent publication path: ${candidate}.`);
}
