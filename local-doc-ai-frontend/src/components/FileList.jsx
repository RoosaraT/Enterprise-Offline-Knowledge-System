import React from "react";

function prettySize(bytes) {
  if (bytes == null) return "";
  const units = ["B", "KB", "MB", "GB"];
  let val = bytes;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(val < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

export default function FileList({ files, onRemove }) {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-5">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-zinc-900">Files</div>
          <div className="text-xs text-zinc-500">Local list (frontend-only for now)</div>
        </div>
        <div className="text-xs text-zinc-500">{files.length} selected</div>
      </div>

      <div className="mt-4 space-y-2">
        {files.length === 0 ? (
          <div className="rounded-xl border border-zinc-100 bg-zinc-50 p-4 text-sm text-zinc-600">
            No files yet. Upload something to begin.
          </div>
        ) : (
          files.map((f, idx) => (
            <div
              key={`${f.name}-${idx}`}
              className="flex items-center justify-between rounded-xl border border-zinc-100 bg-white px-4 py-3"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-zinc-900">{f.name}</div>
                <div className="text-xs text-zinc-500">{prettySize(f.size)}</div>
              </div>
              <button
                className="rounded-lg px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                onClick={() => onRemove(idx)}
                type="button"
              >
                Remove
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
