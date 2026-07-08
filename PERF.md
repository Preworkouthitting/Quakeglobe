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

## After (commit 9148754) — before/after

Same environment and methodology as the baseline; `all_month` (~10.6k
events) loaded, dpr 1.

| Metric | Baseline | After | Change |
| --- | --- | --- | --- |
| CPU frame submit | 0.40 ms | 0.04 ms | 10× |
| Raw pick (60 rays vs 10.6k instances) | 0.78 ms | 0.09–0.17 ms | ~5–9× |
| all_month load main-thread long tasks | one 67 ms | **none** | worker |
| Draw calls, scene | 47 | **6** | 8× |
| Draw calls, with post chain | 61 | 20 | bloom's ~14 internal passes are fixed cost |
| Allocation rate, rotate idle (12 s) | 9,950 KB/s, 35 GC scavenges | 1,449 KB/s, 6 | ~7× less churn |
| Allocation rate, timeline playback (12 s) | 9,804 KB/s, 23 GC | 1,521 KB/s, 19 GC | ~6× |
| Per-call allocation: `composer.render` / `controls.update` / `markers.update` | — | **0 bytes** | measured over 200–500 calls |
| JS heap after all_month (post-GC floor) | ~75 MB | ~77 MB (JPEG) / ~82 MB (KTX2) | ~flat; +5 MB is transcoded KTX2 block data, offset by 6× less GPU texture memory |
| Texture payload | 2,546 KB (unpkg CDN) | **420 KB** KTX2 / 586 KB JPEG fallback, self-hosted | 6× smaller, GPU-compressed |
| Lighthouse performance (prod preview) | 75 (TBT 1,060 ms) | **84** (TBT 487 ms) | FCP/LCP ~2.1 s unchanged — dominated by the three.js bundle parse; code-splitting was out of scope |

New behavior (no visual change when active):

- Tab hidden → render loop fully stopped. Idle (no input/tween/playback/
  visible pulse ring/shockwave, auto-rotate off) → ~30 fps floor; any
  interaction restores full rate next frame.
- dpr capped at 2, degraded to 1.5 at dpr ≥ 3 or > 2560 px canvases.
- Feed pipeline: worker fetch/parse/math → transferable SoA typed arrays
  feeding the InstancedMesh directly.
- Picking: typed-array bounding-sphere broad phase + three-mesh-bvh
  narrow phase (verified 150/150 identical to stock raycast, both modes).
- Rings/shockwaves/stars each render as ONE instanced/merged draw with
  animation in the vertex shader.

Regression sweep after the pass: picking, tooltips, detail card, scrubber
seek + playback flashes, depth mode round-trip, live diff (toast +
shockwave), deep-link writes, historical form defaults, stats charts —
all pass. Prod bundle contains no FPS meter, no `__quake` dev handle, no
encoder code (verified by grep).

Repro notes: FPS meter (dev only) shows real post-limiter render rate;
`scripts/encode-ktx2.js` regenerates the KTX2 textures from the dev page
console. Lighthouse runs against `vite preview` on the built dist.
