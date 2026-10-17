import { createHash } from "node:crypto";
import { readDocumentForEditing } from "../documents/service.js";
import type { AttachmentExtraction, AttachmentExtractionService, AttachmentScope } from "../chat-attachments/extraction.js";
import type { SavedVisualObservation } from "./attachment-vision.js";
import type { AgentExecutionServiceDeps } from "./execution.js";
import type { DocumentCheck } from "./document-verification.js";

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
type WorkspaceSource = { documentId: string; versionId: string; draftId: string | null; sha256: string };
type AttachmentReference = Pick<AttachmentExtraction, "attachmentId" | "sha256" | "extractionId">;
type VisualReference = { attachmentId: string; extractionId: string; page?: number };
export type SavedSourceReferences = { workspace: WorkspaceSource[]; attachments: AttachmentReference[]; visuals: VisualReference[]; earlierEvidenceUnavailable: boolean };
type SourceStatus = "verified" | "unavailable" | "changed_or_inaccessible";
function failureStatus(error: unknown): SourceStatus {
  const value = error as { code?: string; statusCode?: number };
  return [403, 404, 409].includes(value?.statusCode ?? 0) || /CHANGED|NOT_FOUND|UNAUTHORIZED|FORBIDDEN|STALE/.test(value?.code ?? "")
    ? "changed_or_inaccessible" : "unavailable";
}

/** Check sources actually read or supplied, rather than treating the working set as proof. */
export function createSourceVerification(input: {
  documents: AgentExecutionServiceDeps["documents"];
  attachments?: AttachmentExtractionService;
  scope: AttachmentScope;
  submittedIds: readonly string[];
  saved?: SavedSourceReferences;
  earlierEvidenceUnavailable?: boolean;
}) {
  const workspace = new Map((input.saved?.workspace ?? []).map(source => [JSON.stringify(source), source]));
  const visuals = new Map((input.saved?.visuals ?? []).map(ref => [JSON.stringify(ref), ref]));
  const attachments = new Map<string, (AttachmentReference & Partial<Pick<AttachmentExtraction, "units">>) | undefined>(input.submittedIds.map(id => [id, undefined]));
  for (const source of input.saved?.attachments ?? []) attachments.set(source.attachmentId, source);
  const earlierEvidenceUnavailable = input.saved?.earlierEvidenceUnavailable || !!input.earlierEvidenceUnavailable;
  function remember(documentId: string, versionId: string, bytes: Uint8Array, draftId: string | null) {
    const source = { documentId, versionId, draftId, sha256: hash(bytes) };
    workspace.set(JSON.stringify(source), source);
  }
  const documents: AgentExecutionServiceDeps["documents"] = {
    ...input.documents,
    async readVersionForEditing(request) {
      const result = await readDocumentForEditing(input.documents, request);
      remember(request.documentId, request.versionId, result.bytes, result.draftId);
      return result;
    },
    async readExactVersionBytes(request) {
      const bytes = await input.documents.readExactVersionBytes(request);
      remember(request.documentId, request.versionId, bytes, null);
      return bytes;
    },
  };
  function rememberAttachment(source: AttachmentExtraction) {
    const previous = attachments.get(source.attachmentId);
    if (!previous || previous.sha256 === source.sha256 && previous.extractionId === source.extractionId) {
      attachments.set(source.attachmentId, source);
    }
  }
  const extraction: AttachmentExtractionService | undefined = input.attachments && {
    ...input.attachments,
    async view(scope, id, extractionId, page) {
      const result = await input.attachments!.view(scope, id, extractionId, page);
      rememberAttachment(result.extraction);
      const reference = { attachmentId: id, extractionId, ...(page === undefined ? {} : { page }) };
      visuals.set(JSON.stringify(reference), reference);
      return result;
    },
    async get(scope, id) {
      if (!attachments.has(id)) attachments.set(id, undefined);
      const result = await input.attachments!.get(scope, id);
      // Retain the first supplied identity; a later read must not hide a changed source.
      rememberAttachment(result.extraction);
      return result;
    },
  };
  return {
    documents,
    extraction,
    snapshot(): SavedSourceReferences {
      return { workspace: [...workspace.values()], visuals: [...visuals.values()], earlierEvidenceUnavailable,
        attachments: [...attachments.values()].filter((source): source is NonNullable<typeof source> => !!source)
          .map(({ attachmentId, sha256, extractionId }) => ({ attachmentId, sha256, extractionId })) };
    },
    async verify(targetId: string, observations: readonly SavedVisualObservation[] = []): Promise<DocumentCheck> {
      const results: { source: unknown; status: SourceStatus }[] = [];
      for (const source of workspace.values()) {
        if (source.documentId === targetId) continue;
        let status: SourceStatus;
        try {
          const current = await input.documents.getOwnedDocument({ documentId: source.documentId, ownerUserId: input.scope.userId });
          if (current.workspaceId !== input.scope.workspaceId || current.latestVersion.id !== source.versionId) status = "changed_or_inaccessible";
          else {
            const saved = await readDocumentForEditing(input.documents, { documentId: source.documentId, versionId: source.versionId, ownerUserId: input.scope.userId });
            status = saved.draftId === source.draftId && hash(saved.bytes) === source.sha256 ? "verified" : "changed_or_inaccessible";
          }
        } catch (error) { status = failureStatus(error); }
        results.push({ source, status });
      }
      for (const [attachmentId, source] of attachments) {
        let status: SourceStatus;
        try {
          // Check authorization even when initial extraction failed or the source disappeared.
          await input.attachments!.source.getBound({ ...input.scope, attachmentId });
          if (!source) status = "unavailable";
          else {
            await input.attachments!.verifySource(input.scope, source);
            const interpretations = observations.filter(item => item.visualReference.attachmentId === attachmentId);
            status = interpretations.every(item => item.sha256 === source.sha256 && item.visualReference.extractionId === source.extractionId)
              ? "verified" : "changed_or_inaccessible";
          }
        } catch (error) { status = failureStatus(error); }
        results.push({ source: { attachmentId, sha256: source?.sha256, extractionId: source?.extractionId,
          locations: source?.units?.slice(0, 20).map(unit => ({ location: unit.location, section: unit.section, page: unit.page?.number })),
          locationCount: source?.units?.length,
          visualReferences: [...visuals.values()].filter(ref => ref.attachmentId === attachmentId),
          interpretations: observations.filter(item => item.visualReference.attachmentId === attachmentId).map(item => ({
            reference: item.visualReference, model: item.model, resolvedModel: item.resolvedModel, observationSha256: hash(item.observation),
          })),
        }, status });
      }
      const changed = results.some(result => result.status === "changed_or_inaccessible");
      const unavailable = earlierEvidenceUnavailable || results.some(result => result.status === "unavailable");
      return { id: "sources", status: changed || unavailable ? "warning" : results.length ? "pass" : "skipped",
        message: changed ? "A source changed, was deleted, or is no longer authorized; the update used earlier evidence"
          : unavailable ? "Source verification unavailable for one or more supplied sources"
          : results.length ? "Supplied source identities verified" : "No source used",
        evidence: JSON.stringify(results),
      };
    },
  };
}
