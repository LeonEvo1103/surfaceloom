import type { JsonValue, NativeHandle, NativeSessionDescriptor } from "../contracts.js";

export interface NativeCodecContext {
  /** Explicitly enroll a session returned by a platform method. */
  readonly trackSession: (session: NativeSessionDescriptor) => NativeSessionDescriptor;
  /** Explicitly enroll a handle returned by a platform method. */
  readonly trackHandle: (handle: NativeHandle) => NativeHandle;
}

/** Platform packages own payload/result semantics and provide codecs here. */
export interface NativeResultCodec<T> {
  decode(value: JsonValue, context: NativeCodecContext): T;
}

export const jsonResultCodec: NativeResultCodec<JsonValue> = Object.freeze({
  decode(value: JsonValue): JsonValue { return value; },
});
