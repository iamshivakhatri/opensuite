import type {
  InspectDocumentRequest,
  InspectDocumentResult,
} from "@opensuite/contracts";

/**
 * The transport is the only thing that knows how to reach opensuite-engine.
 * `EngineClient` depends on this interface, never on a concrete transport,
 * so swapping `MockEngineTransport` for a future `HttpEngineTransport`
 * requires no change to `EngineClient` or its callers.
 */
export interface EngineTransport {
  inspectDocument(
    request: InspectDocumentRequest,
  ): Promise<InspectDocumentResult>;
}
