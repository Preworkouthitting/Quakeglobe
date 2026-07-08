// Dev-only KTX2 (Basis ETC1S) encoder for the earth textures.
// Not part of the app bundle — run it from the dev-server page console:
//
//   const m = await import('/scripts/encode-ktx2.js'); await m.encodeAll();
//
// Inputs:  public/textures/tmp/flip-*.png  (2048px max, pre-flipped
//          vertically because KTX2 textures can't flipY at load time)
// Outputs: public/textures/*.ktx2 via the dev server's /__snapshot
//          middleware. Delete tmp/ afterwards.
//
// Drives BasisEncoder directly instead of @loaders.gl/core's encode():
// the wrapper returns `subarray(...).buffer`, i.e. the whole 8 MB backing
// allocation instead of the encoded bytes, and it hardcodes the KTX2 sRGB
// transfer flag (wrong for the linear water mask). The encoder wasm ships
// inside @loaders.gl/textures — loaded here without loaders.gl's brittle
// script-injection path.
const LIBS = '/node_modules/@loaders.gl/textures/dist/libs/';

async function loadBasisEncoderModule() {
  const src = await (await fetch(LIBS + 'basis_encoder.js')).text();
  (0, eval)(src); // Emscripten UMD → defines globalThis.BASIS factory
  const wasmBinary = await (await fetch(LIBS + 'basis_encoder.wasm')).arrayBuffer();
  const module = await globalThis.BASIS({ wasmBinary });
  module.initializeBasis();
  return module;
}

async function loadRGBA(url) {
  const bmp = await createImageBitmap(await (await fetch(url)).blob());
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  const d = ctx.getImageData(0, 0, bmp.width, bmp.height);
  return { data: new Uint8Array(d.data.buffer), width: d.width, height: d.height };
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export async function encodeAll() {
  const { BasisEncoder } = await loadBasisEncoderModule();
  const jobs = [
    { src: '/textures/tmp/flip-day.png', out: 'earth-day', srgb: true },
    { src: '/textures/tmp/flip-night.png', out: 'earth-night', srgb: true },
    { src: '/textures/tmp/flip-water.png', out: 'earth-water', srgb: false }, // data mask
  ];
  const results = {};
  for (const job of jobs) {
    const image = await loadRGBA(job.src);
    const enc = new BasisEncoder();
    let ktx2;
    try {
      const out = new Uint8Array(image.width * image.height * 4);
      enc.setCreateKTX2File(true);
      enc.setKTX2UASTCSupercompression(true);
      enc.setKTX2SRGBTransferFunc(job.srgb);
      enc.setSliceSourceImage(0, image.data, image.width, image.height, false);
      enc.setPerceptual(job.srgb);
      enc.setMipSRGB(job.srgb);
      enc.setQualityLevel(160);
      enc.setUASTC(false); // ETC1S: much smaller, plenty for a globe
      enc.setMipGen(false);
      const n = enc.encode(out);
      if (!n) throw new Error('encode failed for ' + job.src);
      ktx2 = out.slice(0, n); // copy just the encoded bytes
    } finally {
      enc.delete();
    }
    await fetch(`/__snapshot?name=${job.out}&ext=ktx2&dir=textures`, {
      method: 'POST',
      body: 'data:application/octet-stream;base64,' + toBase64(ktx2),
    });
    results[job.out] = Math.round(ktx2.length / 1024) + ' KB';
  }
  return results;
}
