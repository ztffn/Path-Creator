import { evaluateCurve, estimateCurveLength, splitCurve } from "./cubic-bezier";
import { ControlMode, PathSpace, type Vec3 } from "./types";
import { clamp01, vec3 } from "./vec3";

export interface BezierPathOptions {
  isClosed?: boolean;
  space?: PathSpace;
  controlMode?: ControlMode;
  autoControlLength?: number;
}

export interface SerializedBezierPath {
  points: Vec3[];
  perAnchorNormalsAngle: number[];
  isClosed: boolean;
  space: PathSpace;
  controlMode: ControlMode;
  autoControlLength: number;
  flipNormals: boolean;
  globalNormalsAngle: number;
}

export class BezierPath {
  private points: Vec3[];
  private perAnchorNormalsAngle: number[];

  public isClosed: boolean;
  public space: PathSpace;
  public controlMode: ControlMode;
  public autoControlLength: number;
  public flipNormals: boolean;
  public globalNormalsAngle: number;

  constructor(anchorPoints: Vec3[], options: BezierPathOptions = {}) {
    if (anchorPoints.length < 2) {
      throw new Error("BezierPath requires at least 2 anchor points");
    }

    this.space = options.space ?? PathSpace.XYZ;
    this.controlMode = options.controlMode ?? ControlMode.Automatic;
    this.autoControlLength = Math.max(options.autoControlLength ?? 0.3, 0.01);
    this.flipNormals = false;
    this.globalNormalsAngle = 0;

    this.points = [
      this.constrain(anchorPoints[0]),
      vec3.create(),
      vec3.create(),
      this.constrain(anchorPoints[1])
    ];
    this.perAnchorNormalsAngle = [0, 0];

    for (let i = 2; i < anchorPoints.length; i += 1) {
      this.addSegmentToEnd(anchorPoints[i]);
    }

    this.isClosed = false;
    if (this.controlMode === ControlMode.Automatic) {
      this.autoSetAllControlPoints();
    }

    this.isClosed = options.isClosed ?? false;
    if (this.isClosed) {
      this.updateClosedState();
    }
  }

  get numPoints(): number {
    return this.points.length;
  }

  get numAnchorPoints(): number {
    return this.isClosed ? this.points.length / 3 : (this.points.length + 2) / 3;
  }

  get numSegments(): number {
    return this.isClosed ? this.points.length / 3 : (this.points.length - 1) / 3;
  }

  getPoint(index: number): Vec3 {
    return this.points[index];
  }

  setPoint(index: number, p: Vec3): void {
    this.points[index] = this.constrain(p);
  }

  getAnchor(anchorIndex: number): Vec3 {
    return this.points[anchorIndex * 3];
  }

  getAnchorNormalAngle(anchorIndex: number): number {
    return this.perAnchorNormalsAngle[anchorIndex] % 360;
  }

  setAnchorNormalAngle(anchorIndex: number, angle: number): void {
    this.perAnchorNormalsAngle[anchorIndex] = ((angle % 360) + 360) % 360;
  }

  getPointsInSegment(segmentIndex: number): [Vec3, Vec3, Vec3, Vec3] {
    const clamped = Math.max(0, Math.min(this.numSegments - 1, Math.floor(segmentIndex)));
    return [
      this.points[clamped * 3],
      this.points[clamped * 3 + 1],
      this.points[clamped * 3 + 2],
      this.points[this.loopIndex(clamped * 3 + 3)]
    ];
  }

  getEstimatedLength(): number {
    let total = 0;
    for (let i = 0; i < this.numSegments; i += 1) {
      const [p0, p1, p2, p3] = this.getPointsInSegment(i);
      total += estimateCurveLength(p0, p1, p2, p3);
    }
    return total;
  }

  addSegmentToEnd(anchorPos: Vec3): void {
    if (this.isClosed) return;

    const anchor = this.constrain(anchorPos);
    const lastAnchorIndex = this.points.length - 1;
    let secondControlOffset = vec3.sub(
      this.points[lastAnchorIndex],
      this.points[lastAnchorIndex - 1]
    );

    if (
      this.controlMode !== ControlMode.Mirrored &&
      this.controlMode !== ControlMode.Automatic
    ) {
      const dst = vec3.distance(this.points[lastAnchorIndex], anchor);
      secondControlOffset = vec3.scale(vec3.normalize(secondControlOffset), dst * 0.5);
    }

    const secondControl = vec3.add(this.points[lastAnchorIndex], secondControlOffset);
    const controlForNewAnchor = vec3.scale(vec3.add(anchor, secondControl), 0.5);

    this.points.push(secondControl, controlForNewAnchor, anchor);
    this.perAnchorNormalsAngle.push(this.perAnchorNormalsAngle[this.perAnchorNormalsAngle.length - 1] ?? 0);

    if (this.controlMode === ControlMode.Automatic) {
      this.autoSetAllAffectedControlPoints(this.points.length - 1);
    }
  }

  splitSegment(segmentIndex: number, splitTime = 0.5, anchorPos?: Vec3): number {
    if (this.numSegments < 1) {
      throw new Error("Cannot split segment on empty path");
    }

    const safeSegmentIndex = Math.max(0, Math.min(this.numSegments - 1, segmentIndex));
    const t = clamp01(splitTime);
    const segmentPoints = this.getPointsInSegment(safeSegmentIndex);
    const split = splitCurve(segmentPoints, t);
    const newAnchor = this.constrain(anchorPos ?? split[0][3]);

    if (this.controlMode === ControlMode.Automatic) {
      this.points.splice(safeSegmentIndex * 3 + 2, 0, vec3.create(), newAnchor, vec3.create());
      const newAnchorIndex = safeSegmentIndex * 3 + 3;
      this.perAnchorNormalsAngle.splice(
        (safeSegmentIndex + 1) % this.perAnchorNormalsAngle.length,
        0,
        0
      );
      this.autoSetAllAffectedControlPoints(newAnchorIndex);
      return newAnchorIndex;
    }

    const insertAt = safeSegmentIndex * 3 + 2;
    this.points.splice(insertAt, 0, split[0][2], split[1][0], split[1][1]);
    const newAnchorIndex = safeSegmentIndex * 3 + 3;
    this.movePoint(newAnchorIndex - 2, split[0][1]);
    this.movePoint(newAnchorIndex + 2, split[1][2]);
    this.movePoint(newAnchorIndex, newAnchor);

    const angleInsertIndex = (safeSegmentIndex + 1) % this.perAnchorNormalsAngle.length;
    const anglePrev = this.perAnchorNormalsAngle[safeSegmentIndex];
    const angleNext = this.perAnchorNormalsAngle[angleInsertIndex];
    this.perAnchorNormalsAngle.splice(angleInsertIndex, 0, anglePrev + (angleNext - anglePrev) * t);

    if (this.controlMode === ControlMode.Mirrored) {
      const avgDistance =
        (vec3.distance(split[0][2], newAnchor) + vec3.distance(split[1][1], newAnchor)) / 2;
      const dir = vec3.normalize(vec3.sub(split[1][1], newAnchor));
      this.movePoint(newAnchorIndex + 1, vec3.add(newAnchor, vec3.scale(dir, avgDistance)));
    }

    return newAnchorIndex;
  }

  deleteAnchor(anchorPointIndex: number): boolean {
    const isAnchor = anchorPointIndex % 3 === 0;
    if (!isAnchor) {
      return false;
    }

    if (!(this.numSegments > 2 || (!this.isClosed && this.numSegments > 1))) {
      return false;
    }

    if (anchorPointIndex === 0) {
      if (this.isClosed) {
        this.points[this.points.length - 1] = this.points[2];
      }
      this.points.splice(0, 3);
    } else if (anchorPointIndex === this.points.length - 1 && !this.isClosed) {
      this.points.splice(anchorPointIndex - 2, 3);
    } else {
      this.points.splice(anchorPointIndex - 1, 3);
    }

    const normalIndex = Math.floor(anchorPointIndex / 3);
    this.perAnchorNormalsAngle.splice(normalIndex, 1);

    if (this.controlMode === ControlMode.Automatic) {
      this.autoSetAllControlPoints();
    }

    return true;
  }

  movePoint(index: number, p: Vec3): void {
    const pointPos = this.constrain(p);
    const deltaMove = vec3.sub(pointPos, this.points[index]);
    const isAnchorPoint = index % 3 === 0;

    if (!isAnchorPoint && this.controlMode === ControlMode.Automatic) {
      return;
    }

    this.points[index] = pointPos;

    if (this.controlMode === ControlMode.Automatic) {
      this.autoSetAllAffectedControlPoints(index);
      return;
    }

    if (isAnchorPoint) {
      if (index + 1 < this.points.length || this.isClosed) {
        const i = this.loopIndex(index + 1);
        this.points[i] = vec3.add(this.points[i], deltaMove);
      }
      if (index - 1 >= 0 || this.isClosed) {
        const i = this.loopIndex(index - 1);
        this.points[i] = vec3.add(this.points[i], deltaMove);
      }
      return;
    }

    if (this.controlMode === ControlMode.Free) {
      return;
    }

    const nextPointIsAnchor = (index + 1) % 3 === 0;
    const attachedControlIndex = nextPointIsAnchor ? index + 2 : index - 2;
    const anchorIndex = nextPointIsAnchor ? index + 1 : index - 1;

    if (
      !this.isClosed &&
      (attachedControlIndex < 0 || attachedControlIndex >= this.points.length)
    ) {
      return;
    }

    let distanceFromAnchor = 0;
    const anchorPoint = this.points[this.loopIndex(anchorIndex)];

    if (this.controlMode === ControlMode.Aligned) {
      distanceFromAnchor = vec3.distance(
        anchorPoint,
        this.points[this.loopIndex(attachedControlIndex)]
      );
    } else if (this.controlMode === ControlMode.Mirrored) {
      distanceFromAnchor = vec3.distance(anchorPoint, this.points[index]);
    }

    const dir = vec3.normalize(vec3.sub(anchorPoint, pointPos));
    this.points[this.loopIndex(attachedControlIndex)] = vec3.add(
      anchorPoint,
      vec3.scale(dir, distanceFromAnchor)
    );
  }

  setClosed(isClosed: boolean): void {
    if (this.isClosed === isClosed) return;
    this.isClosed = isClosed;
    this.updateClosedState();
  }

  setControlMode(mode: ControlMode): void {
    if (this.controlMode === mode) return;
    this.controlMode = mode;
    if (mode === ControlMode.Automatic) {
      this.autoSetAllControlPoints();
    }
  }

  autoSmooth(controlLength = this.autoControlLength): void {
    this.autoControlLength = Math.max(controlLength, 0.01);
    this.autoSetAllControlPoints();
  }

  toJSON(): SerializedBezierPath {
    return {
      points: this.points.map((p) => ({ x: p.x, y: p.y, z: p.z })),
      perAnchorNormalsAngle: [...this.perAnchorNormalsAngle],
      isClosed: this.isClosed,
      space: this.space,
      controlMode: this.controlMode,
      autoControlLength: this.autoControlLength,
      flipNormals: this.flipNormals,
      globalNormalsAngle: this.globalNormalsAngle
    };
  }

  static fromJSON(serialized: SerializedBezierPath): BezierPath {
    if (serialized.points.length < 4) {
      throw new Error("Serialized bezier path must contain at least 4 points");
    }

    const anchors = [serialized.points[0], serialized.points[3]];
    const path = new BezierPath(anchors, {
      isClosed: false,
      space: serialized.space,
      controlMode: serialized.controlMode,
      autoControlLength: serialized.autoControlLength
    });

    path.points = serialized.points.map((p) => ({ x: p.x, y: p.y, z: p.z }));
    path.perAnchorNormalsAngle = [...serialized.perAnchorNormalsAngle];
    path.isClosed = serialized.isClosed;
    path.flipNormals = serialized.flipNormals;
    path.globalNormalsAngle = serialized.globalNormalsAngle;
    path.autoControlLength = Math.max(serialized.autoControlLength, 0.01);
    path.controlMode = serialized.controlMode;

    return path;
  }

  private constrain(v: Vec3): Vec3 {
    if (this.space === PathSpace.XY) return { x: v.x, y: v.y, z: 0 };
    if (this.space === PathSpace.XZ) return { x: v.x, y: 0, z: v.z };
    return vec3.clone(v);
  }

  private loopIndex(i: number): number {
    return (i + this.points.length) % this.points.length;
  }

  private updateClosedState(): void {
    if (this.isClosed) {
      let lastAnchorSecondControl = vec3.sub(
        vec3.scale(this.points[this.points.length - 1], 2),
        this.points[this.points.length - 2]
      );
      let firstAnchorSecondControl = vec3.sub(
        vec3.scale(this.points[0], 2),
        this.points[1]
      );

      if (
        this.controlMode !== ControlMode.Mirrored &&
        this.controlMode !== ControlMode.Automatic
      ) {
        const dst = vec3.distance(this.points[this.points.length - 1], this.points[0]);
        lastAnchorSecondControl = vec3.add(
          this.points[this.points.length - 1],
          vec3.scale(
            vec3.normalize(
              vec3.sub(this.points[this.points.length - 1], this.points[this.points.length - 2])
            ),
            dst * 0.5
          )
        );
        firstAnchorSecondControl = vec3.add(
          this.points[0],
          vec3.scale(vec3.normalize(vec3.sub(this.points[0], this.points[1])), dst * 0.5)
        );
      }

      this.points.push(lastAnchorSecondControl, firstAnchorSecondControl);
      if (this.controlMode === ControlMode.Automatic) {
        this.autoSetStartAndEndControls();
      }
      return;
    }

    this.points.splice(this.points.length - 2, 2);
  }

  private autoSetAllAffectedControlPoints(updatedAnchorIndex: number): void {
    for (let i = updatedAnchorIndex - 3; i <= updatedAnchorIndex + 3; i += 3) {
      if ((i >= 0 && i < this.points.length) || this.isClosed) {
        this.autoSetAnchorControlPoints(this.loopIndex(i));
      }
    }
    this.autoSetStartAndEndControls();
  }

  private autoSetAllControlPoints(): void {
    if (this.numAnchorPoints > 2) {
      for (let i = 0; i < this.points.length; i += 3) {
        this.autoSetAnchorControlPoints(i);
      }
    }
    this.autoSetStartAndEndControls();
  }

  private autoSetAnchorControlPoints(anchorIndex: number): void {
    const anchorPos = this.points[anchorIndex];
    let dir = vec3.create();
    const neighborDistances = [0, 0];

    if (anchorIndex - 3 >= 0 || this.isClosed) {
      const offset = vec3.sub(this.points[this.loopIndex(anchorIndex - 3)], anchorPos);
      dir = vec3.add(dir, vec3.normalize(offset));
      neighborDistances[0] = vec3.magnitude(offset);
    }

    if (anchorIndex + 3 < this.points.length || this.isClosed) {
      const offset = vec3.sub(this.points[this.loopIndex(anchorIndex + 3)], anchorPos);
      dir = vec3.sub(dir, vec3.normalize(offset));
      neighborDistances[1] = -vec3.magnitude(offset);
    }

    dir = vec3.normalize(dir);

    for (let i = 0; i < 2; i += 1) {
      const controlIndex = anchorIndex + i * 2 - 1;
      if ((controlIndex >= 0 && controlIndex < this.points.length) || this.isClosed) {
        this.points[this.loopIndex(controlIndex)] = vec3.add(
          anchorPos,
          vec3.scale(dir, neighborDistances[i] * this.autoControlLength)
        );
      }
    }
  }

  private autoSetStartAndEndControls(): void {
    if (this.isClosed) {
      if (this.numAnchorPoints === 2) {
        const dir = vec3.normalize(vec3.sub(this.points[3], this.points[0]));
        const dst = vec3.distance(this.points[0], this.points[3]);
        const up = this.space === PathSpace.XY ? vec3.create(0, 0, 1) : vec3.create(0, 1, 0);
        const perp = vec3.cross(dir, up);

        this.points[1] = vec3.add(this.points[0], vec3.scale(perp, dst / 2));
        this.points[5] = vec3.sub(this.points[0], vec3.scale(perp, dst / 2));
        this.points[2] = vec3.add(this.points[3], vec3.scale(perp, dst / 2));
        this.points[4] = vec3.sub(this.points[3], vec3.scale(perp, dst / 2));
        return;
      }

      this.autoSetAnchorControlPoints(0);
      this.autoSetAnchorControlPoints(this.points.length - 3);
      return;
    }

    if (this.numAnchorPoints === 2) {
      this.points[1] = vec3.lerp(this.points[0], this.points[3], 0.25);
      this.points[2] = vec3.lerp(this.points[3], this.points[0], 0.25);
      return;
    }

    this.points[1] = vec3.scale(vec3.add(this.points[0], this.points[2]), 0.5);
    this.points[this.points.length - 2] = vec3.scale(
      vec3.add(this.points[this.points.length - 1], this.points[this.points.length - 3]),
      0.5
    );
  }

  evaluate(segmentIndex: number, t: number): Vec3 {
    return evaluateCurve(this.getPointsInSegment(segmentIndex), clamp01(t));
  }
}
