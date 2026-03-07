export type Vec3 = { x: number; y: number; z: number };

export enum PathSpace {
  XYZ = "xyz",
  XY = "xy",
  XZ = "xz"
}

export enum EndOfPathInstruction {
  Loop = "loop",
  Reverse = "reverse",
  Stop = "stop"
}

export enum ControlMode {
  Aligned = "aligned",
  Mirrored = "mirrored",
  Free = "free",
  Automatic = "automatic"
}
