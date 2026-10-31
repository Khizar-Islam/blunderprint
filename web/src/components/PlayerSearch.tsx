"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { isValidUsername, PLATFORM_NAMES, PLATFORMS, type Platform } from "@/lib/api";

// Platform toggle + username → /p/[platform]/[username].
// The toggle is a real radio group (native <input type="radio"> with the same name), so the
// browser gives it keyboard behaviour for free: Tab enters the group, arrow keys move between
// the options and select them. The inputs are visually hidden; the labels are the visible pills.
export function PlayerSearch() {
  const router = useRouter();
  const [platform, setPlatform] = useState<Platform>("chesscom");
  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const name = username.trim();
    if (!isValidUsername(platform, name)) {
      setError(`That isn't a valid ${PLATFORM_NAMES[platform]} username.`);
      return;
    }
    router.push(`/p/${platform}/${encodeURIComponent(name)}`);
  }

  return (
    <form onSubmit={submit} className="flex w-full max-w-md flex-col gap-3" noValidate>
      <fieldset className="flex gap-1 self-start rounded-md border border-ink/20 p-1">
        <legend className="sr-only">Platform</legend>
        {PLATFORMS.map((p) => (
          <label
            key={p}
            className="cursor-pointer rounded px-3 py-1 text-sm text-graphite transition-colors select-none hover:bg-square-light has-checked:bg-ink has-checked:text-bone has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ink active:scale-95"
          >
            <input
              type="radio"
              name="platform"
              value={p}
              checked={platform === p}
              onChange={() => {
                setPlatform(p);
                setError(null);
              }}
              className="sr-only"
            />
            {PLATFORM_NAMES[p]}
          </label>
        ))}
      </fieldset>

      <div className="flex gap-2">
        <label className="sr-only" htmlFor="username">
          {PLATFORM_NAMES[platform]} username
        </label>
        <input
          id="username"
          value={username}
          onChange={(e) => {
            setUsername(e.target.value);
            setError(null);
          }}
          placeholder={`${PLATFORM_NAMES[platform]} username`}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className="min-w-0 flex-1 rounded-md border border-ink/30 bg-transparent px-3 py-2 font-mono text-base text-ink transition-colors placeholder:font-sans placeholder:text-graphite/50 hover:border-ink/60 focus-visible:border-ink"
        />
        <button
          type="submit"
          className="rounded-md bg-ink px-4 py-2 text-bone transition hover:bg-graphite active:scale-95"
        >
          Show games
        </button>
      </div>

      {error && (
        <p id={errorId} className="text-sm text-graphite" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
