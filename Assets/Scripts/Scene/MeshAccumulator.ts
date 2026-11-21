import type {Vec3} from "../Core/CircleCheckCore"

export type P3 = Vec3 | vec3

// Accumulates position-only triangle geometry; every visual in the scene is built once at boot from it.
export class MeshAccumulator {
  private positions: number[] = []
  private indices: number[] = []

  get vertexCount(): number {
    return this.positions.length / 3
  }

  private vertex(p: P3): number {
    this.positions.push(p.x, p.y, p.z)
    return this.vertexCount - 1
  }

  quad(a: P3, b: P3, c: P3, d: P3): void {
    const i0 = this.vertex(a)
    const i1 = this.vertex(b)
    const i2 = this.vertex(c)
    const i3 = this.vertex(d)
    this.indices.push(i0, i1, i2, i0, i2, i3)
  }

  // Square tube along a→b; used for every luminous edge so wireframes stay visible on an additive display.
  segment(a: P3, b: P3, thickness: number): void {
    const va = new vec3(a.x, a.y, a.z)
    const vb = new vec3(b.x, b.y, b.z)
    const dir = vb.sub(va)
    if (dir.length < 1e-4) {
      return
    }
    const n = dir.normalize()
    const ref = Math.abs(n.y) > 0.9 ? vec3.right() : vec3.up()
    const u = n.cross(ref).normalize().uniformScale(thickness / 2)
    const v = n.cross(u).normalize().uniformScale(thickness / 2)
    const corners = [u.add(v), u.sub(v), u.uniformScale(-1).sub(v), u.uniformScale(-1).add(v)]
    for (let i = 0; i < 4; i++) {
      const c0 = corners[i]
      const c1 = corners[(i + 1) % 4]
      this.quad(va.add(c0), vb.add(c0), vb.add(c1), va.add(c1))
    }
  }

  box(min: P3, max: P3): void {
    const x0 = min.x
    const y0 = min.y
    const z0 = min.z
    const x1 = max.x
    const y1 = max.y
    const z1 = max.z
    const p = (x: number, y: number, z: number): vec3 => new vec3(x, y, z)
    this.quad(p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1))
    this.quad(p(x1, y0, z0), p(x0, y0, z0), p(x0, y1, z0), p(x1, y1, z0))
    this.quad(p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1), p(x0, y1, z0))
    this.quad(p(x1, y0, z1), p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1))
    this.quad(p(x0, y1, z1), p(x1, y1, z1), p(x1, y1, z0), p(x0, y1, z0))
    this.quad(p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1))
  }

  ringXZ(center: P3, radius: number, y: number, segments: number, thickness: number): void {
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2
      const a1 = ((i + 1) / segments) * Math.PI * 2
      this.segment(
        new vec3(center.x + Math.cos(a0) * radius, y, center.z + Math.sin(a0) * radius),
        new vec3(center.x + Math.cos(a1) * radius, y, center.z + Math.sin(a1) * radius),
        thickness,
      )
    }
  }

  // Wheel ring in the YZ plane (axle along X) at the given hub.
  ringYZ(hub: P3, radius: number, segments: number, thickness: number): void {
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2
      const a1 = ((i + 1) / segments) * Math.PI * 2
      this.segment(
        new vec3(hub.x, hub.y + Math.cos(a0) * radius, hub.z + Math.sin(a0) * radius),
        new vec3(hub.x, hub.y + Math.cos(a1) * radius, hub.z + Math.sin(a1) * radius),
        thickness,
      )
    }
  }

  build(): RenderMesh {
    const builder = new MeshBuilder([{name: "position", components: 3}])
    builder.topology = MeshTopology.Triangles
    builder.indexType = MeshIndexType.UInt16
    builder.appendVerticesInterleaved(this.positions)
    builder.appendIndices(this.indices)
    builder.updateMesh()
    return builder.getMesh()
  }
}
