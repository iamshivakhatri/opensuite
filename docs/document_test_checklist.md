# Manual document checks

You run these checks in OpenSuite and Word or Google Docs. No browser or Word
testing has been performed for this checklist. Automated code tests are separate.

Start with copies of the Blue Harbor monthly report and Monitoring Report already
in the project. Use your normal proposal and branded document for the remaining
business cases. Existing academic/form examples and generated engine fixtures
can check preservation, but do not count as ten real business documents.

## Before each test

Keep an untouched original and upload a fresh copy. Record the app commit, engine
version and binary hash from the startup log. Keep the same request when comparing
two releases. Inspect the saved version, then download and reopen it in Word or
Google Docs. A successful message alone does not prove the edit worked.

## Ten checks

| # | Request to try | Expected result |
| --- | --- | --- |
| 1 | Change the reporting month and date in a monthly report. | All requested dates change; unrelated dates, branding, and tables stay intact. |
| 2 | Change one KPI value using its row label and column heading. | Only the intended cell changes. Totals are changed only when requested. |
| 3 | Make the KPI table header bold and give it a light blue background. | Header text remains unchanged; data rows retain their formatting. |
| 4 | Add a new KPI row, then remove a named obsolete row in a fresh copy. | The correct row changes; table shape and surrounding content remain intact. |
| 5 | Replace the client name, proposal date, and project price. | Correct occurrences change; unrelated names and prices stay intact. |
| 6 | Apply a saved company style to a proposal. | Supported fonts, spacing, and styles match; content and numbering remain unchanged. Unsupported changes are explained. |
| 7 | Insert or replace an owned logo image. | The correct image changes, with sensible size and layout; other images stay intact. |
| 8 | Add a review comment, inspect it, then update or delete it. | Comment points to the intended text; removing it does not remove document text. |
| 9 | Add a tracked edit, inspect it, and accept or reject it. | Word shows the change correctly; the decision produces the expected text and preserves unrelated changes. |
| 10 | Ask for an edit where the target appears twice; also try a protected or unsupported edit. | The agent identifies the intended occurrence or asks for clarification. Unsupported edits fail safely with truthful messages and no damaged output. |

Also check headers, footers, page numbering, table widths, page breaks, notes,
and untouched content after every edit. Refresh TOC/page fields in Word where
required; check that the product explains this instead of claiming it calculated
page numbers itself.

## Record the result

Use [document_test_results.csv](document_test_results.csv). Record the exact
request, affected saved version, visible error, and expected result. For failures,
keep the original and downloaded result together. Record elapsed seconds, tool
calls/model turns and cost when shown; leave unavailable measurements blank.

Run each case three times from its original. Fix content loss, wrong targets,
false success messages, and saved-version errors before adding features. Then
address repeated unnecessary reads and delays. The D1 baseline is complete only
after ten representative business documents have recorded results; preparing
this checklist does not complete those manual tests.
