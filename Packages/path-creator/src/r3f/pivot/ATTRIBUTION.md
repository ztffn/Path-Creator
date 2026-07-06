# Attribution

The files in this directory are a fork of the `pivotControls` gizmo from
**[@react-three/drei](https://github.com/pmndrs/drei)** (v10.7.7), adapted to run
on three.js's WebGPU node renderer.

The only functional change from the upstream source is replacing drei's fat-line
`<Line>` (three-stdlib `LineMaterial`, WebGL-only — it causes GPU device loss on
the WebGPU node renderer) with `PivotLine` (a thin `THREE.Line` + `LineBasicMaterial`),
and swapping the rotator's invisible fat-line hit proxy for an invisible
`TubeGeometry`. The drag/raycast/matrix/scaling logic is drei's, unchanged.

When drei v11 ships a stable `@react-three/drei/webgpu` build (its `Line` uses
`Line2NodeMaterial` there), this fork should be deleted in favour of it.

## License

drei is MIT licensed:

```
The MIT License (MIT)

Copyright (c) 2020 Poimandres

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
