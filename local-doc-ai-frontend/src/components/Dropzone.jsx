import React, { useId, useRef, useState } from "react";

export default function Dropzone({ onFiles }) {
  const id = useId();
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (files.length > 0) onFiles(files);
  }

  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-5">
      <div
        className={[
          "flex flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-10 text-center transition",
          dragging ? "border-zinc-500 bg-zinc-50" : "border-zinc-200",
        ].join(" ")}
        onDragEnter={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragging(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragging(false);
          handleFiles(e.dataTransfer.files);
        }}
      >
        <div className="text-sm font-medium text-zinc-900">Drop files here</div>
        <div className="mt-1 text-xs text-zinc-500">PDF, DOCX, TXT (you can add more later)</div>

        <div className="mt-5 flex items-center gap-3">
          <button
            className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 focus:outline-none focus:ring-4 focus:ring-zinc-200"
            onClick={() => inputRef.current?.click()}
            type="button"
          >
            Choose files
          </button>

          <button
            className="rounded-xl border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-50 focus:outline-none focus:ring-4 focus:ring-zinc-100"
            onClick={() => handleFiles([])}
            type="button"
          >
            Clear selection
          </button>
        </div>

        <input
          id={id}
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>
    </div>
  );
}
