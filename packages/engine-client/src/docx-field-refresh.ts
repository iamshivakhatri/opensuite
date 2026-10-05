import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

export type DocxFieldRefreshStatus = "refreshed" | "unavailable" | "failed";

export interface DocxFieldRefreshResult {
  readonly status: DocxFieldRefreshStatus;
  readonly provider: "libreoffice-macro";
  readonly bytes?: Uint8Array;
  readonly durationMs: number;
  readonly warnings: readonly string[];
  readonly detail?: string;
}

export interface DocxFieldRefreshOptions {
  readonly sofficePath?: string;
  /** Override cached availability for tests. */
  readonly availability?: "available" | "unavailable";
  readonly timeoutMs?: number;
}

type Availability = "unknown" | "available" | "unavailable";

let cachedAvailability: Availability = "unknown";
let cachedSofficePath: string | undefined;

const MACRO_MODULE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE script:module PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "module.dtd">
<script:module xmlns:script="http://openoffice.org/2000/script" script:name="Module1" script:language="StarBasic">REM  *****  BASIC  *****

Sub UpdateIndexes(path As String)
    Dim doc As Object
    Dim args(1) As New com.sun.star.beans.PropertyValue
    Dim i As Integer
    Dim storeArgs(0) As New com.sun.star.beans.PropertyValue

    args(0).Name = "Hidden"
    args(0).Value = True
    args(1).Name = "UpdateDocMode"
    args(1).Value = 3

    doc = StarDesktop.loadComponentFromURL(ConvertToURL(path), "_blank", 0, args())
    If IsNull(doc) Then
        Exit Sub
    End If

    If doc.supportsService("com.sun.star.text.GenericTextDocument") Then
        For i = 0 To doc.getDocumentIndexes().getCount() - 1
            doc.getDocumentIndexes().getByIndex(i).update()
        Next i
        On Error Resume Next
        doc.getTextFields().refresh()
        On Error GoTo 0
    End If

    storeArgs(0).Name = "FilterName"
    storeArgs(0).Value = "Office Open XML Text"
    doc.storeToURL(ConvertToURL(path), storeArgs())
    doc.close(True)
End Sub
</script:module>
`;

/** Cheap process-level probe; reused for the lifetime of the Node process. */
export async function probeDocxFieldRefreshAvailability(
  sofficePath = "soffice",
): Promise<"available" | "unavailable"> {
  if (cachedAvailability !== "unknown" && cachedSofficePath === sofficePath) {
    return cachedAvailability === "available" ? "available" : "unavailable";
  }
  cachedSofficePath = sofficePath;
  try {
    await run(sofficePath, ["--version"], {
      timeout: 5_000,
      maxBuffer: 64_000,
      env: { ...process.env, LC_ALL: "C" },
    });
    cachedAvailability = "available";
    return "available";
  } catch {
    cachedAvailability = "unavailable";
    return "unavailable";
  }
}

/** Test helper — resets the process-level availability cache. */
export function resetDocxFieldRefreshAvailabilityForTests(): void {
  cachedAvailability = "unknown";
  cachedSofficePath = undefined;
}

/**
 * Refresh DOCX indexes/fields via headless LibreOffice + an isolated Basic macro.
 * Field evaluation stays outside the Rust engine. Caller must verify before adopting bytes.
 */
export async function refreshDocxFields(
  bytes: Uint8Array,
  options: DocxFieldRefreshOptions = {},
): Promise<DocxFieldRefreshResult> {
  const started = Date.now();
  const sofficePath = options.sofficePath ?? "soffice";
  const timeoutMs = options.timeoutMs ?? 60_000;
  const provider = "libreoffice-macro" as const;

  const availability =
    options.availability ?? (await probeDocxFieldRefreshAvailability(sofficePath));
  if (availability === "unavailable") {
    return {
      status: "unavailable",
      provider,
      durationMs: Date.now() - started,
      warnings: ["LibreOffice field refresh is unavailable"],
      detail: "soffice unavailable",
    };
  }

  let folder: string | undefined;
  try {
    folder = await mkdtemp(join(tmpdir(), "opensuite-field-refresh-"));
    const profile = join(folder, "profile");
    const source = join(folder, "input.docx");
    await writeFile(source, bytes);
    await seedLibreOfficeMacroProfile(profile, sofficePath, timeoutMs);

    await run(
      sofficePath,
      [
        `-env:UserInstallation=${pathToFileURL(profile).href}`,
        "--headless",
        "--norestore",
        "--nolockcheck",
        "--nologo",
        `macro:///Standard.Module1.UpdateIndexes(${source})`,
      ],
      {
        timeout: timeoutMs,
        maxBuffer: 1_048_576,
        env: { ...process.env, LC_ALL: "C" },
      },
    );

    const refreshed = new Uint8Array(await readFile(source));
    if (refreshed.byteLength < 64) {
      return {
        status: "failed",
        provider,
        durationMs: Date.now() - started,
        warnings: ["LibreOffice produced an empty document"],
        detail: "empty output",
      };
    }
    return {
      status: "refreshed",
      provider,
      bytes: refreshed,
      durationMs: Date.now() - started,
      warnings: [],
    };
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException)?.code === "ENOENT";
    if (missing) {
      cachedAvailability = "unavailable";
      cachedSofficePath = sofficePath;
    }
    const timedOut =
      (error as { killed?: boolean; signal?: string })?.killed === true ||
      (error as { signal?: string })?.signal === "SIGTERM";
    return {
      status: missing ? "unavailable" : "failed",
      provider,
      durationMs: Date.now() - started,
      warnings: [
        missing
          ? "LibreOffice field refresh is unavailable"
          : timedOut
            ? "LibreOffice field refresh timed out"
            : "LibreOffice field refresh failed",
      ],
      detail: error instanceof Error ? error.message.slice(0, 240) : "unknown error",
    };
  } finally {
    if (folder) await rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function seedLibreOfficeMacroProfile(
  profile: string,
  sofficePath: string,
  timeoutMs: number,
): Promise<void> {
  // Fresh profiles overwrite Standard/Module1; init first, then install our macro.
  await run(
    sofficePath,
    [
      `-env:UserInstallation=${pathToFileURL(profile).href}`,
      "--headless",
      "--norestore",
      "--nolockcheck",
      "--terminate_after_init",
    ],
    {
      timeout: Math.min(timeoutMs, 30_000),
      maxBuffer: 1_048_576,
      env: { ...process.env, LC_ALL: "C" },
    },
  );

  const modulePath = join(profile, "user", "basic", "Standard", "Module1.xba");
  await writeFile(modulePath, MACRO_MODULE);

  const registryPath = join(profile, "user", "registrymodifications.xcu");
  let registry = "";
  try {
    registry = await readFile(registryPath, "utf8");
  } catch {
    registry =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n' +
      "</oor:items>\n";
  }
  if (!registry.includes("MacroSecurityLevel")) {
    const item =
      '<item oor:path="/org.openoffice.Office.Common/Security/Scripting">' +
      '<prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>0</value></prop></item>';
    registry = registry.includes("</oor:items>")
      ? registry.replace("</oor:items>", `${item}\n</oor:items>`)
      : `${registry.trim()}\n${item}\n`;
    await writeFile(registryPath, registry);
  }
}
