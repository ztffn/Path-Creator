// PivotLine.tsx
// WebGPU-safe thin line used by the PivotControls fork in place of drei's fat <Line>.
// Scope: builds a real THREE.Line (LineBasicMaterial, ~1px) rendered via <primitive>
// — avoids the WebGL-only three-stdlib LineMaterial (device loss on the node
// renderer) AND the JSX <line>/SVG type collision. Grabbing is done by separate
// invisible mesh proxies, so this line is never raycast. Material is mutated in place
// (no geometry churn on hover); geometry rebuilds only when the points change.
import * as React from 'react'
import * as THREE from 'three'

export type PivotLineProps = {
  points: number[] | THREE.Vector3[]
  color: string | number
  opacity?: number
  transparent?: boolean
  depthTest?: boolean
  renderOrder?: number
  position?: [number, number, number]
  fog?: boolean
  visible?: boolean
  // Accepted for call-site compatibility with drei's <Line>, intentionally unused.
  // polygonOffset in particular must NOT reach the material: WebGPU forbids a depth
  // bias on line topology ("depthBiasSlopeScale must be 0 when using LineStrip").
  lineWidth?: number
  side?: THREE.Side
  polygonOffset?: boolean
  polygonOffsetFactor?: number
  userData?: { [key: string]: any }
  raycast?: THREE.Object3D['raycast'] | (() => null)
}

const toArray = (points: number[] | THREE.Vector3[]): Float32Array => {
  if (points.length === 0) return new Float32Array(0)
  if (points[0] instanceof THREE.Vector3) {
    const vecs = points as THREE.Vector3[]
    const flat = new Float32Array(vecs.length * 3)
    for (let i = 0; i < vecs.length; i++) {
      flat[i * 3 + 0] = vecs[i].x
      flat[i * 3 + 1] = vecs[i].y
      flat[i * 3 + 2] = vecs[i].z
    }
    return flat
  }
  return Float32Array.from(points as number[])
}

export const PivotLine: React.FC<PivotLineProps> = ({
  points,
  color,
  opacity = 1,
  transparent,
  depthTest = true,
  renderOrder,
  position,
  fog,
  visible,
}) => {
  // Rebuild the Line only when `points` change (callers memoize a stable array), so
  // a hover recolor never disposes/recreates the GPU buffer mid-frame.
  const line = React.useMemo(() => {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(toArray(points), 3))
    const material = new THREE.LineBasicMaterial({ toneMapped: false })
    const l = new THREE.Line(geometry, material)
    l.raycast = () => null
    return l
  }, [points])

  React.useEffect(() => {
    const material = line.material as THREE.LineBasicMaterial
    material.color.set(color as THREE.ColorRepresentation)
    material.opacity = opacity
    material.transparent = !!transparent
    material.depthTest = depthTest
    material.fog = fog ?? false
    material.needsUpdate = true
  }, [line, color, opacity, transparent, depthTest, fog])

  React.useEffect(
    () => () => {
      line.geometry.dispose()
      ;(line.material as THREE.Material).dispose()
    },
    [line]
  )

  return (
    <primitive
      object={line}
      {...(position !== undefined && { position })}
      {...(renderOrder !== undefined && { renderOrder })}
      {...(visible !== undefined && { visible })}
    />
  )
}
