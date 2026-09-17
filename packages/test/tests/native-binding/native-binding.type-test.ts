import { acquireNativeApplication } from "../../src/native-binding/binding.js";
import type { NativeBindingOptions } from "../../src/native-binding/contracts.js";

declare const options: NativeBindingOptions;

async function ownershipSurface(): Promise<void> {
  const owned = await acquireNativeApplication(options, "launch");
  await owned.invoke("quit");
  const borrowed = await acquireNativeApplication(options, "attach");
  await borrowed.invoke("find");
  // @ts-expect-error borrowed bindings do not expose quit or terminate.
  await borrowed.invoke("quit");
}

void ownershipSurface;
