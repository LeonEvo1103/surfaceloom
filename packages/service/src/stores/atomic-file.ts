import { randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export async function writeAtomicFile(
  target: string,
  data: string | Uint8Array,
): Promise<void> {
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, data, { mode: 0o600, flag: "wx" });
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
