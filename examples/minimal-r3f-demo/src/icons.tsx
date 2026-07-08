// Inline SVG icons (Tabler set) used across the demo panels in place of emoji
// glyphs. Stroke uses currentColor so each icon inherits the control's text
// color; size via the `size` prop. Purely presentational. Demo scaffolding.
import type { CSSProperties, ReactNode } from "react";

function Icon({ size = 16, style, children }: { size?: number; style?: CSSProperties; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block", ...style }}
      aria-hidden
    >
      {children}
    </svg>
  );
}

type IconProps = { size?: number; style?: CSSProperties };

export const IconEye = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0" />
    <path d="M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6" />
  </Icon>
);

export const IconEyeOff = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10.585 10.587a2 2 0 0 0 2.829 2.828" />
    <path d="M16.681 16.673a8.717 8.717 0 0 1 -4.681 1.327c-3.6 0 -6.6 -2 -9 -6c1.272 -2.12 2.712 -3.678 4.32 -4.674m2.86 -1.146a9.055 9.055 0 0 1 1.82 -.18c3.6 0 6.6 2 9 6c-.666 1.11 -1.379 2.067 -2.138 2.87" />
    <path d="M3 3l18 18" />
  </Icon>
);

export const IconVolume = (p: IconProps) => (
  <Icon {...p}>
    <path d="M15 8a5 5 0 0 1 0 8" />
    <path d="M17.7 5a9 9 0 0 1 0 14" />
    <path d="M6 15h-2a1 1 0 0 1 -1 -1v-4a1 1 0 0 1 1 -1h2l3.5 -4.5a.8 .8 0 0 1 1.5 .5v14a.8 .8 0 0 1 -1.5 .5l-3.5 -4.5" />
  </Icon>
);

export const IconVideo = (p: IconProps) => (
  <Icon {...p}>
    <path d="M15 10l4.553 -2.276a1 1 0 0 1 1.447 .894v6.764a1 1 0 0 1 -1.447 .894l-4.553 -2.276v-4z" />
    <path d="M3 6m0 2a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2z" />
  </Icon>
);

export const IconDirector = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 21l12 -9" />
    <path d="M6 12l12 9" />
    <path d="M5 12h14" />
    <path d="M6 3v9" />
    <path d="M18 3v9" />
    <path d="M6 8h12" />
    <path d="M6 5h12" />
  </Icon>
);

export const IconTrack = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 15l11 -11m5 5l-11 11m-4 -8l7 7m-3.5 -10.5l7 7m-3.5 -10.5l7 7" />
  </Icon>
);
