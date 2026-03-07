import { describe, expect, it } from "vitest";
import { VertexPath } from "../src/core";
import { buildRoadMeshBuffers, buildTubeMeshBuffers } from "../src/three";

describe("three geometry builders", () => {
  const path = new VertexPath(
    [
      { x: -1, y: 0, z: 0 },
      { x: 0, y: 0.5, z: 0 },
      { x: 1, y: 0, z: 0 }
    ],
    [0, 1, 2]
  );

  it("buildRoadMeshBuffers returns valid indexed triangles", () => {
    const mesh = buildRoadMeshBuffers(path, { roadWidth: 0.3, thickness: 0.1 });
    expect(mesh.positions.length).toBe(path.numPoints * 8 * 3);
    expect(mesh.indices.length % 3).toBe(0);
    expect(mesh.normals?.length).toBe(mesh.positions.length);
    expect(mesh.uvs?.length).toBe(path.numPoints * 8 * 2);
  });

  it("buildTubeMeshBuffers returns valid tube data", () => {
    const mesh = buildTubeMeshBuffers(path, {
      radius: 0.2,
      radialSegments: 8,
      segmentsPerUnit: 4
    });

    expect(mesh.positions.length).toBeGreaterThan(0);
    expect(mesh.indices.length).toBeGreaterThan(0);
    expect(mesh.indices.length % 3).toBe(0);
    expect(mesh.normals?.length).toBe(mesh.positions.length);
    expect(mesh.uvs?.length).toBe((mesh.positions.length / 3) * 2);
  });
});
