// The inspector descriptors: Pascal's inspector is NOT derived from the Zod schema —
// it renders `def.parametrics`, a hand-declared descriptor, and the definitions are cast at
// the package boundary (exactOptionalPropertyTypes vs Pascal's published types), so tsc CANNOT
// catch a typo'd field key in them. This spec is that missing type-check: every declared field
// key must exist on the kind's own defaults, and visibleIf toggles must partition as designed.
import { describe, expect, it } from "vitest";
import {
  cartDefinition,
  cueDefinition,
  pathDefinition,
  shotDefinition,
  timelineDefinition
} from "../src/index";

type Fieldish = { key: string; kind: string; visibleIf?: (n: Record<string, unknown>) => boolean };
type Descriptor = { groups: { label: string; fields: Fieldish[] }[] };
type Definitionish = {
  kind: string;
  parametrics?: Descriptor;
  presettable?: boolean;
  defaults: () => Record<string, unknown>;
};

const DEFINITIONS = [
  timelineDefinition,
  cueDefinition,
  shotDefinition,
  pathDefinition,
  cartDefinition
] as unknown as Definitionish[];

describe("every kind has an inspector descriptor whose keys are real fields", () => {
  for (const definition of DEFINITIONS) {
    it(`${definition.kind}: every parametrics key exists in defaults()`, () => {
      expect(definition.parametrics).toBeDefined();
      const fields = definition.parametrics!.groups.flatMap((group) => group.fields);
      expect(fields.length).toBeGreaterThan(0);
      const defaults = definition.defaults();
      for (const field of fields) {
        expect(defaults, `field key "${field.key}" on ${definition.kind}`).toHaveProperty(
          field.key
        );
      }
    });

    it(`${definition.kind}: opts out of presets — parametrics would otherwise opt it in`, () => {
      expect(definition.presettable).toBe(false);
    });
  }
});

describe("the shot inspector partitions by camera body", () => {
  const fields = (shotDefinition as unknown as Definitionish).parametrics!.groups.flatMap(
    (group) => group.fields
  );

  it("static fields show for static and hide for orbit; orbit fields the reverse", () => {
    const staticNode = { body: "static" };
    const orbitNode = { body: "orbit" };
    const visible = (node: Record<string, unknown>): string[] =>
      fields.filter((f) => !f.visibleIf || f.visibleIf(node)).map((f) => f.key);

    const forStatic = visible(staticNode);
    const forOrbit = visible(orbitNode);
    expect(forStatic).toContain("position");
    expect(forStatic).toContain("rotationDeg");
    expect(forStatic).not.toContain("radius");
    expect(forOrbit).toContain("radius");
    expect(forOrbit).toContain("targetPoint");
    expect(forOrbit).not.toContain("position");
    // Timing and lens apply to both bodies.
    for (const always of ["timeSeconds", "endSeconds", "body", "fov"]) {
      expect(forStatic).toContain(always);
      expect(forOrbit).toContain(always);
    }
  });

  it("node references are deliberately NOT inspector fields — the panel owns them", () => {
    // There is no free-text field kind and `ref` filters by a single node kind, which none of
    // these references is. Each is a use-the-viewport-selection button in the panel instead.
    const keys = fields.map((f) => f.key);
    expect(keys).not.toContain("targetNodeId");
    expect(keys).not.toContain("aimTargetNodeId");
    expect(keys).not.toContain("cartId");
  });

  it("blendSeconds is legacy and deliberately NOT an inspector field", () => {
    // The blend's duration is the overlap between a shot's block and the previous one's, so it
    // has no field of its own — offering one would be a second source of truth for one number.
    expect(fields.map((f) => f.key)).not.toContain("blendSeconds");
  });

  it("the cart body's own field shows only for a cart shot", () => {
    const visible = (node: Record<string, unknown>): string[] =>
      fields.filter((f) => !f.visibleIf || f.visibleIf(node)).map((f) => f.key);
    expect(visible({ body: "cart" })).toContain("cartOffset");
    expect(visible({ body: "static" })).not.toContain("cartOffset");
  });
});
