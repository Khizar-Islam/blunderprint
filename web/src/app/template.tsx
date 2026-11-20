// A short fade on every route change. Unlike layout.tsx, a template is mounted afresh on each
// navigation, so its CSS animation (anim-fade, from transparent to the normal style) plays once
// per page. A filter change (history.pushState on the same page) doesn't remount it. It needs
// no animation frames, and reduced motion switches it off (globals.css).
// The wrapper keeps the body's column layout: pages are `flex-1` children of it.
// It is at least one screen tall (min-h-svh), so the site footer under it (layout.tsx) always
// starts below the first screen: a page that grows as its data loads then pushes the footer
// while it is out of view, which is not a layout shift (in view it measured CLS 0.026).
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="anim-fade flex min-h-svh flex-1 flex-col [animation-duration:200ms]">{children}</div>;
}
