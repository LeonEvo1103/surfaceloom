import type { CollectedEvidenceArtifact } from "../../evidence/collector.js";

/**
 * Distinguishing attachment title built only from normalized, identifier-validated fields
 * (kind, probe/resource/operation identifiers, outcome and producer). It never quotes
 * evidence values, trace bodies or native detail; Reporter redacts titles again.
 */
export function evidenceArtifactTitle(item: CollectedEvidenceArtifact): string {
  return `${contentLabel(item.content)} · source ${item.source.kind}:${item.source.producerId}`;
}

function contentLabel(content: CollectedEvidenceArtifact["content"]): string {
  switch (content.kind) {
    case "trace": return `Trace (${content.schemaVersion})`;
    case "probe": return `Probe ${content.probeId} · resource ${content.resource} · ${content.outcome}`;
    case "nativeOperation":
      return `Native operation ${content.operationId ?? "unnamed"} · resource ${content.resource} · ${content.outcome}`;
    case "nativeProbe": return `Native probe · resource ${content.resource} · ${content.outcome}`;
    case "nativeJournal": return `Native journal (${content.entries.length} entries)`;
  }
}
