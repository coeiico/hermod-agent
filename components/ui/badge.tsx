import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-[8px] border px-1.5 py-0 text-[11px] leading-[18px] font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "border-transparent bg-clay text-ink-inv [a&]:hover:bg-clay-hover",
        secondary: "border-transparent bg-ground-sunk text-ink",
        outline: "border-line bg-surface-alt text-ink-2 [a&]:hover:bg-ground-sunk",
        /** Filled contrast chip for identity, not status. */
        solid: "border-transparent bg-contrast text-contrast-ink",
        /** Tinted chips carry an edge in their own hue, or the soft fill melts into
            grey surfaces. Dark tints are translucent, so the edge drops to /20 there. */
        destructive: "border-bad/35 bg-bad-tint text-bad-ink dark:border-bad/20",
        success: "border-sage/35 bg-sage-tint text-sage-ink dark:border-sage/20",
        warning: "border-amber/35 bg-amber-tint text-amber-ink dark:border-amber/20",
        clay: "border-clay/35 bg-clay-tint text-clay-ink dark:border-clay/20",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
