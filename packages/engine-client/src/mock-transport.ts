import type {
  InspectDocumentRequest,
  InspectDocumentResult,
} from "@opensuite/contracts";
import type { EngineTransport } from "./transport.js";

export type InspectDocumentResponder = (
  request: InspectDocumentRequest,
) => InspectDocumentResult | Promise<InspectDocumentResult>;

/**
 * In-memory stand-in for the real engine transport, used to develop
 * OpenSuite before `opensuite-engine` and its real transport exist.
 *
 * It does no document parsing of its own — it simply resolves whatever
 * response the caller configures, and records the requests it received so
 * tests can assert on request forwarding.
 */
export class MockEngineTransport implements EngineTransport {
  readonly receivedRequests: InspectDocumentRequest[] = [];

  constructor(private readonly respond: InspectDocumentResponder) {}

  async inspectDocument(
    request: InspectDocumentRequest,
  ): Promise<InspectDocumentResult> {
    this.receivedRequests.push(request);
    return this.respond(request);
  }
}
