"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";

const ACCEPT = ".docx,.pptx,.xlsx";

export function UploadDocumentButton({
  disabled,
  uploading,
  onFileSelected,
}: {
  disabled?: boolean;
  uploading: boolean;
  onFileSelected: (file: File) => void;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onFileSelected(file);
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-[34px] rounded-[9px] px-3 text-[11px]"
        disabled={disabled || uploading}
        onClick={() => inputRef.current?.click()}
      >
        {uploading ? "Uploading…" : "Upload"}
      </Button>
    </>
  );
}
