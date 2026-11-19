import Link from "next/link";

// A short message in the page's own voice: an ink rule on the left, a serif title, one plain
// line, and at most one button and one link. Used where a page has nothing else to show (a
// player that can't be loaded, a page that doesn't exist, something that broke).
export function Notice({
  title,
  children,
  action,
  link,
}: {
  title: string;
  children: React.ReactNode;
  action?: { label: string; onClick: () => void };
  link?: { href: string; label: string };
}) {
  return (
    <div className="flex flex-col items-start gap-2 border-l-2 border-ink/30 py-1 pl-4" role="status">
      <p className="font-display text-xl text-ink">{title}</p>
      <p className="text-sm text-graphite">{children}</p>
      {action && (
        <button type="button" className="btn-quiet mt-1 text-sm" onClick={action.onClick}>
          {action.label}
        </button>
      )}
      {link && (
        <Link href={link.href} className="btn-quiet mt-1 text-sm">
          {link.label}
        </Link>
      )}
    </div>
  );
}

export const SEARCH_LINK = { href: "/", label: "Search another player" } as const;
