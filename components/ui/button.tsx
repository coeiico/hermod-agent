import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-[10px] text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-70 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        // Its own token set, not `--primary` (clay) — see `--button-primary` in tailwind.css.
        default:
          "cursor-pointer border border-button-primary-edge bg-button-primary text-button-primary-ink hover:bg-button-primary-hover",
        destructive:
          "cursor-pointer bg-destructive text-ink-inv hover:bg-destructive/90 focus-visible:ring-destructive/20",
        outline:
          "cursor-pointer border bg-background hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "cursor-pointer bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "cursor-pointer hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        // Underlined text on no chip. Its box resets live in `compoundVariants`, because the
        // size classes land after the variant's. Hover thickens the underline rather than
        // bolding, so the link keeps its width.
        link: "cursor-pointer text-[13px] text-ink underline decoration-1 underline-offset-4 hover:decoration-2 disabled:opacity-50",
      },
      size: {
        default: "h-[var(--control-h)] rounded-[10px] px-3.5 has-[>svg]:px-3",
        sm: "h-[var(--control-h-sm)] gap-1.5 rounded-[8px] px-2.5 has-[>svg]:px-2",
        lg: "h-[var(--control-h-lg)] rounded-[12px] px-5 has-[>svg]:px-4",
        icon: "size-[var(--control-h)] rounded-[10px]",
        "icon-sm": "size-[var(--control-h-sm)] rounded-[8px]",
        "icon-lg": "size-[var(--control-h-lg)] rounded-[12px]",
      },
    },
    compoundVariants: [
      {
        variant: "link",
        className: "h-auto justify-start rounded-none px-0 has-[>svg]:px-0",
      },
    ],
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
