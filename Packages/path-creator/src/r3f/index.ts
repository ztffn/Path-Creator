import { EndOfPathInstruction, type VertexPath } from "../core";

export interface FollowerState {
  distance: number;
}

export function updateFollowerState(
  state: FollowerState,
  speed: number,
  deltaSeconds: number,
  path: VertexPath,
  mode: EndOfPathInstruction
): FollowerState {
  const nextDistance = state.distance + speed * deltaSeconds;
  return {
    distance: path.resolveDistance(nextDistance, mode)
  };
}
