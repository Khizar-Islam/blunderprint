"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { isValidUsername, PLATFORM_NAMES, PLATFORMS, type Platform } from "@/lib/api";
import { Arrow } from "./landing/Arrow";

// The landing's own-games line: a username on one ruled line, the platform as a quiet choice
// of two words beside it, an arrow to go → /p/[platform]/[username].
// - The platform is a real radio group (native <input type="radio"> with one name), so the
//   browser gives it keyboard behaviour for free: Tab enters the group, the arrow keys move
//   between the two and select. The inputs are visually hidden; the words are their labels.
// - Every target is at least 44 px tall; the arrow is a submit button named "Show games".
// - A username the platform can't have is refused here, in words, before any request.
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
      setError(name ? `That isn't a valid ${PLATFORM_NAMES[platform]} username.` : `Type a ${PLATFORM_NAMES[platform]} username first.`);
      return;
    }
    router.push(`/p/${platform}/${encodeURIComponent(name)}`);
  }

  const choice = (
    <fieldset className="flex shrink-0 items-center">
      <legend className="sr-only">Platform</legend>
      {PLATFORMS.map((p, i) => (
        <span key={p} className="inline-flex items-center">
          {i > 0 && (
            <span aria-hidden="true" className="px-0.5 text-sm text-graphite/70">
              /
            </span>
          )}
          <label className="inline-flex min-h-11 cursor-pointer items-center rounded px-1 text-sm text-graphite underline decoration-transparent decoration-1 underline-offset-[6px] transition-[color,text-decoration-color,transform] duration-150 select-none hover:text-ink hover:decoration-ink/30 active:scale-95 has-checked:text-ink has-checked:decoration-ink has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ink">
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
        </span>
      ))}
    </fieldset>
  );

  const field = (
    <>
      <label className="sr-only" htmlFor="username">
        Your {PLATFORM_NAMES[platform]} username
      </label>
      <input
        id="username"
        value={username}
        onChange={(e) => {
          setUsername(e.target.value);
          setError(null);
        }}
        placeholder="Your username"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className="min-h-11 min-w-0 flex-1 rounded-none bg-transparent font-mono text-base text-ink placeholder:font-sans placeholder:text-graphite/70 placeholder:transition-colors hover:placeholder:text-ink"
      />
    </>
  );

  const go = (
    <button
      type="submit"
      aria-label="Show games"
      className="group inline-flex min-h-11 min-w-11 shrink-0 items-center justify-end rounded text-ink transition-transform active:scale-90"
    >
      <Arrow />
    </button>
  );

  const problem = error && (
    <p id={errorId} className="pt-2 text-sm text-blunder-text" role="alert">
      {error}
    </p>
  );

  return (
    <form onSubmit={submit} className="flex w-full flex-col" noValidate>
      <div className="flex items-center gap-x-3 border-b border-ink/25 transition-colors focus-within:border-ink hover:border-ink/60">
        {field}
        {choice}
        {go}
      </div>
      {problem}
    </form>
  );
}
