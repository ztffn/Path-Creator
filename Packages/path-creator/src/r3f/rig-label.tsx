// Renderer-safe billboarded text label. troika <Text> (drei) renders a garbage
// white quad on three's WebGPU node renderer (its SDF glyph atlas doesn't sample
// there) — silently, no crash. RigLabel draws the text to a 2D canvas and shows
// it on a camera-facing Sprite (SpriteMaterial auto-maps on both backends), so
// anchor numbers / cart + vcam names render correctly on WebGL and WebGPU alike.
import { useEffect, useMemo } from "react";
import { CanvasTexture, LinearFilter, SRGBColorSpace } from "three";

export interface RigLabelProps {
  /** Label text. */
  children: string;
  position?: [number, number, number];
  color?: string;
  /** Cap height of the glyphs in world units (matches troika `fontSize`). */
  fontSize?: number;
  renderOrder?: number;
}

// Supersample resolution: glyph cap height in canvas pixels. High enough to stay
// crisp when a label is close to the camera; short strings keep the texture tiny.
const CAP_PX = 96;
// Padding around the glyphs as a fraction of CAP_PX, so descenders/edges aren't
// clipped and the sprite has a little breathing room.
const PAD = 0.35;
const FONT = `600 ${CAP_PX}px system-ui, -apple-system, "Segoe UI", sans-serif`;

export function RigLabel({
  children,
  position,
  color = "#ffffff",
  fontSize = 0.08,
  renderOrder = 999
}: RigLabelProps) {
  const { texture, aspect } = useMemo(() => {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    ctx.font = FONT;
    const textWidth = ctx.measureText(children).width;
    const padPx = CAP_PX * PAD;
    canvas.width = Math.max(1, Math.ceil(textWidth + padPx * 2));
    canvas.height = Math.ceil(CAP_PX + padPx * 2);
    // Resizing the canvas resets the 2D context, so re-apply text state.
    ctx.font = FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;
    ctx.fillText(children, canvas.width / 2, canvas.height / 2);

    const tex = new CanvasTexture(canvas);
    tex.colorSpace = SRGBColorSpace;
    tex.minFilter = LinearFilter; // no mipmaps (non-power-of-two canvas)
    tex.magFilter = LinearFilter;
    tex.needsUpdate = true;
    return { texture: tex, aspect: canvas.width / canvas.height };
  }, [children, color]);

  // Free the GPU texture when the label text/colour changes or unmounts.
  useEffect(() => () => texture.dispose(), [texture]);

  // Sprite height = full canvas (glyph + padding), so glyph height ≈ fontSize.
  const height = fontSize * (1 + PAD * 2);
  return (
    <sprite
      scale={[height * aspect, height, 1]}
      renderOrder={renderOrder}
      {...(position && { position })}
    >
      <spriteMaterial
        map={texture}
        transparent
        depthTest={false}
        depthWrite={false}
        toneMapped={false}
      />
    </sprite>
  );
}
