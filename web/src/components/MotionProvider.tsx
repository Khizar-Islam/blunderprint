"use client";

import { MotionConfig } from "motion/react";

// reducedMotion="user": when the OS asks for less motion (prefers-reduced-motion), motion skips
// transform animations (movement, scale) and keeps opacity fades. One switch for the whole app.
export function MotionProvider({ children }: { children: React.ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
