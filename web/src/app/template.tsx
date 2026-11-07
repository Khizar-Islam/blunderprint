// A short fade on every route change. Unlike layout.tsx, a template is mounted afresh on each
// navigation, so its CSS animation (anim-fade, from transparent to the normal style) plays once
// per page. A filter change (history.pushState on the same page) doesn't remount it. It needs
// no animation frames, and reduced motion switches it off (globals.css).
// The wrapper keeps the body's column layout: pages are `flex-1` children of it.
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="anim-fade flex flex-1 flex-col [animation-duration:200ms]">{children}</div>;
}
