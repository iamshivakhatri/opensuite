import type {
  InspectDocumentRequest,
  InspectDocumentResult,
} from "@opensuite/contracts";
import type { EngineTransport } from "./transport.js";

/**
 * Application-facing entry point to `opensuite-engine`.
 *
 * `EngineClient` holds no engine logic itself — it forwards each request to
 * whichever `EngineTransport` it was constructed with and returns the
 * result exactly as received, unmodified, through the contract boundary.
 * Callers (eventually `agent-core`) should depend on `EngineClient`, not on
 * a transport directly.
 */
export class EngineClient {
  constructor(private readonly transport: EngineTransport) {}

  inspectDocument(
    request: InspectDocumentRequest,
  ): Promise<InspectDocumentResult> {
    return this.transport.inspectDocument(request);
  }
}
