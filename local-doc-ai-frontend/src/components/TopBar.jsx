import React from "react";
import Button from "./Button.jsx";

export default function TopBar({ onLogout }) {
  return (
    <div className="sticky top-0 z-10 border-b border-zinc-200 bg-white/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-xl bg-zinc-900" />
          <div>
            <div className="text-sm font-semibold text-zinc-900">Local Document AI</div>
            <div className="text-xs text-zinc-500">Private, on-device search</div>
          </div>
        </div>

        <Button variant="secondary" onClick={onLogout}>
          Log out
        </Button>
      </div>
    </div>
  );
}
