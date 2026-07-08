# Performance notes

Measurement environment: Windows 11, Chrome (Claude preview panel), dpr 1,
canvas 1340px wide, `all_month` feed (~10.6k events), auto-rotate on.

**Caveat:** the measurement browser window is occluded/unfocused, so Chrome
throttles requestAnimationFrame to ~30 fps regardless of app cost. rAF-FPS
is therefore not a usable signal here; CPU frame-submit time (avg of 60
`composer.render()` calls) and raw operation timings are used instead.
The dev-only FPS meter (bottom-right, `import.meta.env.DEV` only) stands in
for stats.js — same measurement, no extra dependency.

## Baseline (commit 438a936)

| Metric | Value |
| --- | --- |
| CPU frame submit (all_month, rotating) | 0.40 ms |
| Raw pick (raycast vs 10,620 instances, avg 60 rays) | 0.78 ms |
| all_month load, total | ~254 ms (cold cache: one 67 ms main-thread long task for fetch+parse+build) |
| Draw calls, scene only | **47** (~38 are individual pulse-ring meshes) |
| Draw calls, with post chain | 61 |
| Triangles | 146k |
| JS heap after all_month | 75 MB |
| Textures (unpkg CDN) | day 1428 KB + night 698 KB + water 420 KB = **2546 KB** |
| Lighthouse performance (prod preview) | **75** — FCP 2.0 s, LCP 2.0 s, TBT 1060 ms, SI 2.0 s |

Known hot spots identified for the pass:

1. Render loop runs at full rate even when idle or hidden.
2. Pixel ratio uncapped beyond 2 / no high-dpr degradation.
3. Feed fetch + JSON parse + per-quake math on the main thread (67 ms task).
4. `InstancedMesh.raycast` iterates all 10.6k instances per hover.
5. 2.5 MB of textures from a third-party CDN, no GPU-compressed variant.
6. One draw call per pulse ring (scene calls scale with recent-quake count).
7. `normal.clone()` allocations in `writeMatrix` (runs 10.6k× per visibility
   pass, every frame during timeline playback); per-event object literals in
   pointermove.
