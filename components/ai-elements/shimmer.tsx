"use client";

import { cn } from "@/lib/utils";
import type { CSSProperties, ElementType } from "react";
import { memo } from "react";

export interface TextShimmerProps {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
}

// Restyled for Baritone: the `text-shimmer` utility in assets/tailwind.css sweeps
// `ink` across `ink-3` and stops under prefers-reduced-motion.
const ShimmerComponent = ({
  children,
  as: Component = "p",
  className,
  duration = 2.2,
}: TextShimmerProps) => (
  <Component
    className={cn("inline-block text-shimmer", className)}
    style={{ animationDuration: `${duration}s` } as CSSProperties}
  >
    {children}
  </Component>
);

export const Shimmer = memo(ShimmerComponent);
