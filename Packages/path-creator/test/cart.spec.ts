// Tests for the path cart abstraction and rig document: deterministic
// sampling, live stepping vs random access equivalence, orientation modes,
// rail-local offsets, serialization round-trips, and the three.js adapter
// that places objects at cart frames. Carts are the seam between paths and
// riders, so these tests pin the coupling contract.
import { Object3D, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import {
  BezierPath,
  EndOfPathInstruction,
  VertexPath,
  advanceCartDistance,
  DEFAULT_COMPOSER_SETTINGS,
  buildRigRuntime,
  createPathCart,
  createRigDocument,
  deserializePathCart,
  sampleCartFrame,
  sampleCartFrameAtTime,
  serializePathCart,
  serializeRigCart,
  serializeRigPath,
  vec3,
  type Vec3
} from "../src/core";
import { applyCartFrameToObject } from "../src/three";

const straightPath = new VertexPath(
  [
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 }
  ],
  [0, 10]
);

const slopedPath = new VertexPath(
  [
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 10, z: 0 }
  ],
  [0, Math.hypot(10, 10)]
);

function expectVec3Close(actual: Vec3, expected: Vec3, precision = 6): void {
  expect(actual.x).toBeCloseTo(expected.x, precision);
  expect(actual.y).toBeCloseTo(expected.y, precision);
  expect(actual.z).toBeCloseTo(expected.z, precision);
}

describe("createPathCart", () => {
  it("applies defaults and clones the offset", () => {
    const offset = { x: 1, y: 2, z: 3 };
    const cart = createPathCart({ positionOffset: offset });

    expect(cart.distance).toBe(0);
    expect(cart.speed).toBe(0);
    expect(cart.endOfPathInstruction).toBe(EndOfPathInstruction.Loop);
    expect(cart.orientationMode).toBe("path-frame");
    expect(cart.positionOffset).not.toBe(offset);
    expectVec3Close(cart.positionOffset, offset);
  });
});

describe("advanceCartDistance", () => {
  it("advances by speed * dt and wraps in loop mode", () => {
    const cart = createPathCart({ distance: 8, speed: 2 });
    expect(advanceCartDistance(straightPath, cart, 1)).toBe(0);
    expect(advanceCartDistance(straightPath, cart, 0.5)).toBe(9);
  });

  it("clamps in stop mode", () => {
    const cart = createPathCart({
      distance: 8,
      speed: 4,
      endOfPathInstruction: EndOfPathInstruction.Stop
    });
    expect(advanceCartDistance(straightPath, cart, 2)).toBe(10);
  });
});

describe("sampleCartFrame", () => {
  it("returns the rail point, resolved distance, and normalized time", () => {
    const cart = createPathCart({ distance: 5 });
    const frame = sampleCartFrame(straightPath, cart);

    expectVec3Close(frame.railPosition, { x: 5, y: 0, z: 0 });
    expect(frame.distance).toBe(5);
    expect(frame.time).toBeCloseTo(0.5);
  });

  it("returns an orthonormal right-handed basis", () => {
    const cart = createPathCart({ distance: 3 });
    const frame = sampleCartFrame(straightPath, cart);

    expect(vec3.magnitude(frame.forward)).toBeCloseTo(1);
    expect(vec3.magnitude(frame.up)).toBeCloseTo(1);
    expect(vec3.magnitude(frame.right)).toBeCloseTo(1);
    expect(vec3.dot(frame.forward, frame.up)).toBeCloseTo(0);
    expect(vec3.dot(frame.forward, frame.right)).toBeCloseTo(0);
    expect(vec3.dot(frame.up, frame.right)).toBeCloseTo(0);
    expectVec3Close(vec3.cross(frame.up, frame.forward), frame.right);
  });

  it("applies the rail-local offset along the frame basis", () => {
    const offset = { x: 0.5, y: 1.5, z: -2 };
    const cart = createPathCart({ distance: 5, positionOffset: offset });
    const frame = sampleCartFrame(straightPath, cart);

    const expected = vec3.add(
      frame.railPosition,
      vec3.add(
        vec3.add(vec3.scale(frame.right, offset.x), vec3.scale(frame.up, offset.y)),
        vec3.scale(frame.forward, offset.z)
      )
    );
    expectVec3Close(frame.position, expected);
  });

  it("random access matches accumulated stepping", () => {
    const stepped = createPathCart({ speed: 2 });
    for (let i = 0; i < 3; i += 1) {
      stepped.distance = advanceCartDistance(straightPath, stepped, 1);
    }
    const steppedFrame = sampleCartFrame(straightPath, stepped);

    const direct = createPathCart({ speed: 2 });
    const directFrame = sampleCartFrame(straightPath, direct, 6);

    expectVec3Close(steppedFrame.position, directFrame.position);
    expect(steppedFrame.distance).toBe(directFrame.distance);
  });

  it("samples by normalized time", () => {
    const cart = createPathCart();
    const frame = sampleCartFrameAtTime(straightPath, cart, 0.25);
    expectVec3Close(frame.railPosition, { x: 2.5, y: 0, z: 0 });
  });

  it("is deterministic for identical inputs", () => {
    const cart = createPathCart({ distance: 4, positionOffset: { x: 1, y: 0, z: 0 } });
    const a = sampleCartFrame(straightPath, cart);
    const b = sampleCartFrame(straightPath, cart);
    expect(a).toEqual(b);
  });
});

describe("cart orientation modes", () => {
  it("path-yaw keeps the world up and flattens forward", () => {
    const cart = createPathCart({ distance: 5, orientationMode: "path-yaw" });
    const frame = sampleCartFrame(slopedPath, cart);

    expectVec3Close(frame.up, { x: 0, y: 1, z: 0 });
    expect(frame.forward.y).toBeCloseTo(0);
    expect(vec3.magnitude(frame.forward)).toBeCloseTo(1);
    expect(frame.forward.x).toBeCloseTo(1);
  });

  it("fixed returns world axes and applies the offset in world space", () => {
    const cart = createPathCart({
      distance: 5,
      orientationMode: "fixed",
      positionOffset: { x: 0, y: 2, z: 0 }
    });
    const frame = sampleCartFrame(straightPath, cart);

    expectVec3Close(frame.forward, { x: 0, y: 0, z: 1 });
    expectVec3Close(frame.up, { x: 0, y: 1, z: 0 });
    expectVec3Close(frame.right, { x: 1, y: 0, z: 0 });
    expectVec3Close(frame.position, { x: 5, y: 2, z: 0 });
  });
});

describe("cart serialization", () => {
  it("round-trips through serialize/deserialize", () => {
    const cart = createPathCart({
      distance: 3,
      speed: 1.5,
      endOfPathInstruction: EndOfPathInstruction.Reverse,
      orientationMode: "path-yaw",
      positionOffset: { x: 1, y: 2, z: 3 }
    });

    const serialized = serializePathCart(cart, "path-a");
    expect(serialized.pathId).toBe("path-a");

    const restored = deserializePathCart(serialized);
    expect(restored).toEqual(cart);
    expect("pathId" in restored).toBe(false);
  });
});

describe("rig document", () => {
  const bezier = new BezierPath([
    { x: 0, y: 0, z: 0 },
    { x: 5, y: 0, z: 0 },
    { x: 10, y: 2, z: 0 }
  ]);

  it("round-trips paths and carts through JSON into a runtime", () => {
    const cart = createPathCart({ speed: 2 });
    const document = createRigDocument({
      paths: [serializeRigPath("path-a", bezier, { name: "Main rail" })],
      carts: [serializeRigCart("cart-1", cart, "path-a")]
    });

    const runtime = buildRigRuntime(JSON.parse(JSON.stringify(document)) as typeof document);

    expect(runtime.paths.get("path-a")).toBeInstanceOf(VertexPath);
    expect(runtime.carts.get("cart-1")).toEqual(cart);
    expect(runtime.cartPaths.get("cart-1")).toBe("path-a");
  });

  it("rejects carts referencing unknown paths", () => {
    const document = createRigDocument({
      carts: [serializeRigCart("cart-1", createPathCart(), "missing-path")]
    });
    expect(() => buildRigRuntime(document)).toThrow(/unknown path/);
  });

  it("rejects unknown schema versions", () => {
    const document = { ...createRigDocument(), schemaVersion: 99 };
    expect(() => buildRigRuntime(document as never)).toThrow(/schema version/);
  });

  it("rejects a screen-composer aim referencing an undeclared target", () => {
    const document = createRigDocument({
      vcams: [
        {
          id: "vcam-1",
          body: { type: "static", position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } },
          aim: { type: "screen-composer", target: { targetId: "ghost" }, settings: DEFAULT_COMPOSER_SETTINGS }
        }
      ]
    });
    expect(() => buildRigRuntime(document)).toThrow(/unknown target "ghost"/);
  });

  it("accepts a screen-composer aim framing a declared target", () => {
    const document = createRigDocument({
      targets: [{ id: "hero", type: "point", position: { x: 1, y: 0, z: 0 } }],
      vcams: [
        {
          id: "vcam-1",
          body: { type: "static", position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } },
          aim: { type: "screen-composer", target: { targetId: "hero" }, settings: DEFAULT_COMPOSER_SETTINGS }
        }
      ]
    });
    const runtime = buildRigRuntime(JSON.parse(JSON.stringify(document)) as typeof document);
    expect(runtime.vcams.get("vcam-1")?.aim?.type).toBe("screen-composer");
  });
});

describe("closed-loop normal seam", () => {
  const closedBezier = new BezierPath(
    [
      { x: 0, y: 0, z: 0 },
      { x: 6, y: 2, z: 1 },
      { x: 9, y: 0, z: 6 },
      { x: 3, y: -1, z: 8 }
    ],
    { isClosed: true }
  );
  const closedPath = new VertexPath(closedBezier, { maxAngleError: 0.5 });

  it("normals line up across the loop join", () => {
    const first = closedPath.getNormal(0);
    const last = closedPath.getNormal(closedPath.numPoints - 1);
    expect(vec3.dot(first, last)).toBeGreaterThan(0.999);
  });

  it("cart frames are continuous across the loop join", () => {
    const cart = createPathCart();
    const before = sampleCartFrame(closedPath, cart, closedPath.length - 0.01);
    const after = sampleCartFrame(closedPath, cart, 0.01);
    expect(vec3.dot(before.up, after.up)).toBeGreaterThan(0.99);
    expect(vec3.dot(before.forward, after.forward)).toBeGreaterThan(0.99);
  });
});

describe("applyCartFrameToObject", () => {
  it("places the object at the frame position with forward as +Z", () => {
    const cart = createPathCart({ distance: 5, positionOffset: { x: 0, y: 1, z: 0 } });
    const frame = sampleCartFrame(straightPath, cart);
    const object = new Object3D();

    applyCartFrameToObject(object, frame);

    expect(object.position.x).toBeCloseTo(frame.position.x);
    expect(object.position.y).toBeCloseTo(frame.position.y);
    expect(object.position.z).toBeCloseTo(frame.position.z);

    const localForward = new Vector3(0, 0, 1).applyQuaternion(object.quaternion);
    expect(localForward.x).toBeCloseTo(frame.forward.x);
    expect(localForward.y).toBeCloseTo(frame.forward.y);
    expect(localForward.z).toBeCloseTo(frame.forward.z);

    const localUp = new Vector3(0, 1, 0).applyQuaternion(object.quaternion);
    expect(localUp.x).toBeCloseTo(frame.up.x);
    expect(localUp.y).toBeCloseTo(frame.up.y);
    expect(localUp.z).toBeCloseTo(frame.up.z);
  });
});
