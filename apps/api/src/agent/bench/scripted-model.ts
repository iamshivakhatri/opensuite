import {
  assistantOnlyResponse,
  createScriptedAgentModel,
  toolCallResponse,
  type AgentModel,
} from "@opensuite/agent-core";

/** Fixed, local tool-call plans for benchmark scenarios. Never contacts a provider. */
export function createScriptedBenchmarkModel(scenario: string): AgentModel {
  switch (scenario) {
    case "target-duplicate":
      return createScriptedAgentModel([
        toolCallResponse("", [{
          id: "style-second-note",
          name: "document.set_paragraph_style",
          input: { target: { text: "Note", occurrence: 2 }, style: "Heading 1" },
        }]),
        assistantOnlyResponse("Done."),
      ]);
    case "target-recovery":
      return createScriptedAgentModel([
        toolCallResponse("", [{
          id: "ambiguous-note",
          name: "document.set_paragraph_style",
          input: { target: { text: "Note" }, style: "Heading 1" },
        }]),
        toolCallResponse("", [{
          id: "inspect-notes",
          name: "document.inspect",
          input: { focus: { kind: "paragraphs", offset: 0, limit: 4 } },
        }]),
        toolCallResponse("", [{
          id: "style-second-note",
          name: "document.set_paragraph_style",
          input: { target: { text: "Note", occurrence: 2 }, style: "Heading 1" },
        }]),
        assistantOnlyResponse("Done."),
      ]);
    case "greenfield-poems":
      return createScriptedAgentModel([
        toolCallResponse("", [{
          id: "create-poems",
          name: "workspace.create_blank_docx",
          input: { name: "Poems.docx" },
        }]),
        toolCallResponse("Done — poems are ready.", [
          {
            id: "poem-body",
            name: "document.insert_paragraphs",
            input: {
              texts: ["Five Small Poems", "An introduction.", "First Poem", "A small line.", "Second Poem", "Another line.", "Third Poem", "Third line.", "Fourth Poem", "Fourth line.", "Fifth Poem", "Fifth line.", "A closing section."],
              placement: { kind: "end" },
            },
          },
          ...["Five Small Poems", "First Poem", "Second Poem", "Third Poem", "Fourth Poem", "Fifth Poem"].map((text, index) => ({
            id: `style-${index}`,
            name: "document.set_paragraph_style",
            input: { target: { text }, style: index === 0 ? "Heading 1" : "Heading 2" },
          })),
        ]),
      ]);
    default:
      throw new Error(`No scripted benchmark plan for ${scenario}`);
  }
}
