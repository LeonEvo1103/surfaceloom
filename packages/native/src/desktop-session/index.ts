export type {
  ApplicationDesktopSession,
  AxLocator,
  DesktopSessionEvidence,
  DesktopSessionEvidenceSink,
  DesktopSessionHandshake,
  DesktopSessionCleanupPort,
  DesktopSessionLifecyclePort,
  DesktopSessionOperationPort,
  NativeDesktopBackend,
  NativeDesktopOperation,
  NativeDesktopPlatform,
  NativeLifecycleOptions,
  NativeHostChildExitProof,
  NativeLocatorFor,
  NativeSessionIdentity,
  NativeSessionReleaseProof,
  NativeTargetExitProof,
  SystemDesktopSession,
  UiaLocator,
} from "./contracts.js";
export {
  BoundedDesktopSessionJournal,
  invokeLegacyCompatible,
  retainOperationEvidence,
} from "./evidence-journal.js";
export { JournaledDesktopSessionOperationPort } from "./journaled-port.js";
export { NativeLateAcquisitionMailbox } from "./late-acquisition.js";
